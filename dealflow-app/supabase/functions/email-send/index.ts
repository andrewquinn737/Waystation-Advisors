// Supabase Edge Function: email-send — see smtp.ts for the hand-rolled SMTP
// client and imap.ts for the Sent-folder filing. Builds a raw RFC822 message,
// sends it over the chosen email_accounts row's own credentials, files a copy
// in that mailbox's real Sent folder (SMTP alone never does — mail apps do it
// themselves via IMAP APPEND), then records it as an outbound email_messages
// row.
//
// Who can send from which account:
//  - The account's owner, or an admin.
//  - An intern sending from THEIR OWN team lead's account (the Clients/Dials
//    "quick send" flow, js/quickSend.js).
//
// Daily cap: a mailbox can send at most mailbox_daily_limit() (25) emails in
// any rolling 24 hours, counting emails already sent plus those already
// scheduled by Mass email. Going over is refused with a 429 error.
//
// Deliverability details (Gmail/Yahoo judge these on a brand-new sending
// domain especially): the Message-ID uses the SENDER'S OWN domain (a
// Message-ID on some unrelated domain is a classic spam signal), and EVERY
// outbound message now carries a List-Unsubscribe mailto header (was mass-
// email-queue sends only) — a real, positive signal Gmail's spam filter
// weighs even below the volume threshold where it's legally required, and
// cheap to always include since it's just a mailto: back to the sending
// mailbox itself.
//
// Hardening (2026-11-24):
//  - SMTP has a 60 s overall timeout. A failure AFTER the message body went out is "unknown" (queue row -> status
//    'unknown', never retried automatically); before that it is a plain failure.
//  - Queue sends are idempotent: email_messages.scheduled_id is unique, and a row that already has a stored message
//    is never sent again (it is just marked sent).
//  - Queue sends to a suppressed address are cancelled; a paused mailbox does not send.
//  - SMTP login failure pauses the mailbox ("Login failed — update the password") and does not burn the lead's attempt.
//  - CR/LF (header injection) is rejected in recipients, In-Reply-To and attachment names; hosts that resolve to private
//    addresses are never contacted; the mailbox password comes from Vault (get_mailbox_password).
//  - List-Unsubscribe stays a mailto: link. RFC 8058 one-click (List-Unsubscribe-Post) needs an https endpoint that
//    suppresses the address; none exists yet, so the Post header is deliberately NOT sent (sending it without a
//    working endpoint would be worse than omitting it).
//
// Two ways in:
//  1. A signed-in user's JWT + request body (below).
//  2. Mass email's queue: pg_cron -> dispatch_scheduled_emails() posts
//     { scheduled_id } with the shared cron secret. The message itself is
//     loaded from the scheduled_emails row (never taken from the request),
//     sent on behalf of that row's creator under the exact same
//     authorization rules, and the row is marked sent/failed afterwards.
//
// Request body (JSON):
//   { account_id, to: string[], cc?, subject, text?, html?, in_reply_to?,
//     thread_id?, attachments?: { filename, contentType, base64 }[] }

import { createClient } from "npm:@supabase/supabase-js@2";
import { smtpSend, SmtpUnknownError, SmtpAuthError } from "./smtp.ts";
import { getMailboxPassword } from "../_shared/mailboxSecret.ts";
import { usesMsOauth, getMsToken, xoauth2String } from "../_shared/msOauth.ts";
import { hostIsPrivate } from "../_shared/hostGuard.ts";
import { imapConnect, imapLogin, imapAuthXoauth2, imapLogout, imapFindSentFolder, imapAppend } from "./imap.ts";

