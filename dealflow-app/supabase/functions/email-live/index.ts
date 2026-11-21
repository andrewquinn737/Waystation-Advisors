// Supabase Edge Function: email-live — reads a mailbox's folders LIVE over IMAP
// (nothing is stored in this app): folder discovery with counts, message lists
// (headers only, newest first, paged), one full message, and one attachment.
//
// Request body (JSON): { action, account_id, ... }
//   folders:    -> { folders: [{ name, kind, messages, unseen }] }
//   list:       { kind, offset?, limit? } -> { items, total, has_more, folder }
//   get:        { kind, uid } -> { message }
//   attachment: { kind, uid, index } -> { filename, content_type, base64 }
// kind: inbox | sent | spam | trash | drafts | scheduled
//
// Access: the mailbox's owner, an admin, or the team lead of the owner's team (read-only), by the
// caller's own JWT. Read-only — EXAMINE + BODY.PEEK, so nothing is marked
// read or changed on the server.

import { createClient } from "npm:@supabase/supabase-js@2";
import { simpleParser } from "npm:mailparser@3";
import { Buffer } from "node:buffer";
import { getMailboxPassword } from "../_shared/mailboxSecret.ts";
import { hostIsPrivate } from "../_shared/hostGuard.ts";
import { imapConnect, imapLogin, imapLogout, imapList, imapExamine, imapSearchAll, imapFetchHeaders, imapFetchRaw, imapStatus } from "./imap.ts";

