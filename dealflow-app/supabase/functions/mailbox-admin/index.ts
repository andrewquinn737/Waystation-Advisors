// Supabase Edge Function: mailbox-admin — admin-only management of sending mailboxes
// (email_accounts rows): bulk add/update, assign to people, limits, pause, remove, list.
// Meant for the Mailboxes admin page AND for AI tools / scripts (JSON in, JSON out).
//
// Auth (either):
//   - Authorization: Bearer <Supabase user JWT> whose profiles.role = 'admin'
//   - x-admin-api-key: <app_secrets.mailbox_admin_api_key>
// Passwords are write-only: never returned, never logged, scrubbed from error text.
// See docs/MAILBOX_ADMIN_API.md for the request/response shapes.

import { createClient } from "npm:@supabase/supabase-js@2";
import { imapConnect, imapLogin, imapLogout } from "./imap.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-api-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);
}

const MAX_ROWS = 500;
const MAX_VERIFY_ROWS = 25;
const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESETS: Record<string, { imap_host: string; imap_port: number; smtp_host: string; smtp_port: number }> = {
  microsoft: { imap_host: "outlook.office365.com", imap_port: 993, smtp_host: "smtp.office365.com", smtp_port: 587 },
  google: { imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465 },
};
const LIST_COLS = "id, owner_id, label, email_address, username, imap_host, imap_port, smtp_host, smtp_port, sync_enabled, daily_send_limit, mandate, send_route, source, needs_assignment, credentials_verified, send_paused_reason, last_synced_at, last_sync_error, created_at";

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// ---- mail-server login checks (nothing is sent) ----
async function smtpAuthCheck(host: string, port: number, user: string, pass: string) {
  const implicit = port === 465;
  let conn: Deno.Conn = implicit ? await Deno.connectTls({ hostname: host, port }) : await Deno.connect({ hostname: host, port });
  try {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let reader = conn.readable.getReader();
    let writer = conn.writable.getWriter();
    let buf = new Uint8Array(0);
    const readLine = async () => {
      while (true) {
        const i = buf.indexOf(10);
        if (i !== -1) { const line = buf.slice(0, i + 1); buf = buf.slice(i + 1); return dec.decode(line); }
        const { value, done } = await reader.read();
        if (done) throw new Error("connection closed");
        const c = new Uint8Array(buf.length + value.length); c.set(buf, 0); c.set(value, buf.length); buf = c;
      }
    };
    const readMulti = async () => { let all = ""; while (true) { const l = await readLine(); all += l; if (/^\d{3} /.test(l)) return all; } };
    const send = (l: string) => writer.write(enc.encode(l + "\r\n"));
    await readMulti();
    await send("EHLO waystation-advisors.app");
    await readMulti();
    if (!implicit) {
      await send("STARTTLS");
      const r = await readMulti();
      if (!/^220/.test(r)) throw new Error("STARTTLS refused: " + r.trim());
      reader.releaseLock(); writer.releaseLock();
      conn = await Deno.startTls(conn as Deno.TcpConn, { hostname: host });
      reader = conn.readable.getReader(); writer = conn.writable.getWriter(); buf = new Uint8Array(0);
      await send("EHLO waystation-advisors.app");
      await readMulti();
    }
    await send("AUTH LOGIN");
    await readMulti();
    await send(btoa(user));
    await readMulti();
    await send(btoa(pass));
    const r = await readMulti();
    if (!/^235/.test(r)) throw new Error("SMTP login failed: " + r.trim());
    await send("QUIT");
  } finally {
    try { conn.close(); } catch { /* ignore */ }
  }
}

async function verifyCredentials(r: any): Promise<string | null> {
  try {
    const c = await withTimeout(imapConnect(r.imap_host, r.imap_port), 12000, "Connecting to the IMAP server");
    try { await withTimeout(imapLogin(c, r.username, r.password), 12000, "IMAP login"); } finally { await imapLogout(c); }
  } catch (e) {
    return "IMAP: " + String(e).replace(/^Error: /, "");
  }
  try {
    await withTimeout(smtpAuthCheck(r.smtp_host, r.smtp_port, r.username, r.password), 20000, "SMTP login");
  } catch (e) {
    return "SMTP: " + String(e).replace(/^Error: /, "");
  }
  return null;
}

