// start-emails: the "Start sending" button. Signed-in user (must manage the list).
// 1. take the next N ready leads (copy gate passed) in list order,
// 2. verify each address with MillionVerifier (30-day cache, <=5 in parallel) BEFORE anything is marked active,
// 3. call SQL start_emails() as the user with exactly those ids: ok -> active; catch_all/unknown/invalid/
//    disposable/error -> backup number. A transient API failure (network, out of credits) leaves the lead
//    ready and unverified; it is neither started nor moved to backup, and is reported as `unverified`.
// If some of the first N fail verification, the next ready leads are verified until N are ok or none remain.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { verifyEmails } from "../verify-email/index.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const MAX_ROUNDS = 30;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "Missing authorization." }, 401);
  const { data: u, error: ue } = await admin.auth.getUser(jwt);
  if (ue || !u?.user) return json({ error: "Your session isn't valid. Please sign in again." }, 401);
  let body: { list_id?: string; count?: number | null };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  if (!body.list_id || !/^[0-9a-f-]{36}$/i.test(body.list_id)) return json({ error: "list_id is required." }, 400);
  const want = body.count == null ? null : Math.floor(Number(body.count));
  if (want !== null && (!(want >= 1) || want > 5000)) return json({ error: "count must be a whole number from 1 to 5000, or empty for all." }, 400);
  const { data: can } = await admin.rpc("can_manage_list", { p_user: u.user.id, p_list_id: body.list_id });
  if (!can) return json({ error: "You don't have access to that list." }, 403);

  try {
    const examined: string[] = [];
    const unverifiedIds: string[] = [];
    let okCount = 0, unverified = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const need = want === null ? null : want - okCount;
      if (need !== null && need <= 0) break;
      const { data: cands, error } = await admin.rpc("start_candidates", { p_list_id: body.list_id, p_limit: need ?? 5000, p_skip: [...examined, ...unverifiedIds] });
      if (error) throw new Error(error.message);
      const rows = (cands || []) as { id: string; email: string; mv_result: string | null; mv_checked_at: string | null }[];
      if (!rows.length) break;
      const fresh = (r: typeof rows[0]) => r.mv_result && r.mv_checked_at && Date.parse(r.mv_checked_at) > Date.now() - 30 * 864e5;
      const verdicts = new Map((await verifyEmails(admin, rows.filter((r) => !fresh(r)).map((r) => r.email))).map((v) => [v.email, v]));
      for (const r of rows) {
        let result = r.mv_result;
        if (!fresh(r)) {
          const v = verdicts.get(r.email.trim().toLowerCase());
          if (!v || v.transient) { unverified++; unverifiedIds.push(r.id); continue; }
          result = v.result;
          await admin.from("dials").update({ mv_result: result, mv_checked_at: new Date().toISOString() }).eq("id", r.id);
        }
        examined.push(r.id);
        if (result === "ok") okCount++;
      }
    }
    // final step as the user, so SQL re-checks access and records who started it
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: "Bearer " + jwt } } });
    const { data, error } = await userClient.rpc("start_emails", { p_list_id: body.list_id, p_count: null, p_dial_ids: examined });
    if (error) return json({ error: error.message }, 400);
    return json({ ...data, unverified });
  } catch (e) {
    return json({ error: "Start failed: " + String((e as Error).message || e) }, 500);
  }
});