const MAX_LIMIT = 40;
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
type FolderKind = "inbox" | "sent" | "spam" | "trash" | "drafts" | "scheduled" | "other";
function classify(name: string, attrs: string): FolderKind {
  if (/^inbox$/i.test(name)) return "inbox";
  if (/\\Sent\b/i.test(attrs)) return "sent";
  if (/\\(Junk|Spam)\b/i.test(attrs)) return "spam";
  if (/\\Trash\b/i.test(attrs)) return "trash";
  if (/\\Drafts\b/i.test(attrs)) return "drafts";
  const leaf = name.split(/[./]/).pop() || name;
  if (/schedul|send ?later|outbox|queued/i.test(leaf)) return "scheduled";
  if (/^sent( items| messages| mail)?$/i.test(leaf)) return "sent";
  if (/^(junk|spam|bulk)( e-?mail| mail)?$/i.test(leaf)) return "spam";
  if (/^(trash|deleted( items| messages)?|bin)$/i.test(leaf)) return "trash";
  if (/^drafts?$/i.test(leaf)) return "drafts";
  return "other";
}
function addr(list: unknown): { name: string; address: string }[] {
  const arr = list ? (Array.isArray(list) ? list : [list]) : [];
  const out: { name: string; address: string }[] = [];
  for (const a of arr as any[]) for (const v of a?.value || []) if (v?.address) out.push({ name: v.name || "", address: v.address });
  return out;
}
async function handle(req: Request): Promise<Response> {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid request body." }, 400); }
  const { action, account_id } = body;
  if (!account_id) return jsonResponse({ error: "account_id is required." }, 400);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return jsonResponse({ error: "Missing authorization." }, 401);
  const { data: caller, error: callerErr } = await admin.auth.getUser(jwt);
  if (callerErr || !caller?.user) return jsonResponse({ error: "Your session isn't valid — please sign in again." }, 401);
  const { data: account } = await admin.from("email_accounts").select("*").eq("id", account_id).maybeSingle();
  if (!account) return jsonResponse({ error: "That email account was not found." }, 404);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", caller.user.id).single();
  let allowed = account.owner_id === caller.user.id || prof?.role === "admin";
  if (!allowed && prof?.role === "team_lead") {
    // A team lead may read (never send from) the mailboxes of interns/independent leads on any team they lead —
    // same rule as the is_team_lead_of() RLS helper used for email_accounts/email_messages.
    const { data: teamIds } = await admin.rpc("my_team_ids", { uid: caller.user.id });
    const { data: ownerProf } = await admin.from("profiles").select("role, team_id").eq("id", account.owner_id).single();
    allowed = !!ownerProf?.team_id && ["intern", "independent_lead"].includes(ownerProf.role) && (teamIds || []).includes(ownerProf.team_id);
  }
  if (!allowed) return jsonResponse({ error: "You don't have access to that mailbox." }, 403);

  if (await hostIsPrivate(account.imap_host)) return jsonResponse({ error: "This mailbox points at a private network address; it is blocked." }, 400);
  const password = await getMailboxPassword(admin, account);
  const c = await imapConnect(account.imap_host, account.imap_port);
  try {
    await imapLogin(c, account.username, password);
    const all = await imapList(c);
    const folders: any[] = all.map((f) => ({ name: f.name, kind: classify(f.name, f.attrs), attrs: f.attrs }));
    if (action === "folders") {
      for (const f of folders) {
        try { const st = await imapStatus(c, f.name); f.messages = st.messages; f.unseen = st.unseen; } catch { /* leave counts off */ }
      }
      return jsonResponse({ folders });
    }
    const kind = String(body.kind || "inbox") as FolderKind;
    const folder = folders.find((f) => f.kind === kind);
    if (!folder) return jsonResponse({ items: [], total: 0, has_more: false, folder: null, note: `This mailbox has no ${kind} folder.` });
    await imapExamine(c, folder.name);
    if (action === "list") {
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || 30));
      const uids = (await imapSearchAll(c)).sort((a, b) => b - a);
      const page = uids.slice(offset, offset + limit);
      const heads = page.length ? await imapFetchHeaders(c, page) : [];
      const items = [];
      for (const h of heads) {
        let parsed: any = {};
        try { parsed = await simpleParser(Buffer.from(h.header)); } catch { /* show what we can */ }
        items.push({ uid: h.uid, seen: /\\Seen/i.test(h.flags), from: addr(parsed.from)[0] || { name: "", address: "unknown" }, to: addr(parsed.to), subject: parsed.subject || "", date: parsed.date ? new Date(parsed.date).toISOString() : null });
      }
      items.sort((a, b) => b.uid - a.uid);
      return jsonResponse({ items, total: uids.length, has_more: offset + limit < uids.length, folder: folder.name });
    }
    if (action === "get" || action === "attachment") {
      const uid = Number(body.uid);
      if (!uid) return jsonResponse({ error: "uid is required." }, 400);
      const raw = await imapFetchRaw(c, uid);
      if (!raw.length) return jsonResponse({ error: "That message no longer exists." }, 404);
      if (raw.length > MAX_RAW_BYTES) return jsonResponse({ error: "That message is too large to open here." }, 413);
      const parsed = await simpleParser(Buffer.from(raw));
      if (action === "attachment") {
        const att = (parsed.attachments || [])[Number(body.index)];
        if (!att) return jsonResponse({ error: "Attachment not found." }, 404);
        return jsonResponse({ filename: att.filename || "attachment", content_type: att.contentType || "application/octet-stream", base64: Buffer.from(att.content).toString("base64") });
      }
      return jsonResponse({ message: { uid, from: addr(parsed.from)[0] || { name: "", address: "unknown" }, to: addr(parsed.to), cc: addr(parsed.cc), subject: parsed.subject || "", date: parsed.date ? new Date(parsed.date).toISOString() : null, html: parsed.html || null, text: parsed.text || null, attachments: (parsed.attachments || []).map((a: any, index: number) => ({ index, filename: a.filename || "", content_type: a.contentType || "", size: a.size || a.content?.length || 0 })) } });
    }
    return jsonResponse({ error: "Unknown action." }, 400);
  } finally {
    await imapLogout(c);
  }
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try { return await handle(req); } catch (e) { return jsonResponse({ error: "Couldn't read the mailbox: " + String(e) }, 502); }
});
