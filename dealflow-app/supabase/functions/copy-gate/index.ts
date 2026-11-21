// copy-gate: the server-side copy check. Runs the SAME rules file as the review screen
// (_shared/copyLint.js is a byte-for-byte copy of js/copyLint.js; tools/testenv/check_shared.sh
// fails if they differ) over a whole list, and records pass/fail per lead against the exact text
// it checked. Nothing can send unless this function passed the current text.
// Auth: a signed-in user who owns the list (or is its owner's team lead, or admin).
// Also importable by other functions: checkList(admin, listId).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { lintBatch } from "../_shared/copyLint.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

export async function checkList(admin: SupabaseClient, listId: string) {
  const { data: rows, error } = await admin.rpc("copy_gate_rows", { p_list_id: listId });
  if (error) throw new Error(error.message);
  const leads = (rows || []) as Record<string, string>[];
  const res = lintBatch(leads.map((r) => ({ id: r.id, full_name: r.full_name, company_name: r.company_name,
    email_subject: r.email_subject, email_1: r.email_1, email_2: r.email_2 })));
  const results = leads.map((r) => {
    const x = res.get(r.id) || { errors: [], warnings: [] };
    return { id: r.id, ok: x.errors.length === 0, errors: x.errors, warnings: x.warnings, hash: r.hash };
  });
  const { data: rec, error: e2 } = await admin.rpc("copy_gate_record", { p_list_id: listId, p_results: results });
  if (e2) throw new Error(e2.message);
  return { summary: rec, results: results.map(({ hash: _h, ...r }) => r) };
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return json({ error: "Missing authorization." }, 401);
  const { data: u, error: ue } = await admin.auth.getUser(jwt);
  if (ue || !u?.user) return json({ error: "Your session isn't valid. Please sign in again." }, 401);
  let body: { list_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  if (!body.list_id || !/^[0-9a-f-]{36}$/i.test(body.list_id)) return json({ error: "list_id is required." }, 400);
  const { data: can } = await admin.rpc("can_manage_list", { p_user: u.user.id, p_list_id: body.list_id });
  if (!can) return json({ error: "You don't have access to that list." }, 403);
  try {
    return json(await checkList(admin, body.list_id));
  } catch (e) {
    return json({ error: "Check failed: " + String((e as Error).message || e) }, 500);
  }
});