// ---- provider inference ----
const mxCache = new Map<string, string | null>();
async function inferProvider(domain: string): Promise<string | null> {
  domain = domain.toLowerCase();
  if (/^(gmail|googlemail)\.com$/.test(domain)) return "google";
  if (/^(outlook|hotmail|live|msn)\.com$/.test(domain)) return "microsoft";
  if (mxCache.has(domain)) return mxCache.get(domain)!;
  let res: string | null = null;
  try {
    const mx = await withTimeout(Deno.resolveDns(domain, "MX"), 5000, "MX lookup");
    const hosts = mx.map((m: any) => String(m.exchange || "").toLowerCase());
    if (hosts.some((h: string) => /(protection\.outlook\.com|mail\.protection\.outlook|outlook\.com)\.?$/.test(h))) res = "microsoft";
    else if (hosts.some((h: string) => /(google\.com|googlemail\.com)\.?$/.test(h))) res = "google";
  } catch { /* no MX / no DNS */ }
  mxCache.set(domain, res);
  return res;
}

const normName = (t: string) => (t || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
const isInt = (v: unknown) => typeof v === "number" ? Number.isInteger(v) : typeof v === "string" && /^\d+$/.test(v.trim());
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

interface Ctx { admin: any; actorId: string | null }

// Owner resolution against all profiles (loaded once per request).
async function loadProfiles(admin: any) {
  const { data } = await admin.from("profiles").select("id, full_name, role, email, email_2, email_3");
  return (data || []) as any[];
}
function ownerByEmail(profiles: any[], e: string) {
  const l = e.trim().toLowerCase();
  return profiles.find((p) => [p.email, p.email_2, p.email_3].some((x: string) => (x || "").trim().toLowerCase() === l));
}

// ---- bulk_upsert ----
async function bulkUpsert(ctx: Ctx, body: any) {
  const { admin } = ctx;
  const rows = body.mailboxes;
  if (!Array.isArray(rows) || rows.length === 0) return jsonResponse({ error: "mailboxes must be a non-empty array." }, 400);
  if (rows.length > MAX_ROWS) return jsonResponse({ error: `Too many rows (${rows.length}); the limit is ${MAX_ROWS} per request.` }, 400);
  const dryRun = body.dry_run === true;
  const verifyAny = rows.some((r: any) => r && r.verify === true) || body.verify === true;
  if (verifyAny && !dryRun && rows.length > MAX_VERIFY_ROWS) {
    return jsonResponse({ error: `verify:true is limited to ${MAX_VERIFY_ROWS} rows per request (each check logs in to the real mail server). Split the request, or import with verify:false.` }, 400);
  }

  const profiles = await loadProfiles(admin);
  const { data: existingRows } = await admin.from("email_accounts").select("id, email_address, owner_id, needs_assignment, source");
  const existing = new Map<string, any>((existingRows || []).map((r: any) => [String(r.email_address).toLowerCase(), r]));
  const actor = ctx.actorId ? profiles.find((p) => p.id === ctx.actorId) : profiles.find((p) => p.role === "admin");

  type Out = { email: string; status: string; owner: string | null; owner_id?: string | null; needs_assignment?: boolean; verified?: boolean | null; error?: string };
  const results: Out[] = new Array(rows.length);
  const seen = new Set<string>();
  const work: { i: number; v: any }[] = [];

  // pass 1: validate + normalise (no I/O except provider inference)
  await pool(rows.map((r: any, i: number) => ({ r, i })), 8, async ({ r, i }) => {
    const email = r && typeof r === "object" ? str(r.email).toLowerCase() : "";
    const fail = (error: string) => { results[i] = { email: email || `row ${i + 1}`, status: "error", owner: null, error }; };
    if (!r || typeof r !== "object" || Array.isArray(r)) return fail("Row must be an object.");
    if (!EMAIL_RE.test(email) || email.length > 254) return fail("Invalid email address.");
    if (seen.has(email)) return fail("Duplicate of an earlier row in this request.");
    seen.add(email);
    const prev = existing.get(email);
    const password = typeof r.password === "string" ? r.password : "";
    if (!prev && !password) return fail("password is required for a new mailbox.");
    if (password.length > 500) return fail("password is too long.");
    const display_name = str(r.display_name).slice(0, 120);
    const username = str(r.username) || email;
    if (username.length > 254) return fail("username is too long.");

    const v: any = { email, password, display_name, username, prev };
    // provider / hosts
    let preset: any = null;
    const providerWanted = str(r.provider).toLowerCase();
    if (providerWanted) {
      preset = PRESETS[providerWanted];
      if (!preset) return fail("provider must be 'microsoft' or 'google'.");
    }
    const hasHosts = str(r.imap_host) && str(r.smtp_host);
    if (!preset && !hasHosts && !(prev && !str(r.imap_host) && !str(r.smtp_host))) {
      const p = await inferProvider(email.split("@")[1]);
      if (p) preset = PRESETS[p];
    }
    const pick = (k: string, fallback?: unknown) => (str(r[k]) !== "" ? r[k] : preset ? preset[k] : prev ? undefined : fallback);
    const imap_host = str(pick("imap_host")), smtp_host = str(pick("smtp_host"));
    const imap_port = pick("imap_port"), smtp_port = pick("smtp_port");
    if (!prev) {
      if (!imap_host || !smtp_host) return fail("Could not tell the provider from the MX records; give provider ('microsoft' or 'google') or imap_host and smtp_host.");
    }
    for (const [k, h] of [["imap_host", imap_host], ["smtp_host", smtp_host]] as const) {
      if (h && (!HOST_RE.test(h) || h.length > 253)) return fail(`${k} is not a valid host name.`);
    }
    for (const [k, p] of [["imap_port", imap_port], ["smtp_port", smtp_port]] as const) {
      if (p !== undefined && p !== null && p !== "") {
        if (!isInt(p) || Number(p) < 1 || Number(p) > 65535) return fail(`${k} must be an integer from 1 to 65535.`);
      }
    }
    if (imap_host) v.imap_host = imap_host;
    if (smtp_host) v.smtp_host = smtp_host;
    if (imap_port !== undefined && imap_port !== "") v.imap_port = Number(imap_port);
    if (smtp_port !== undefined && smtp_port !== "") v.smtp_port = Number(smtp_port);
    if (!prev) { v.imap_port ??= 993; v.smtp_port ??= preset?.smtp_port ?? 465; }

    if (r.daily_send_limit !== undefined && r.daily_send_limit !== null && r.daily_send_limit !== "") {
      if (!isInt(r.daily_send_limit) || Number(r.daily_send_limit) < 0 || Number(r.daily_send_limit) > 200) return fail("daily_send_limit must be an integer from 0 to 200.");
      v.daily_send_limit = Number(r.daily_send_limit);
    }
    if (r.mandate !== undefined && r.mandate !== null && r.mandate !== "") {
      const m = str(r.mandate).toLowerCase();
      if (m !== "ma" && m !== "data") return fail("mandate must be 'ma' or 'data'.");
      v.mandate = m;
    }
    if (r.sync_enabled !== undefined) {
      if (typeof r.sync_enabled !== "boolean") return fail("sync_enabled must be true or false.");
      v.sync_enabled = r.sync_enabled;
    }
    v.verify = r.verify === true || (body.verify === true && r.verify !== false);
    v.owner_email = str(r.owner_email);
    v.owner_name = str(r.owner_name);
    if (v.owner_email && !EMAIL_RE.test(v.owner_email)) return fail("owner_email is not a valid email address.");
    work.push({ i, v });
  });

  // pass 2: owner resolution
  await pool(work, 10, async ({ i, v }) => {
    let owner: any = null, needs = false, how = "";
    if (v.owner_email) {
      owner = ownerByEmail(profiles, v.owner_email) || null;
      if (!owner) { results[i] = { email: v.email, status: "error", owner: null, error: `No person found with owner_email ${v.owner_email}.` }; v.skip = true; return; }
    } else if (v.owner_name) {
      const n = normName(v.owner_name);
      const hits = profiles.filter((p) => normName(p.full_name) === n);
      if (hits.length === 1) owner = hits[0];
      else { results[i] = { email: v.email, status: "error", owner: null, error: hits.length ? `owner_name "${v.owner_name}" matches ${hits.length} people; use owner_email.` : `No person named "${v.owner_name}".` }; v.skip = true; return; }
    } else if (v.prev && !v.prev.needs_assignment) {
      owner = profiles.find((p) => p.id === v.prev.owner_id) || null; // keep current owner on update
      how = "kept";
    }
    if (!owner && !how) {
      try {
        const { data: id } = await admin.rpc("match_mailbox_owner", { p_display_name: v.display_name || null, p_email: v.email });
        if (id) owner = profiles.find((p) => p.id === id) || null;
      } catch { /* fall through to admin */ }
    }
    if (!owner) { owner = actor || null; needs = true; }
    v.owner = owner; v.needs = needs;
  });

  // pass 3: verify (optional) + write
  const toWrite = work.filter((w) => !w.v.skip);
  await pool(toWrite, 5, async ({ i, v }) => {
    const base = { email: v.email, owner: v.owner?.full_name ?? null, owner_id: v.owner?.id ?? null, needs_assignment: v.needs };
    const scrub = (s: string) => (v.password ? s.split(v.password).join("***") : s);
    if (!v.owner) { results[i] = { ...base, status: "error", error: "No admin profile available to own an unassigned mailbox." }; return; }
    if (dryRun) { results[i] = { ...base, status: v.prev ? "would_update" : "would_create" }; return; }

    let verified: boolean | null = null;
    if (v.verify) {
      const pass = v.password || (await admin.from("email_accounts").select("password").eq("id", v.prev?.id).maybeSingle()).data?.password;
      const full = { imap_host: v.imap_host, imap_port: v.imap_port, smtp_host: v.smtp_host, smtp_port: v.smtp_port, username: v.username, password: pass };
      if (v.prev && (!full.imap_host || !full.smtp_host || !full.imap_port || !full.smtp_port)) {
        const { data: cur } = await admin.from("email_accounts").select("imap_host, imap_port, smtp_host, smtp_port").eq("id", v.prev.id).maybeSingle();
        Object.assign(full, { imap_host: full.imap_host || cur?.imap_host, imap_port: full.imap_port || cur?.imap_port, smtp_host: full.smtp_host || cur?.smtp_host, smtp_port: full.smtp_port || cur?.smtp_port });
      }
      const err = await verifyCredentials(full);
      if (err) { results[i] = { ...base, status: "error", verified: false, error: scrub("Credential check failed, not saved. " + err) }; return; }
      verified = true;
    }

    const fields: any = { username: v.username, source: "api", needs_assignment: v.needs, owner_id: v.owner.id };
    if (v.password) fields.password = v.password;
    for (const k of ["imap_host", "imap_port", "smtp_host", "smtp_port", "daily_send_limit", "mandate", "sync_enabled"]) if (v[k] !== undefined) fields[k] = v[k];
    if (v.display_name) fields.label = v.display_name;
    if (verified !== null) fields.credentials_verified = verified;
    else if (v.password) fields.credentials_verified = null; // new password, unverified
    if (!v.needs) fields.suggested_owner_id = null;
    try {
      if (v.prev) {
        const { error } = await admin.from("email_accounts").update(fields).eq("id", v.prev.id);
        if (error) throw new Error(error.message);
        results[i] = { ...base, status: "updated", verified };
      } else {
        const ins = { label: v.display_name || v.email, sync_enabled: false, ...fields, email_address: v.email };
        const { error } = await admin.from("email_accounts").insert(ins);
        if (error) throw new Error(error.message);
        results[i] = { ...base, status: "created", verified };
      }
    } catch (e) {
      results[i] = { ...base, status: "error", error: scrub(String((e as Error).message || e)) };
    }
  });

  for (let i = 0; i < rows.length; i++) if (!results[i]) results[i] = { email: `row ${i + 1}`, status: "error", owner: null, error: "Row was not processed." };
  const count = (s: string) => results.filter((r) => r.status === s).length;
  return jsonResponse({
    ok: true, dry_run: dryRun,
    summary: { total: rows.length, created: count("created"), updated: count("updated"), would_create: count("would_create"), would_update: count("would_update"), errors: count("error"), needs_assignment: results.filter((r) => r.needs_assignment && r.status !== "error").length },
    results,
  });
}

// ---- assign / update / remove / list ----
function ids(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 1000) return null;
  const out = v.map((x) => str(x));
  return out.every((x) => UUID_RE.test(x)) ? [...new Set(out)] : null;
}

