// AI Call Coach tools for the claude-connector MCP server. The practice prospect itself runs on the coach worker (the
// same judged persona prompt the CRM page uses), so the person's Claude only relays lines and reads coaching back.
// Every call is scoped to the connector token's profile through the service-role _ai_* RPCs.
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type J = Record<string, unknown>;
export class CoachError extends Error {}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (properties: J, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const S = (description: string) => ({ type: "string", description });
const TRACK = { type: "string", enum: ["data", "ma"], description: "data = Working Signal data sales, ma = Waystation M&A. Default: the track of your latest calls" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const COACH_INSTRUCTIONS =
  " Call coaching: get_my_coaching shows the person's current coach advice, stage and recent call feedback. " +
  "For a practice call use start_practice_call, then practice_say for each line the person says, then end_practice_call. " +
  "During a practice call you are only the phone line: show the prospect's words exactly as returned, never coach, " +
  "hint or speak for the prospect, and never add lines the person did not say. Coach only after the call ends.";

export const COACH_TOOLS = [
  { name: "get_my_coaching", description: "Your coach: current stage (opener, objections, full), the advice the coach wrote from your last real calls (it updates every 10 conversations), your weakest objections and your latest call scores.",
    inputSchema: obj({ track: TRACK }) },
  { name: "get_call_feedback", description: "Feedback on your recent real calls (scores, what worked, what to fix, a line to try). Optional call_id for one call.",
    inputSchema: obj({ track: TRACK, call_id: S("A call id from get_my_coaching"), limit: { type: "integer", minimum: 1, maximum: 15 } }) },
  { name: "start_practice_call", description: "Starts a practice cold call with an AI owner built from a real call. The owner's difficulty follows your stage: openers get brush-offs until your first three lines work, then objections you struggle with, then full calls. Returns the owner's first words.",
    inputSchema: obj({ track: TRACK, stage: { type: "string", enum: ["opener", "objections", "full"], description: "Override the stage (default: the coach's stage for you)" } }) },
  { name: "practice_say", description: "Says one line to the practice owner and waits for the reply (a few seconds). Pass exactly what the person said.",
    inputSchema: obj({ session_id: S("From start_practice_call"), text: S("What the person said, word for word") }, ["session_id", "text"]) },
  { name: "get_practice_reply", description: "Fetches the owner's latest reply if practice_say timed out while waiting.",
    inputSchema: obj({ session_id: S("From start_practice_call") }, ["session_id"]) },
  { name: "end_practice_call", description: "Hangs up and scores the practice call: did the opener pass, how objections went, a score and feedback.",
    inputSchema: obj({ session_id: S("From start_practice_call") }, ["session_id"]) },
  { name: "read_coach_doc", description: "Reads a coaching document: guide (how the coach works), calls_playbook (what works on real calls, weighted toward calls that got interest), router (research summary), or a research_* file the router names.",
    inputSchema: obj({ track: TRACK, slug: S("guide, calls_playbook, router, or a research_ slug") }, ["slug"]) },
];
export const COACH_TOOL_NAMES = new Set(COACH_TOOLS.map((t) => t.name));

export const COACH_PROMPTS = [
  { name: "practice_call", description: "Run a practice cold call with an AI owner, then go over it.", arguments: [{ name: "track", description: "data or ma (optional)", required: false }] },
  { name: "coach_me", description: "Go over your coach's advice and recent call feedback, and drill one thing.", arguments: [{ name: "track", description: "data or ma (optional)", required: false }] },
];

async function rpc(admin: SupabaseClient, fn: string, args: J) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    const m = error.message || "";
    if (/not active|hung up|still answering|say something|not found|no practice prospects|track must be|bad stage/i.test(m)) throw new CoachError(m);
    throw new Error(m);
  }
  return data;
}
const track = (v: unknown) => {
  if (v === undefined || v === null || v === "") return null;
  if (v !== "data" && v !== "ma") throw new CoachError('track must be "data" or "ma"');
  return v;
};
const sid = (v: unknown) => {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new CoachError("session_id must be the id start_practice_call returned");
  return v;
};

function slimFeedback(f: J) {
  const a = (f.analysis || {}) as J;
  return { call_id: f.call_id, when: f.created_at, company: f.company_name, seconds: f.duration_sec,
    scores: { opener: f.opener_score, objections: f.objection_score, overall: f.overall_score },
    feedback: f.feedback, first_reaction: a.first_reaction, objections: a.objections, worked: a.worked, failed: a.failed };
}

async function waitSession(admin: SupabaseClient, profile: string, id: string, maxMs: number) {
  const t0 = Date.now();
  let g: J | null = null;
  while (Date.now() - t0 < maxMs) {
    g = (await rpc(admin, "_ai_practice_get", { p_user: profile, p_session: id })) as J | null;
    if (!g) throw new CoachError("Practice call not found.");
    if (!g.pending) return g;
    await sleep(1200);
  }
  return g;
}

