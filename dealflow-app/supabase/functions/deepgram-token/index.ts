// deepgram-token — mints a short-lived Deepgram token for ONE call, and only if the database
// says that call may be transcribed (transcribed = true, no skip_reason, still running, owned by
// the caller). So even a modified browser can't start transcription on a no-record call.
//
// Request: { call_id }   Response: { token, expires_in }
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json({ error: "Your session isn't valid — please sign in again." }, 401);

    let body: { call_id?: string };
    try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
    if (!body.call_id) return json({ error: "call_id is required." }, 400);

    const { data: call } = await admin.from("calls").select("user_id, transcribed, skip_reason, ended_at, started_at").eq("id", body.call_id).maybeSingle();
    if (!call || call.user_id !== u.user.id) return json({ error: "Call not found." }, 404);
    if (!call.transcribed || call.skip_reason) return json({ error: "This call may not be transcribed." }, 403);
    if (call.ended_at || Date.now() - new Date(call.started_at).getTime() > 4 * 3600 * 1000) return json({ error: "This call is over." }, 403);

    const { data: s } = await admin.from("app_secrets").select("value").eq("key", "DEEPGRAM_API_KEY").maybeSingle();
    const key = (s?.value || "").trim();
    if (!key) return json({ error: "Transcription isn't configured yet." }, 500);

    const r = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 60 }),
    });
    if (!r.ok) return json({ error: `Deepgram token request failed (${r.status}). The key may need Member/Admin permission.` }, 502);
    const g = await r.json();
    return json({ token: g.access_token, expires_in: g.expires_in });
  } catch (e) {
    return json({ error: "Unexpected error: " + String(e) }, 500);
  }
});