async function assign(ctx: Ctx, body: any) {
  const list = ids(body.account_ids);
  if (!list) return jsonResponse({ error: "account_ids must be a non-empty array of mailbox ids." }, 400);
  const owner_id = str(body.owner_id);
  if (!UUID_RE.test(owner_id)) return jsonResponse({ error: "owner_id must be a profile id." }, 400);
  const { data: p } = await ctx.admin.from("profiles").select("id, full_name").eq("id", owner_id).maybeSingle();
  if (!p) return jsonResponse({ error: "No such person." }, 404);
  const { data, error } = await ctx.admin.from("email_accounts").update({ owner_id, needs_assignment: false, suggested_owner_id: null }).in("id", list).select("id");
  if (error) return jsonResponse({ error: error.message }, 400);
  return jsonResponse({ ok: true, assigned: (data || []).length, requested: list.length, owner: p.full_name });
}

async function update(ctx: Ctx, body: any) {
  const id = str(body.account_id);
  if (!UUID_RE.test(id)) return jsonResponse({ error: "account_id must be a mailbox id." }, 400);
  const f: any = {};
  if ("daily_send_limit" in body) {
    const v = body.daily_send_limit;
    if (v === null || v === "") f.daily_send_limit = null;
    else if (!isInt(v) || Number(v) < 0 || Number(v) > 200) return jsonResponse({ error: "daily_send_limit must be an integer from 0 to 200 (or null for the default)." }, 400);
    else f.daily_send_limit = Number(v);
  }
  if ("mandate" in body) {
    const m = body.mandate === null || body.mandate === "" ? null : str(body.mandate).toLowerCase();
    if (m !== null && m !== "ma" && m !== "data") return jsonResponse({ error: "mandate must be 'ma', 'data' or null." }, 400);
    f.mandate = m;
  }
  if ("send_paused_reason" in body) {
    const r = body.send_paused_reason === null ? null : str(body.send_paused_reason);
    f.send_paused_reason = r ? r.slice(0, 200) : null;
  }
  if ("sync_enabled" in body) {
    if (typeof body.sync_enabled !== "boolean") return jsonResponse({ error: "sync_enabled must be true or false." }, 400);
    f.sync_enabled = body.sync_enabled;
  }
  if (Object.keys(f).length === 0) return jsonResponse({ error: "Nothing to update." }, 400);
  const { data, error } = await ctx.admin.from("email_accounts").update(f).eq("id", id).select("id").maybeSingle();
  if (error) return jsonResponse({ error: error.message }, 400);
  if (!data) return jsonResponse({ error: "No such mailbox." }, 404);
  return jsonResponse({ ok: true, account_id: id, updated: Object.keys(f) });
}