export async function callCoachTool(admin: SupabaseClient, profile: string, name: string, a: J): Promise<unknown> {
  switch (name) {
    case "get_my_coaching": {
      const o = (await rpc(admin, "_ai_overview", { p_user: profile, p_track: track(a.track) })) as J;
      const s = (o.state || {}) as J;
      return { track: o.track, stage: s.stage, coach_advice: s.advice, weakest_objections: s.objection_focus,
        conversations_graded: s.conv_count, next_coach_update_in: Math.max(0, 10 - (Number(s.conv_count || 0) - Number(s.convos_at_advice || 0))),
        coach_updated: s.advice_at, worker_online: o.worker_online,
        recent_calls: ((o.feedback || []) as J[]).slice(0, 5).map(slimFeedback),
        practice: ((o.practice || []) as J[]).slice(0, 5).map((p) => ({ stage: p.stage, status: p.status, when: p.created_at, result: p.result })) };
    }
    case "get_call_feedback": {
      const o = (await rpc(admin, "_ai_overview", { p_user: profile, p_track: track(a.track) })) as J;
      let fb = ((o.feedback || []) as J[]).map(slimFeedback);
      if (a.call_id) fb = fb.filter((f) => f.call_id === a.call_id);
      return fb.slice(0, Math.min(Number(a.limit || 5) || 5, 15));
    }
    case "start_practice_call": {
      const st = a.stage;
      if (st !== undefined && !["opener", "objections", "full"].includes(st as string)) throw new CoachError("stage must be opener, objections or full");
      const t = track(a.track) || ((await rpc(admin, "_ai_default_track", { p_user: profile })) as string);
      const r = (await rpc(admin, "_ai_practice_start", { p_user: profile, p_track: t, p_stage: st ?? null, p_channel: "connector" })) as J;
      return { session_id: r.session_id, stage: r.stage, track: r.track, prospect: r.prospect, owner_says: r.opening,
        how_to_run_it: "Show the owner's words, then ask the person what they say. Pass it to practice_say word for word. Do not coach until end_practice_call." };
    }
    case "practice_say": case "get_practice_reply": {
      const id = sid(a.session_id);
      if (name === "practice_say") {
        const text = typeof a.text === "string" ? a.text.slice(0, 2000) : "";
        if (!text.trim()) throw new CoachError("text is required: what the person said");
        await rpc(admin, "_ai_practice_say", { p_user: profile, p_session: id, p_text: text });
      }
      const g = await waitSession(admin, profile, id, 45000);
      const ses = (g?.session || {}) as J;
      const turns = (ses.turns || []) as J[];
      const last = turns[turns.length - 1] || {};
      if (g?.pending) return { waiting: true, message: "The owner is still answering. Wait a few seconds, then call get_practice_reply with this session_id." };
      if (g?.error && last.role !== "prospect") return { error: "The practice owner could not answer. Try once more, or end the call." };
      return { owner_says: last.role === "prospect" ? last.text : null, owner_hung_up: !!ses.hung_up,
        next: ses.hung_up ? "The owner hung up. Call end_practice_call to get the score." : "Ask the person what they say next." };
    }
    case "end_practice_call": {
      const id = sid(a.session_id);
      await rpc(admin, "_ai_practice_end", { p_user: profile, p_session: id, p_turns: null });
      const g = await waitSession(admin, profile, id, 60000);
      const ses = (g?.session || {}) as J;
      if (!ses.result) return { status: ses.status || "scoring", message: "Scoring is still running. Call get_my_coaching in a minute to see it." };
      return { status: ses.status, result: ses.result };
    }
    case "read_coach_doc": {
      const slug = typeof a.slug === "string" ? a.slug.trim() : "";
      if (!/^(guide|calls_playbook|router|research_[a-z0-9_]+|[a-z0-9_]+_deep)$/i.test(slug)) throw new CoachError("slug must be guide, calls_playbook, router or a research_ slug the router names");
      const t = track(a.track) || ((await rpc(admin, "_ai_default_track", { p_user: profile })) as string);
      const { data, error } = await admin.from("ai_kb_docs").select("track, slug, title, body, version, updated_at")
        .in("track", [t, "shared"]).eq("slug", slug).neq("kind", "prompt").order("track", { ascending: true }).limit(2);
      if (error) throw new Error(error.message);
      const d = (data || []).find((x) => x.track === t) || (data || [])[0];
      if (!d) throw new CoachError(`No document "${slug}" for ${t}.`);
      return d;
    }
  }
  throw new CoachError(`Unknown tool: ${name}`);
}

export function getCoachPrompt(name: string, a: J) {
  const t = a.track === "data" || a.track === "ma" ? ` (track ${a.track})` : "";
  const user = (text: string, description: string) => ({ description, messages: [{ role: "user", content: { type: "text", text } }] });
  if (name === "practice_call") return user(`Run a practice cold call for me${t}.
1. Call get_my_coaching first and tell me in one line what stage I'm on and the one thing my coach wants me to work on.
2. Call start_practice_call${t ? ` with track ${a.track}` : ""}. Show me who I'm calling (name, company) and what they said when they picked up.
3. Then ask me what I say. Pass my exact words to practice_say and show me only the owner's reply. Repeat. You are only the phone line: never coach me, hint, or speak for me during the call. If I type "end" or the owner hangs up, call end_practice_call.
4. After the score comes back, tell me what worked, the one thing to fix, and the exact line to try next time. Offer to run another call.`, "Practice call");
  if (name === "coach_me") return user(`Coach me on my cold calls${t}.
1. Call get_my_coaching and get_call_feedback. Read the calls_playbook with read_coach_doc.
2. Tell me plainly: what I'm doing well, the single biggest thing costing me calls (with a quote from my own call), and the exact words to say instead. Base it on my calls and the playbook, not general sales advice.
3. Drill it: give me the situation, let me answer, and grade each try until I get it right twice in a row. Then offer a practice call.`, "Coach me");
  throw new CoachError(`Unknown prompt: ${name}`);
}
