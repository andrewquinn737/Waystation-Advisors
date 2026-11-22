// telnyx-token — called by the PWA before every in-app call.
// Decides (server side, from the area-code / state tables) whether the call is placed in the app
// and whether it may be transcribed, picks the caller-ID number, and mints a short-lived Telnyx
// WebRTC login token for this user. The Telnyx API key never leaves this function.
//
// Request:  { to_number, owner_state? }
// Response: { decision: 'record'|'no_record'|'native', reason, state, login_token?, from_number?, caller_id_name? }
//   decision 'native' => the app must use the phone's own dialer (state unknown even after the area code).
import { createClient } from "npm:@supabase/supabase-js@2";
import { callAllowed, TEST_CALL_MSG } from "../_shared/testCallLock.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const TELNYX = "https://api.telnyx.com/v2";

function e164(raw: string): string | null {
  const d = String(raw || "").replace(/\D/g, "");
  if (/^[2-9]\d{9}$/.test(d)) return "+1" + d;
  if (/^1[2-9]\d{9}$/.test(d)) return "+" + d;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const { data: u, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !u?.user) return json({ error: "Your session isn't valid — please sign in again." }, 401);
    const userId = u.user.id;

    let body: { to_number?: string; owner_state?: string };
    try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
    const to = e164(body.to_number || "");
    if (!to) return json({ error: "That phone number isn't a valid US number." }, 400);

    if (!callAllowed(to)) return json({ error: TEST_CALL_MSG, code: "test_call_blocked" }, 403);

    const { data: consent, error: ce } = await admin.rpc("call_consent", { p_to: to, p_state: body.owner_state || null });
    if (ce) return json({ error: ce.message }, 500);
    if (consent.decision === "native") return json({ ...consent, to_number: to });

    const { data: picks, error: pe } = await admin.rpc("pick_from_number", { p_to: to, p_state: body.owner_state || null });
    if (pe || !picks?.length) return json({ error: pe?.message || "No caller-ID number is available." }, 500);

    const { data: secrets } = await admin.from("app_secrets").select("key, value").in("key", ["TELNYX_API_KEY", "TELNYX_SIP_CONNECTION_ID"]);
    const sec = (k: string) => ((secrets || []).find((r: { key: string; value: string }) => r.key === k)?.value || "").trim();
    const apiKey = sec("TELNYX_API_KEY"), connId = sec("TELNYX_SIP_CONNECTION_ID");
    if (!apiKey || !connId) return json({ error: "Calling isn't configured yet." }, 500);
    const H = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

    async function createCredential(): Promise<string> {
      const r = await fetch(`${TELNYX}/telephony_credentials`, { method: "POST", headers: H, body: JSON.stringify({ connection_id: connId, name: `waystation-${userId}` }) });
      if (!r.ok) throw new Error(`Telnyx credential create failed (${r.status})`);
      const id = (await r.json()).data.id as string;
      await admin.from("telnyx_credentials").upsert({ user_id: userId, credential_id: id });
      return id;
    }
    let { data: cred } = await admin.from("telnyx_credentials").select("credential_id").eq("user_id", userId).maybeSingle();
    let credId = cred?.credential_id || (await createCredential());
    let tr = await fetch(`${TELNYX}/telephony_credentials/${credId}/token`, { method: "POST", headers: H });
    if (tr.status === 404) { // credential was deleted in Telnyx — make a new one once
      credId = await createCredential();
      tr = await fetch(`${TELNYX}/telephony_credentials/${credId}/token`, { method: "POST", headers: H });
    }
    if (!tr.ok) return json({ error: `Telnyx token request failed (${tr.status})` }, 502);
    const login_token = (await tr.text()).trim();

    return json({ ...consent, to_number: to, login_token, from_number: picks[0].e164, caller_id_name: picks[0].caller_id_name || "Waystation Adv" });
  } catch (e) {
    return json({ error: "Unexpected error: " + String(e) }, 500);
  }
});
