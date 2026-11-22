// copy-gate: the server-side copy check. Runs the SAME rules file as the review screen
// (_shared/copyLint.js is a byte-for-byte copy of js/copyLint.js; tools/testenv/check_shared.sh
// fails if they differ) over a whole list, and records pass/fail per lead against the exact text
// it checked. Nothing can send unless this function passed the current text.
// Auth: a signed-in user who owns the list (or is its owner's team lead, or admin).
// Also importable by other functions: checkList(admin, listId).
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { lintBatch } from "../_shared/copyLint.js";
import { leadTexts, uniquenessErrors } from "../_shared/sentenceIndex.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

export async function checkList(admin: SupabaseClient, listId: string) {
  // The API returns at most 1,000 rows per request, so read the list page by page (a 2,000-lead list was only
  // half checked before, and the unchecked half could never pass the gate).
  const leads: Record<string, any>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await admin.rpc("copy_gate_rows2", { p_list_id: listId }).order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    leads.push(...((page || []) as Record<string, any>[]));
    if (!page || page.length < 1000) break;
  }
  const res = lintBatch(leads.map((r) => ({ id: r.id, full_name: r.full_name, company_name: r.company_name,
    email_subject: r.email_subject, email_1: r.email_1, email_2: r.email_2 })));
  // cross-batch uniqueness: team sends of the last 180 days + other active/ready leads' copy
  const texts = new Map(leads.map((r) => [r.id, leadTexts(r)]));
  const sentences = [...new Set([...texts.values()].flatMap((t) => t.s))];
  const bodies = [...new Set([...texts.values()].map((t) => t.b).filter(Boolean))];
  let hits: Record<string, any>[] = [];
  if (sentences.length || bodies.length) {
    const { data, error: e1 } = await admin.rpc("copy_uniqueness_hits", { p_list_id: listId, p_sentences: sentences, p_bodies: bodies });
    if (e1) throw new Error(e1.message);
    hits = data || [];
  }
  const results = leads.map((r) => {
    const x = res.get(r.id) || { errors: [], warnings: [] };
    const errors = [...x.errors, ...uniquenessErrors(texts.get(r.id)!, hits)];
    const t = texts.get(r.id)!;
    return { id: r.id, ok: errors.length === 0, errors, warnings: x.warnings, hash: r.hash, s1: t.s, fu: t.b };
  });
  const summary = { passed: 0, held: 0, started_now: 0 };
  for (let i = 0; i < Math.max(results.length, 1); i += 500) {
    const { data: rec, error: e2 } = await admin.rpc("copy_gate_record", { p_list_id: listId, p_results: results.slice(i, i + 500) });
    if (e2) throw new Error(e2.message);
    summary.passed += rec?.passed || 0; summary.held += rec?.held || 0; summary.started_now += rec?.started_now || 0;
  }
  return { summary, results: results.map(({ hash: _h, s1: _s, fu: _f, ...r }) => r) };
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
