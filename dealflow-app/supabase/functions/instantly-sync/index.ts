// instantly-sync: copies every lead in every Instantly campaign into instantly_leads, so the CRM never starts its
// 5-step on someone Instantly has emailed or queued. Runs hourly from pg_cron (x-cron-secret) or on demand by an admin.
// Read-only against Instantly (GET campaigns, POST leads/list). Then instantly_apply() moves matching leads that are
// still waiting for copy onto the call track.
import { createClient } from "npm:@supabase/supabase-js@2";

const CRON_SHARED_SECRET = Deno.env.get("CRON_SHARED_SECRET") ?? "";
const INSTANTLY_API_KEY = Deno.env.get("INSTANTLY_API_KEY") ?? "";
const BASE = "https://api.instantly.ai/api/v2";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const H = () => ({ Authorization: `Bearer ${INSTANTLY_API_KEY}`, "Content-Type": "application/json" });

async function call(url: string, init: RequestInit): Promise<any> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, init);
    if (r.status === 429 || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i)); continue; }
    if (!r.ok) throw new Error(`Instantly ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  }
  throw new Error("Instantly kept failing (rate limit or server error)");
}

async function pull(): Promise<{ rows: { email: string; campaign: string }[]; campaigns: number }> {
  const camps: { id: string; name: string }[] = [];
  let after: string | null = null;
  do {
    const d = await call(`${BASE}/campaigns?limit=100${after ? `&starting_after=${after}` : ""}`, { headers: H() });
    camps.push(...(d.items || []));
    after = (d.items || []).length ? d.next_starting_after ?? null : null;
  } while (after);
  const rows: { email: string; campaign: string }[] = [];
  for (const c of camps) {
    let cur: string | null = null;
    do {
      const d = await call(`${BASE}/leads/list`, { method: "POST", headers: H(), body: JSON.stringify({ campaign: c.id, limit: 100, ...(cur ? { starting_after: cur } : {}) }) });
      for (const l of d.items || []) if (l.email) rows.push({ email: String(l.email), campaign: c.name });
      cur = (d.items || []).length ? d.next_starting_after ?? null : null;
    } while (cur);
  }
  return { rows, campaigns: camps.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const isCron = CRON_SHARED_SECRET !== "" && req.headers.get("x-cron-secret") === CRON_SHARED_SECRET;
  if (!isCron) {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const { data: u } = jwt ? await admin.auth.getUser(jwt) : { data: null };
    if (!u?.user) return json({ error: "Sign in first." }, 401);
    const { data: p } = await admin.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
    if (p?.role !== "admin") return json({ error: "Admins only." }, 403);
  }
  if (!INSTANTLY_API_KEY) return json({ error: "INSTANTLY_API_KEY is not set." }, 500);
  try {
    const { rows, campaigns } = await pull();
    let upserted = 0, moved = 0;
    for (let i = 0; i < rows.length || i === 0; i += 1000) {
      const { data, error } = await admin.rpc("instantly_apply", { p_rows: rows.slice(i, i + 1000) });
      if (error) throw new Error(error.message);
      upserted += data?.upserted ?? 0; moved += data?.moved_to_calls ?? 0;
      if (!rows.length) break;
    }
    return json({ ok: true, campaigns, leads: rows.length, upserted, moved_to_calls: moved });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 502);
  }
});