const CRON_SHARED_SECRET = Deno.env.get("CRON_SHARED_SECRET") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`;
}

function buildRawMessage(opts: {
  fromAddr: string;
  fromName?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  messageId: string;
  inReplyTo?: string;
  listUnsubscribe?: string;
  attachments?: { filename: string; contentType: string; base64: string }[];
}): string {
  const fromHeader = opts.fromName ? `${encodeHeader(opts.fromName)} <${opts.fromAddr}>` : opts.fromAddr;
  const headers: string[] = [`From: ${fromHeader}`, `To: ${opts.to.join(", ")}`];
  if (opts.cc?.length) headers.push(`Cc: ${opts.cc.join(", ")}`);
  headers.push(`Subject: ${encodeHeader(opts.subject || "(no subject)")}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push(`Message-Id: ${opts.messageId}`);
  if (opts.inReplyTo) {
    headers.push(`In-Reply-To: ${opts.inReplyTo}`);
    headers.push(`References: ${opts.inReplyTo}`);
  }
  if (opts.listUnsubscribe) headers.push(`List-Unsubscribe: ${opts.listUnsubscribe}`);
  headers.push("MIME-Version: 1.0");

  const text = opts.text || "";
  const html = opts.html || null;
  const attachments = opts.attachments || [];
  const altBoundary = "alt-" + crypto.randomUUID();
  const mixedBoundary = "mixed-" + crypto.randomUUID();

  let bodyPart: string;
  if (html) {
    bodyPart =
      `--${altBoundary}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n\r\n` +
      `--${altBoundary}\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n\r\n` +
      `--${altBoundary}--`;
  } else {
    bodyPart = text;
  }

  if (!attachments.length) {
    if (html) {
      headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      return headers.join("\r\n") + "\r\n\r\n" + bodyPart;
    }
    headers.push("Content-Type: text/plain; charset=utf-8");
    return headers.join("\r\n") + "\r\n\r\n" + bodyPart;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
  const parts: string[] = [
    `--${mixedBoundary}\r\n` + (html ? `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n${bodyPart}` : `Content-Type: text/plain; charset=utf-8\r\n\r\n${bodyPart}`),
  ];
  for (const att of attachments) {
    parts.push(
      `--${mixedBoundary}\r\n` +
        `Content-Type: ${att.contentType || "application/octet-stream"}; name="${att.filename}"\r\n` +
        `Content-Disposition: attachment; filename="${att.filename}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n` +
        att.base64.replace(/(.{76})/g, "$1\r\n")
    );
  }
  parts.push(`--${mixedBoundary}--`);
  return headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n\r\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);
}

type SendBody = {
  account_id?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  in_reply_to?: string;
  thread_id?: string;
  attachments?: { filename: string; contentType: string; base64: string }[];
  scheduled_id?: string;
};