async function remove(ctx: Ctx, body: any) {
  const list = ids(body.account_ids);
  if (!list) return jsonResponse({ error: "account_ids must be a non-empty array of mailbox ids." }, 400);
  const force = body.force === true;
  const results: any[] = [];
  for (const id of list) {
    const { data: row } = await ctx.admin.from("email_accounts").select("id, email_address").eq("id", id).maybeSingle();
    if (!row) { results.push({ account_id: id, status: "error", error: "No such mailbox." }); continue; }
    const { count } = await ctx.admin.from("scheduled_emails").select("id", { count: "exact", head: true }).eq("account_id", id).in("status", ["pending", "sending"]);
    if ((count || 0) > 0 && !force) { results.push({ account_id: id, email: row.email_address, status: "refused", pending_scheduled: count, error: `${count} scheduled email(s) are still queued from this mailbox. Pass force:true to remove anyway.` }); continue; }
    if ((count || 0) > 0) await ctx.admin.from("scheduled_emails").update({ status: "cancelled", error: "Mailbox removed" }).eq("account_id", id).in("status", ["pending", "sending"]);
    const { error } = await ctx.admin.from("email_accounts").delete().eq("id", id);
    results.push(error ? { account_id: id, email: row.email_address, status: "error", error: error.message } : { account_id: id, email: row.email_address, status: "removed" });
  }
  return jsonResponse({ ok: true, removed: results.filter((r) => r.status === "removed").length, results });
}

