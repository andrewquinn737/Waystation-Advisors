// Supabase Edge Function: email-account-manage — connects, edits and removes a
// team lead's / admin's mailboxes (email_accounts rows) from Profile -> Edit.
// Credentials are VERIFIED against the real mail server (IMAP login + SMTP
// auth, nothing is sent) before anything is saved, and passwords never go
// back to the browser. The user's ordered email list (profiles.email,
// email_2, email_3 — top one is the default) is kept in step.
//
// Body: { action: "save" | "remove", account_id?, slot_email?, email_address, username,
//         password?, imap_host, imap_port, smtp_host, smtp_port }
//  - save + account_id: edit that connected mailbox (blank password = keep).
//  - save + slot_email: connect a listed-but-unconnected email.
//  - save (neither): add a new one (max 3 emails total).
//  - remove + account_id (or slot_email for an unconnected one).

import { createClient } from "npm:@supabase/supabase-js@2";
import { imapConnect, imapLogin, imapLogout } from "./imap.ts";
import { getMailboxPassword, setMailboxPassword } from "../_shared/mailboxSecret.ts";
import { hostIsPrivate } from "../_shared/hostGuard.ts";

const MAX_EMAILS = 3;
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);
}

// SMTP over implicit TLS (same as email-send): connect, EHLO, AUTH LOGIN, QUIT.
async function smtpAuthCheck(host: string, port: number, user: string, pass: string) {
  const conn = await Deno.connectTls({ hostname: host, port });
  try {
    const reader = conn.readable.getReader();
    const writer = conn.writable.getWriter();
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let buf = new Uint8Array(0);
    const readLine = async () => {
      while (true) {
        const i = buf.indexOf(10);
        if (i !== -1) {
          const line = buf.slice(0, i + 1);
          buf = buf.slice(i + 1);
          return dec.decode(line);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("connection closed");
        const c = new Uint8Array(buf.length + value.length);
        c.set(buf, 0);
        c.set(value, buf.length);
        buf = c;
      }
    };
    const readMulti = async () => {
      let all = "";
      while (true) {
        const l = await readLine();
        all += l;
        if (/^\d{3} /.test(l)) return all;
      }
    };
    const send = (l: string) => writer.write(enc.encode(l + "\r\n"));
    await readMulti();
    await send("EHLO waystation-advisors.app");
    await readMulti();
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

const eq = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const slotsOf = (p: any): string[] => [p.email, p.email_2, p.email_3].map((x) => (x || "").trim()).filter(Boolean);
const slotUpdate = (arr: string[]) => ({ email: arr[0] || null, email_2: arr[1] || null, email_3: arr[2] || null });

async function handle(req: Request): Promise<Response> {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid request body." }, 400); }

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return jsonResponse({ error: "Missing authorization." }, 401);
  const { data: caller, error: callerErr } = await admin.auth.getUser(jwt);
  if (callerErr || !caller?.user) return jsonResponse({ error: "Your session isn't valid — please sign in again." }, 401);
  const userId = caller.user.id;

  const { data: prof } = await admin.from("profiles").select("id, role, full_name, email, email_2, email_3").eq("id", userId).single();
  if (!prof || !["team_lead", "admin"].includes(prof.role)) return jsonResponse({ error: "Only team leads and admins can connect an email." }, 403);

  const cur = slotsOf(prof);
  const { action } = body;

  // ---- remove ----
  if (action === "remove") {
    let address: string | null = body.slot_email || null;
    if (body.account_id) {
      const { data: row } = await admin.from("email_accounts").select("id, owner_id, email_address").eq("id", body.account_id).maybeSingle();
      if (!row || row.owner_id !== userId) return jsonResponse({ error: "That email isn't connected to your account." }, 404);
      address = row.email_address;
      const { error: delErr } = await admin.from("email_accounts").delete().eq("id", row.id);
      if (delErr) return jsonResponse({ error: delErr.message }, 500);
    }
    if (!address) return jsonResponse({ error: "Nothing to remove." }, 400);
    const next = cur.filter((s) => !eq(s, address!));
    await admin.from("profiles").update(slotUpdate(next)).eq("id", userId);
    return jsonResponse({ ok: true, slots: next });
  }

  if (action !== "save") return jsonResponse({ error: "Unknown action." }, 400);

  // ---- save (edit / connect / add) ----
  const email_address = String(body.email_address || "").trim();
  const username = String(body.username || "").trim();
  const imap_host = String(body.imap_host || "").trim();
  const smtp_host = String(body.smtp_host || "").trim();
  const imap_port = Number(body.imap_port);
  const smtp_port = Number(body.smtp_port);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email_address)) return jsonResponse({ error: "Enter a valid email address." }, 400);
  if (!username) return jsonResponse({ error: "Enter the mailbox username." }, 400);
  if (!imap_host || !smtp_host) return jsonResponse({ error: "Enter the incoming (IMAP) and outgoing (SMTP) server addresses." }, 400);
  if (!imap_port || !smtp_port) return jsonResponse({ error: "Enter the IMAP and SMTP port numbers." }, 400);

  let existing: any = null;
  if (body.account_id) {
    const { data: row } = await admin.from("email_accounts").select("*").eq("id", body.account_id).maybeSingle();
    if (!row || row.owner_id !== userId) return jsonResponse({ error: "That email isn't connected to your account." }, 404);
    existing = row;
  }
  // Never send a stored password to a different server: changing a host or port needs the password typed again.
  const hostChanged = !!existing && (existing.imap_host !== imap_host || existing.smtp_host !== smtp_host ||
    Number(existing.imap_port) !== imap_port || Number(existing.smtp_port) !== smtp_port || existing.username !== username);
  if (hostChanged && !String(body.password || "")) {
    return jsonResponse({ error: "To change the mail server, port or username, enter the password again." }, 400);
  }
  if (await hostIsPrivate(imap_host) || await hostIsPrivate(smtp_host)) {
    return jsonResponse({ error: "That mail server address is not allowed (private or local network)." }, 400);
  }
  const password = String(body.password || "") || (existing ? await getMailboxPassword(admin, existing) : "");
  if (!password) return jsonResponse({ error: "Enter the mailbox password." }, 400);

  // Which listed address this replaces (edit / connect a listed one), if any.
  const replacing: string | null = existing ? existing.email_address : body.slot_email || null;
  let next = [...cur];
  if (replacing) {
    const i = next.findIndex((s) => eq(s, replacing));
    if (i >= 0) next[i] = email_address;
    else if (next.length >= MAX_EMAILS) return jsonResponse({ error: `You can list up to ${MAX_EMAILS} emails.` }, 400);
    else next.push(email_address);
  } else {
    const i = next.findIndex((s) => eq(s, email_address));
    if (i >= 0) {
      // Adding an address that's already listed but unconnected just connects it.
    } else if (next.length >= MAX_EMAILS) {
      return jsonResponse({ error: `You already have ${MAX_EMAILS} emails — remove one to add another.` }, 400);
    } else next.push(email_address);
  }
  if (next.filter((s) => eq(s, email_address)).length > 1) return jsonResponse({ error: "That email is already on your list." }, 400);

  const { data: dupes } = await admin.from("email_accounts").select("id").ilike("email_address", email_address);
  if ((dupes || []).some((d: any) => !existing || d.id !== existing.id)) return jsonResponse({ error: "That email is already connected to the app." }, 400);

  // Verify the credentials for real before saving anything.
  try {
    const c = await withTimeout(imapConnect(imap_host, imap_port), 12000, "Connecting to the incoming server");
    try {
      await withTimeout(imapLogin(c, username, password), 12000, "Incoming server login");
    } finally {
      await imapLogout(c);
    }
  } catch (e) {
    const m = String(e);
    return jsonResponse({ error: /login failed|AUTHENTICATIONFAILED/i.test(m) ? "Incoming (IMAP) login failed — check the username and password." : `Couldn't reach the incoming (IMAP) server ${imap_host}:${imap_port} — check the address and port (SSL/TLS, usually 993). ${m.replace(/^Error: /, "")}` }, 400);
  }
  try {
    await withTimeout(smtpAuthCheck(smtp_host, smtp_port, username, password), 15000, "Outgoing server login");
  } catch (e) {
    const m = String(e);
    return jsonResponse({ error: /SMTP login failed/i.test(m) ? "Outgoing (SMTP) login failed — check the username and password." : `Couldn't reach the outgoing (SMTP) server ${smtp_host}:${smtp_port} — check the address and port (SSL/TLS, usually 465). ${m.replace(/^Error: /, "")}` }, 400);
  }

  const fields = { email_address, username, imap_host, imap_port, smtp_host, smtp_port };
  let account: any;
  if (existing) {
    const { data, error } = await admin.from("email_accounts").update(fields).eq("id", existing.id).select("id").single();
    if (error) return jsonResponse({ error: error.message }, 500);
    account = data;
  } else {
    const { data, error } = await admin.from("email_accounts").insert({ ...fields, owner_id: userId, label: prof.full_name || email_address, sync_enabled: true }).select("id").single();
    if (error) return jsonResponse({ error: error.message }, 500);
    account = data;
  }
  if (String(body.password || "") || !existing) {
    try { await setMailboxPassword(admin, account.id, password); }
    catch (e) { return jsonResponse({ error: "Could not store the password: " + String(e) }, 500); }
    // a fresh working password also lifts a "Login failed" pause
    await admin.from("email_accounts").update({ send_paused_reason: null }).eq("id", account.id).like("send_paused_reason", "Login failed%");
  }
  await admin.from("profiles").update(slotUpdate(next)).eq("id", userId);
  return jsonResponse({ ok: true, slots: next, account_id: account.id });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try { return await handle(req); } catch (e) { return jsonResponse({ error: "Unexpected error: " + String(e) }, 500); }
});
