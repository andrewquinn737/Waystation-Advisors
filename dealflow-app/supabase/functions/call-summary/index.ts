// call-summary — after a transcribed call ends, summarizes its transcript and stores it on calls.summary.
// That is the "Transcript" box under a dial's notes. Called by the app right after hangup, and by a
// minute-by-minute database job (x-internal-key) that catches any call whose summary didn't land.
//
// Each call (mobile number vs company line) is summarized separately and keeps its own summary.
// Summarizer: if an ANTHROPIC_API_KEY exists (app_secrets row or function secret) Claude writes the summary
// with full context about who is calling and why; otherwise Deepgram's plain text summarization is used
// (it can't be told who is who, so it mislabels roles more often).
//
// Request: { call_id, regenerate? }   Response: { summary } | { skipped: reason } | { error }
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const CLAUDE_MODEL = "claude-haiku-5-5";
const SYSTEM = `You write short call notes for Waystation Advisors, an M&A advisory firm. The "Caller" is a Waystation representative cold-calling a business on behalf of a CLIENT who may want to BUY that business (or, for some lists, a business owner who may want to sell). The Caller is never the client and never asks for a bid; they are representing a client who could make an offer. "Other side" is whoever answered the phone: it may be the business owner, a receptionist/assistant/gatekeeper, a coworker or family member, or an automated voicemail/phone-menu system. Work out which from what is said (e.g. "leave a message after the tone", "thanks for calling X, press 1" = automated system; someone screening or taking a message = gatekeeper; someone speaking for their own business = likely the owner). The message names which number was dialed: the company's main line usually reaches a receptionist or phone menu, an owner's mobile usually reaches the owner or their voicemail — but trust what is actually said over that guess. Never call a voicemail system or a receptionist "the owner".

Write 2-4 plain sentences: who was reached (owner / gatekeeper / voicemail, with names if given), what the Caller said or asked, how the other side responded, and any concrete next step (callback time, who to ask for, email requested). Use only what is in the transcript — do not guess, and do not add advice. If the transcript is too garbled to tell, say so briefly. Output only the notes, no preface.`;

async function claudeSummary(key: string, text: string, ctx: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 400, system: SYSTEM,
      messages: [{ role: "user", content: `${ctx}\n\nTranscript:\n${text}` }],
    }),
  });
  if (!r.ok) throw new Error(`Claude summary failed (${r.status}) ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = await r.json();
  return String(j?.content?.[0]?.text || "").trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: ik } = await admin.from("app_secrets").select("value").eq("key", "CALL_SUMMARY_INTERNAL_KEY").maybeSingle();
    const internal = !!ik?.value && req.headers.get("x-internal-key") === ik.value;
    let uid = "";
    if (!internal) {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      const { data: u, error: ue } = await admin.auth.getUser(jwt);
      if (ue || !u?.user) { console.error("auth failed", ue?.message); return json({ error: "Your session isn't valid — please sign in again." }, 401); }
      uid = u.user.id;
    }

    let body: { call_id?: string; regenerate?: boolean };
    try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
    if (!body.call_id) return json({ error: "call_id is required." }, 400);

    const { data: call } = await admin.from("calls").select("id, user_id, transcribed, skip_reason, summary, company_name, owner_name, industry, dial_method").eq("id", body.call_id).maybeSingle();
    if (!call) return json({ error: "Call not found." }, 404);
    if (!internal) {
      const { data: caller } = await admin.from("profiles").select("role, team_id").eq("id", uid).single();
      const { data: owner } = await admin.from("profiles").select("team_id").eq("id", call.user_id).maybeSingle();
      const allowed = call.user_id === uid || caller?.role === "admin" || (caller?.role === "team_lead" && !!caller.team_id && owner?.team_id === caller.team_id);
      if (!allowed) return json({ error: "You don't have access to this call." }, 403);
    }
    if (!call.transcribed || call.skip_reason) return json({ skipped: "not_transcribed" });
    if (call.summary && !(body.regenerate && internal)) return json({ summary: call.summary });

    const { data: lines, error: le } = await admin.from("call_lines").select("speaker, text").eq("call_id", call.id).order("start_ms");
    if (le) { console.error("lines error", le.message); return json({ error: "Couldn't read the transcript: " + le.message }, 500); }
    if (!lines || lines.length < 4) return json({ skipped: "too_short", lines: lines?.length ?? 0 });
    const label = (sp: string) => (sp === "intern" ? "Caller" : "Other side");
    const text = lines.map((l: { speaker: string; text: string }) => `${label(l.speaker)}: ${l.text}`).join("\n").slice(0, 60000);

    let summary = "";
    const { data: ak } = await admin.from("app_secrets").select("value").eq("key", "ANTHROPIC_API_KEY").maybeSingle();
    const claudeKey = (ak?.value || Deno.env.get("ANTHROPIC_API_KEY") || "").trim();
    if (claudeKey) {
      try {
        const dialed = call.dial_method === "company" ? "the company's main line" : call.dial_method === "mobile" ? "the contact's mobile number" : "a phone number";
        const ctx = `The call was placed to: ${[call.owner_name, call.company_name].filter(Boolean).join(" at ") || "an unknown business"}${call.industry ? ` (${call.industry})` : ""}, dialing ${dialed}. That is who the Caller was trying to reach — not necessarily who answered.`;
        summary = await claudeSummary(claudeKey, text, ctx);
      } catch (e) { console.error("claude", String(e)); }
    }
    if (!summary) {
      const { data: s } = await admin.from("app_secrets").select("value").eq("key", "DEEPGRAM_API_KEY").maybeSingle();
      const key = (s?.value || "").trim();
      if (!key) return json({ error: "Summaries aren't configured yet." }, 500);
      const r = await fetch("https://api.deepgram.com/v1/read?language=en&summarize=true", {
        method: "POST",
        headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) { const t = await r.text().catch(() => ""); console.error("deepgram", r.status, t.slice(0, 300)); return json({ error: `Deepgram summary failed (${r.status}).`, detail: t.slice(0, 300) }, 502); }
      summary = String((await r.json())?.results?.summary?.text || "").trim();
    }
    if (!summary) return json({ skipped: "empty_summary" });
    const { error: upErr } = await admin.from("calls").update({ summary, summary_at: new Date().toISOString() }).eq("id", call.id);
    if (upErr) console.error("summary save failed", upErr.message);
    return json({ summary });
  } catch (e) {
    console.error("unexpected", String(e));
    return json({ error: "Unexpected error: " + String(e) }, 500);
  }
});