async function list(ctx: Ctx) {
  const { data: rows, error } = await ctx.admin.from("email_accounts").select(LIST_COLS).order("email_address");
  if (error) return jsonResponse({ error: error.message }, 500);
  const profiles = await loadProfiles(ctx.admin);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const counts = await pool(rows || [], 10, async (r: any) => {
    try {
      const { data } = await ctx.admin.rpc("mailbox_send_counts", { p_account_id: r.id });
      return Array.isArray(data) ? data[0] : data;
    } catch { return null; }
  });
  const mailboxes = (rows || []).map((r: any, i: number) => ({
    ...r,
    owner_name: byId.get(r.owner_id)?.full_name ?? null,
    sent_24h: counts[i]?.sent ?? null,
    scheduled: counts[i]?.scheduled ?? null,
    effective_daily_limit: counts[i]?.daily_limit ?? null,
  }));
  return jsonResponse({ ok: true, mailboxes, people: profiles.map((p) => ({ id: p.id, full_name: p.full_name, role: p.role })) });
}

async function authenticate(req: Request, admin: any): Promise<{ ok: true; ctx: Ctx } | { ok: false; res: Response }> {
  const key = (req.headers.get("x-admin-api-key") || "").trim();
  if (key) {
    const { data } = await admin.from("app_secrets").select("value").eq("key", "mailbox_admin_api_key").maybeSingle();
    const real = String(data?.value || "");
    let diff = real.length === key.length ? 0 : 1;
    for (let i = 0; i < Math.max(real.length, key.length); i++) diff |= (real.charCodeAt(i) || 0) ^ (key.charCodeAt(i) || 0);
    if (!real || diff !== 0) return { ok: false, res: jsonResponse({ error: "Invalid API key." }, 401) };
    return { ok: true, ctx: { admin, actorId: null } };
  }
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return { ok: false, res: jsonResponse({ error: "Missing authorization (Bearer admin session or x-admin-api-key)." }, 401) };
  const { data: caller, error } = await admin.auth.getUser(jwt);
  if (error || !caller?.user) return { ok: false, res: jsonResponse({ error: "Your session isn't valid. Please sign in again." }, 401) };
  const { data: prof } = await admin.from("profiles").select("id, role").eq("id", caller.user.id).maybeSingle();
  if (prof?.role !== "admin") return { ok: false, res: jsonResponse({ error: "Only admins can manage mailboxes." }, 403) };
  return { ok: true, ctx: { admin, actorId: prof.id } };
}

async function handle(req: Request): Promise<Response> {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const a = await authenticate(req, admin);
  if (!a.ok) return a.res;
  let body: any;
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON body." }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "Body must be a JSON object with an action." }, 400);
  switch (body.action) {
    case "bulk_upsert": return await bulkUpsert(a.ctx, body);
    case "assign": return await assign(a.ctx, body);
    case "update": return await update(a.ctx, body);
    case "remove": return await remove(a.ctx, body);
    case "list": return await list(a.ctx);
    case "get_api_key": { // admin session only (the key itself can't be used to read itself back out)
      if (!a.ctx.actorId) return jsonResponse({ error: "Sign in as an admin to view the key." }, 403);
      const { data } = await admin.from("app_secrets").select("value").eq("key", "mailbox_admin_api_key").maybeSingle();
      return jsonResponse({ ok: true, api_key: data?.value ?? null });
    }
    default: return jsonResponse({ error: "Unknown action. Use bulk_upsert, assign, update, remove or list." }, 400);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try { return await handle(req); } catch (_e) { return jsonResponse({ error: "Unexpected server error." }, 500); }
});
