// verify-email: MillionVerifier API v3 mailbox check, with a 30-day cache (table email_verifications).
// Service role only (Authorization: Bearer <service role key>), or import verifyEmails() from another function.
// Policy lives in SQL start_emails(): 'ok' may be emailed; catch_all / unknown / invalid / disposable / error never are.
// TEST-ONLY shortcut: on any project that is not the live one, @example.com addresses count as 'ok'
// without calling MillionVerifier (so tests do not spend credits). Never active on live.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const LIVE_REF = "jabjrhkhnbabfihodqie";
const CACHE_DAYS = 30;
const CONCURRENCY = 5;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

export type Verdict = { email: string; result: string; source: "cache" | "millionverifier" | "test_shortcut" | "error" | "suppression"; transient?: boolean };

const isLiveProject = () => (Deno.env.get("SUPABASE_URL") || "").includes(LIVE_REF);
const isTestShortcut = (email: string) => !isLiveProject() && email.toLowerCase().endsWith("@example.com");

async function callMv(email: string): Promise<{ result: string; transient: boolean }> {
  const key = Deno.env.get("MILLIONVERIFIER_API_KEY");
  if (!key) return { result: "error", transient: true };
  try {
    const r = await fetch(`https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&timeout=10`,
      { headers: { "User-Agent": "Mozilla/5.0 waystation-verify" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { result: "error", transient: true };
    const j = await r.json();
    if (j.error) return { result: "error", transient: true };       // e.g. out of credits: do not cache, do not convert
    return { result: String(j.result || "unknown").toLowerCase(), transient: false };
  } catch { return { result: "error", transient: true }; }
}

export async function verifyEmails(admin: SupabaseClient, emails: string[]): Promise<Verdict[]> {
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const out = new Map<string, Verdict>();
  // suppressed addresses/domains are never verified (no credit) and never 'ok'
  for (const e of list) {
    const { data: sup } = await admin.rpc("is_suppressed", { p_email: e });
    if (sup === true) out.set(e, { email: e, result: "suppressed", source: "suppression" });
  }
  const cutoff = new Date(Date.now() - CACHE_DAYS * 864e5).toISOString();
  for (let i = 0; i < list.length; i += 200) {
    const { data } = await admin.from("email_verifications").select("email, result").in("email", list.slice(i, i + 200)).gte("checked_at", cutoff);
    for (const r of data || []) if (!out.has(r.email)) out.set(r.email, { email: r.email, result: r.result, source: "cache" });
  }
  const todo = list.filter((e) => !out.has(e));
  for (const e of todo) if (isTestShortcut(e)) out.set(e, { email: e, result: "ok", source: "test_shortcut" });
  const real = todo.filter((e) => !out.has(e));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, real.length) }, async () => {
    while (next < real.length) {
      const e = real[next++];
      const { result, transient } = await callMv(e);
      if (transient) { out.set(e, { email: e, result: "error", source: "error", transient: true }); continue; }
      await admin.from("email_verifications").upsert({ email: e, result, checked_at: new Date().toISOString(), source: "millionverifier" });
      out.set(e, { email: e, result, source: "millionverifier" });
    }
  }));
  return list.map((e) => out.get(e)!);
}

if (import.meta.main) Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if ((req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim() !== key) return json({ error: "Service role only." }, 403);
  let body: { emails?: string[] };
  try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
  if (!Array.isArray(body.emails) || body.emails.length > 500) return json({ error: "emails: array of up to 500" }, 400);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, key);
  return json({ results: await verifyEmails(admin, body.emails) });
});