async function handle(req: Request, ctx: { scheduledId: string | null }): Promise<Response> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let body: SendBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body." }, 400);
  }

  let callerUserId: string;
  let scheduledTo: string | null = null;
  if (CRON_SHARED_SECRET && req.headers.get("x-cron-secret") === CRON_SHARED_SECRET && body.scheduled_id) {
    // Queue path: everything comes from the row, claimed as 'sending' by
    // dispatch_scheduled_emails() — anything else is refused, so a row can
    // never be sent twice or sent after being cancelled.
    const { data: row } = await admin.from("scheduled_emails").select("*").eq("id", body.scheduled_id).maybeSingle();
    if (!row) return jsonResponse({ error: "Scheduled email not found." }, 404);
    if (row.status !== "sending") return jsonResponse({ error: `Scheduled email is ${row.status}, not sending.` }, 409);
    ctx.scheduledId = row.id;
    scheduledTo = row.to_address;
    callerUserId = row.created_by;
    body = {
      account_id: row.account_id,
      to: [row.to_address],
      subject: row.subject || "",
      text: row.body_text,
      in_reply_to: row.in_reply_to || undefined,
      thread_id: row.thread_id || undefined,
    };
  } else {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return jsonResponse({ error: "Missing authorization." }, 401);
    const { data: callerData, error: callerErr } = await admin.auth.getUser(jwt);
    if (callerErr || !callerData?.user) return jsonResponse({ error: "Your session isn't valid — please sign in again." }, 401);
    callerUserId = callerData.user.id;
  }

  let { account_id, to, cc, subject, text, html, in_reply_to, thread_id, attachments } = body;

  // Header injection guard: nothing that ends up in a header may carry CR/LF/NUL; recipients must be single plain addresses.
  const ctl = (v: unknown) => typeof v === "string" && /[\r\n\0]/.test(v);
  const ADDR_RE = /^[^\s,;<>()"\\]+@[^\s,;<>()"\\]+$/;
  for (const a of [...(to || []), ...(cc || [])]) {
    if (typeof a !== "string" || ctl(a) || !ADDR_RE.test(a.trim())) return jsonResponse({ error: "Invalid recipient address." }, 400);
  }
  if (ctl(in_reply_to) || (in_reply_to !== undefined && in_reply_to !== null && typeof in_reply_to !== "string")) {
    return jsonResponse({ error: "Invalid In-Reply-To value." }, 400);
  }
  for (const att of attachments || []) {
    if (!att || typeof att.filename !== "string" || ctl(att.filename) || /["\\]/.test(att.filename) ||
        (att.contentType !== undefined && (ctl(att.contentType) || /["\\;]/.test(att.contentType)))) {
      return jsonResponse({ error: "Invalid attachment name or type." }, 400);
    }
  }

  // TEST SAFETY NET. Set only on the test project (never on live):
  // TEST_REDIRECT_TO = comma-separated allowlist. Any recipient not on it is
  // swapped for an allowlisted address, so a test deployment can never email a
  // real business owner. Unset = normal behavior.
  const testSinks = (Deno.env.get("TEST_REDIRECT_TO") || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const IS_LIVE_PROJECT = (Deno.env.get("SUPABASE_URL") || "").includes("jabjrhkhnbabfihodqie");
  if (!IS_LIVE_PROJECT && !testSinks.length) {
    return jsonResponse({ error: "Test project without TEST_REDIRECT_TO: sending is disabled." }, 503);
  }
  if (testSinks.length && to?.length) {
    const redirect = (addr: string) => {
      const a = String(addr).trim().toLowerCase();
      if (testSinks.includes(a)) return a;
      let h = 0;
      for (const ch of a) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return testSinks[h % testSinks.length];
    };
    const original = [...to, ...(cc || [])].join(", ");
    to = to.map(redirect);
    cc = (cc || []).map(redirect);
    if (original.toLowerCase() !== [...to, ...cc].join(", ")) {
      subject = `[TEST to ${original}] ${subject || ""}`.trim();
    }
  }
  if (!account_id || !to?.length || (!text && !html)) {
    return jsonResponse({ error: "account_id, at least one recipient, and a message body are required." }, 400);
  }

  const { data: account, error: acctErr } = await admin.from("email_accounts").select("*").eq("id", account_id).single();
  if (acctErr || !account) return jsonResponse({ error: "That email account was not found." }, 404);

  if (ctx.scheduledId) {
    // Idempotency: this queue row already produced a stored message -> it was sent; never send it again.
    const { data: already } = await admin.from("email_messages").select("id, thread_id").eq("scheduled_id", ctx.scheduledId).maybeSingle();
    if (already) return jsonResponse({ ok: true, sent: true, recorded: true, already_sent: true, message_id: already.id, thread_id: already.thread_id });
    if (account.send_paused_reason) return jsonResponse({ error: `Mailbox paused: ${account.send_paused_reason}`, code: "paused" }, 409);
    const { data: supp } = await admin.rpc("is_suppressed", { p_email: String(scheduledTo || "") });
    if (supp === true) return jsonResponse({ error: "Recipient is on the suppression list.", code: "suppressed" }, 409);
  }
  if (await hostIsPrivate(account.smtp_host) || await hostIsPrivate(account.imap_host)) {
    return jsonResponse({ error: "This mailbox points at a private network address; sending is blocked." }, 400);
  }
  const password = await getMailboxPassword(admin, account);
  if (!password) return jsonResponse({ error: "This mailbox has no password stored." }, 400);

  const { data: callerProfile } = await admin.from("profiles").select("role, team_id").eq("id", callerUserId).single();
  const isOwner = account.owner_id === callerUserId;
  const isAdmin = callerProfile?.role === "admin";
  let isOwnTeamLead = false;
  if (!isOwner && !isAdmin && callerProfile?.role === "intern" && callerProfile.team_id) {
    const { data: ownerProfile } = await admin.from("profiles").select("role, team_id").eq("id", account.owner_id).single();
    isOwnTeamLead = ownerProfile?.role === "team_lead" && ownerProfile.team_id === callerProfile.team_id;
  }
  if (!isOwner && !isAdmin && !isOwnTeamLead) {
    return jsonResponse({ error: "You don't have access to send from this account." }, 403);
  }

  // Daily cap (rolling 24h). A queued email is already counted among the
  // "scheduled" (its own row is 'sending'), and was checked when it was
  // queued, so on that path only what has actually gone out counts; a direct
  // send counts sent + everything still scheduled.
  {
    const { data: countsData } = await admin.rpc("mailbox_send_counts", { p_account_id: account_id });
    const counts = Array.isArray(countsData) ? countsData[0] : countsData;
    if (counts) {
      const used = ctx.scheduledId ? counts.sent : counts.sent + counts.scheduled;
      if (used >= counts.daily_limit) {
        return jsonResponse(
          {
            error:
              `Daily limit reached: ${account.email_address} can send at most ${counts.daily_limit} emails per 24 hours ` +
              `(${counts.sent} sent${counts.scheduled ? `, ${counts.scheduled} more scheduled` : ""}).`,
            code: "daily_limit",
          },
          429
        );
      }
    }
  }

  // Message-ID on the sender's own domain (see header comment).
  const senderDomain = (String(account.email_address).split("@")[1] || "waystation-advisors.app").toLowerCase();
  const messageId = `<${crypto.randomUUID()}@${senderDomain}>`;
  // SMTP and IMAP both require CRLF line endings; user-typed text arrives
  // with bare \n, so normalize the whole message once up front.
  const raw = buildRawMessage({
    fromAddr: account.email_address,
    fromName: account.label,
    to,
    cc,
    subject: subject || "",
    text,
    html,
    messageId,
    inReplyTo: in_reply_to,
    // Always included now (used to be mass-email-queue sends only) — see
    // header comment. A plain mailto: back to the sending mailbox itself,
    // so it needs no unsubscribe-handling endpoint of our own.
    listUnsubscribe: `<mailto:${account.email_address}?subject=unsubscribe>`,
    attachments,
  }).replace(/\r?\n/g, "\r\n");

  let sendResult: { ok: boolean; log: string[]; rejected: string[]; accepted: string[] };
  try {
    sendResult = await smtpSend({
      host: account.smtp_host,
      port: account.smtp_port,
      username: account.username,
      password,
      raw,
    });
  } catch (e) {
    if (e instanceof SmtpUnknownError) {
      return jsonResponse({ error: "Send result unknown — check Sent folder", code: "unknown", detail: String(e).slice(0, 200) }, 502);
    }
    if (e instanceof SmtpAuthError || /SMTP auth failed/i.test(String(e))) {
      // wrong/changed password: pause the mailbox so nothing else burns attempts against it
      await admin.from("email_accounts").update({ send_paused_reason: "Login failed — update the password" })
        .eq("id", account_id).or("send_paused_reason.is.null,send_paused_reason.eq.");
      return jsonResponse({ error: "Login failed — update the password", code: "auth_failed" }, 502);
    }
    return jsonResponse({ error: "Sending failed: " + String(e) }, 502);
  }
  if (!sendResult.ok) {
    const why = sendResult.rejected.length
      ? `The mail server refused every recipient (${sendResult.rejected.join(", ")}).`
      : "The mail server rejected the message.";
    return jsonResponse({ error: why, log: sendResult.log }, 502);
  }

  // File a copy in the mailbox's own Sent folder. Best effort: the message
  // is already delivered, so a failure here is reported, never treated as a
  // failed send.
  let savedToSent = false;
  let sentFolder: string | null = null;
  let sentFolderError: string | null = null;
  try {
    await withTimeout(
      (async () => {
        const c = await imapConnect(account.imap_host, account.imap_port);
        try {
          if (usesMsOauth(account)) await imapAuthXoauth2(c, xoauth2String(account.username, await getMsToken(account.username))); else await imapLogin(c, account.username, password);
          sentFolder = await imapFindSentFolder(c);
          await imapAppend(c, sentFolder, new TextEncoder().encode(raw));
          savedToSent = true;
        } finally {
          await imapLogout(c);
        }
      })(),
      15000,
      "Saving to Sent"
    );
  } catch (e) {
    sentFolderError = String(e);
    console.error(`email-send: could not save to Sent for account ${account_id}:`, sentFolderError);
  }

  let resolvedThreadId = thread_id || null;
  if (!resolvedThreadId && in_reply_to) {
    const { data: linked } = await admin
      .from("email_messages")
      .select("thread_id")
      .eq("account_id", account_id)
      .eq("message_id", in_reply_to)
      .maybeSingle();
    if (linked) resolvedThreadId = linked.thread_id;
  }

  let clientId: string | null = null;
  for (const addr of [...to, ...(cc || [])]) {
    const { data: matchId } = await admin.rpc("match_email_to_client", { p_address: addr });
    if (matchId) {
      clientId = matchId as string;
      break;
    }
  }

  const warning = sendResult.rejected.length
    ? `Sent, but the mail server refused: ${sendResult.rejected.join(", ")}.`
    : null;

  const insertPayload: Record<string, unknown> = {
    account_id,
    message_id: messageId,
    in_reply_to: in_reply_to || null,
    direction: "outbound",
    from_address: account.email_address,
    from_name: account.label,
    to_addresses: to.map((a) => ({ address: a })),
    cc_addresses: (cc || []).map((a) => ({ address: a })),
    subject: subject || null,
    body_text: text || null,
    body_html: html || null,
    snippet: (text || "").replace(/\s+/g, " ").trim().slice(0, 200),
    is_read: true,
    client_id: clientId,
    sent_at: new Date().toISOString(),
    created_by: callerUserId,
  };
  if (ctx.scheduledId) insertPayload.scheduled_id = ctx.scheduledId;   // idempotency key (unique index)
  if (resolvedThreadId) insertPayload.thread_id = resolvedThreadId;

  const { data: inserted, error: insertErr } = await admin.from("email_messages").insert(insertPayload).select("id, thread_id").single();
  if (insertErr) {
    return jsonResponse({ ok: true, sent: true, recorded: false, error: insertErr.message, saved_to_sent: savedToSent, warning });
  }

  for (const att of attachments || []) {
    const path = `${inserted.id}/${att.filename}`;
    const bytes = Uint8Array.from(atob(att.base64), (c) => c.charCodeAt(0));
    const { error: upErr } = await admin.storage.from("email-attachments").upload(path, bytes, {
      contentType: att.contentType || "application/octet-stream",
      upsert: true,
    });
    if (!upErr) {
      await admin.from("email_attachments").insert({
        message_id: inserted.id,
        filename: att.filename,
        content_type: att.contentType || null,
        size_bytes: bytes.length,
        storage_path: path,
      });
    }
  }

  return jsonResponse({
    ok: true,
    sent: true,
    recorded: true,
    message_id: inserted.id,
    thread_id: inserted.thread_id,
    saved_to_sent: savedToSent,
    sent_folder: sentFolder,
    sent_folder_error: sentFolderError,
    warning,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const ctx: { scheduledId: string | null } = { scheduledId: null };
  let res: Response;
  try {
    res = await handle(req, ctx);
  } catch (e) {
    res = jsonResponse({ error: "Unexpected error: " + String(e) }, 500);
  }

  // Queue path: record the outcome on the scheduled_emails row.
  if (ctx.scheduledId) {
    const j = await res.clone().json().catch(() => ({} as Record<string, unknown>));
    const sent = res.status < 300 && j.sent === true;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin
      .from("scheduled_emails")
      .update(
        j.code === "unknown"
          ? { status: "unknown", error: "Send result unknown — check Sent folder" }
          : j.code === "suppressed"
          ? { status: "cancelled", error: "Recipient is on the suppression list." }
          : sent
          ? { status: "sent", sent_at: new Date().toISOString(), error: (j.warning as string) || null,
              // links the queued row to the stored message (sequence threading); needs the 20261120 migration
              ...(typeof j.message_id === "string" ? { sent_message_id: j.message_id } : {}) }
          : { status: "failed", error: String(j.error || "Send failed").slice(0, 500) }
      )
      .eq("id", ctx.scheduledId)
      // a late success may still turn an 'unknown' row into 'sent'; nothing else may overwrite a row that already moved on
      .in("status", sent ? ["sending", "unknown"] : ["sending"]);
  }
  return res;
});
