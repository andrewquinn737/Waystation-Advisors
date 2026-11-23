import { createClient } from "npm:@supabase/supabase-js@2";
import { simpleParser } from "npm:mailparser@3";
import { Buffer } from "node:buffer";
import { getMailboxPassword } from "../_shared/mailboxSecret.ts";
import { usesMsOauth, getMsToken, xoauth2String } from "../_shared/msOauth.ts";
import { hostIsPrivate } from "../_shared/hostGuard.ts";
import { imapConnect, imapLogin, imapAuthXoauth2, imapSelect, imapSearchUidsSince, imapFetchRaw, imapLogout } from "./imap.ts";

const CRON_SHARED_SECRET = Deno.env.get("CRON_SHARED_SECRET") ?? "";
// Kept small deliberately — a single invocation has a real memory/CPU
// budget (a 200-message-per-account backfill across several accounts hit
// WORKER_RESOURCE_LIMIT in testing). pg_cron calls this every 2 minutes and
// each run resumes from the last_uid watermark, so a low cap only slows a
// fresh mailbox's first backfill; new mail is never delayed.
const INITIAL_BACKFILL_COUNT = 15;
const MAX_MESSAGES_PER_RUN = 25;
const MAX_RAW_MESSAGE_BYTES = 5 * 1024 * 1024;
// Warm-up spam is checked by fetching just the Subject header (a few hundred
// bytes) so it costs almost nothing and never eats into the real-message cap
// above — otherwise a flood of warm-up mail would delay genuine replies.
const MAX_HEADER_SCANS_PER_RUN = 150;
// The warm-up software stamps every fake email's subject with this tag. Such
// mail is dropped before it is stored, so it never reaches the inbox and never
// triggers a notification. (A DB trigger on email_messages is the backstop.)
const WARMUP_SPAM_TAG = "BPMPVM7";
// Stored mail is a lightweight PREVIEW only (sender, recipients, subject,
// date, a 200-char snippet). The full body and attachments are read live from
// the mailbox when a message is opened (see email-live), and previews older
// than this many days are cleaned up daily (see runCleanup).
const RETENTION_DAYS = 30;

function isWarmupSpam(subject: string | undefined | null): boolean {
  return !!subject && subject.toUpperCase().includes(WARMUP_SPAM_TAG);
}

// verify_jwt is off for this function (the cron path has no user JWT), so
// the browser's Sync now button hits it cross-origin with a plain CORS
// preflight nothing else answers — without these headers/OPTIONS handling
// the preflight 405s and supabase-js reports "Failed to send a request to
// the Edge Function" before the real request is ever made.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

function normalizeSubject(subject: string | undefined | null): string {
  return (subject || "").replace(/^\s*(re|fwd?|fw)\s*:\s*/i, "").trim().toLowerCase();
}

function addrList(list: unknown): { address: string; name?: string }[] {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  const out: { address: string; name?: string }[] = [];
  for (const a of arr as any[]) {
    for (const v of a?.value || []) {
      if (v?.address) out.push({ address: v.address, name: v.name || undefined });
    }
  }
  return out;
}

async function syncOneAccount(admin: ReturnType<typeof createClient>, account: Record<string, any>) {
  if (await hostIsPrivate(account.imap_host)) throw new Error("Mail server resolves to a private address; sync is blocked.");
  const password = await getMailboxPassword(admin as any, account as any);
  const c = await imapConnect(account.imap_host, account.imap_port);
  try {
    if (usesMsOauth(account)) await imapAuthXoauth2(c, xoauth2String(account.username, await getMsToken(account.username))); else await imapLogin(c, account.username, password);
    const { exists, uidValidity } = await imapSelect(c, "INBOX");

    let sinceUid = account.last_uid as number;
    if (account.uidvalidity && account.uidvalidity !== uidValidity) {
      sinceUid = 0;
    }

    const uids = await imapSearchUidsSince(c, sinceUid);
    const cap = sinceUid === 0 ? INITIAL_BACKFILL_COUNT : MAX_MESSAGES_PER_RUN;

    let maxUidSeen = sinceUid;
    let inserted = 0;
    let processed = 0;
    let scanned = 0;
    let skippedLarge = 0;
    let skippedSpam = 0;
    let truncated = false;
    for (const uid of uids) {
      if (scanned >= MAX_HEADER_SCANS_PER_RUN || processed >= cap) {
        truncated = true;
        break;
      }
      scanned += 1;

      // Cheap pre-check: Subject header only. Tagged warm-up mail is skipped
      // here (watermark still advances so it is never fetched again).
      const head = await imapFetchRaw(c, uid, "HEADER.FIELDS (SUBJECT)");
      if (head.length > 0) {
        const headParsed = await simpleParser(Buffer.from(head));
        if (isWarmupSpam(headParsed.subject as string | undefined)) {
          skippedSpam += 1;
          maxUidSeen = Math.max(maxUidSeen, uid);
          continue;
        }
      }
      processed += 1;

      const raw = await imapFetchRaw(c, uid);
      if (raw.length === 0) {
        maxUidSeen = Math.max(maxUidSeen, uid);
        continue;
      }
      if (raw.length > MAX_RAW_MESSAGE_BYTES) {
        skippedLarge += 1;
        maxUidSeen = Math.max(maxUidSeen, uid);
        continue;
      }
      const parsed = await simpleParser(Buffer.from(raw));

      if (isWarmupSpam(parsed.subject as string | undefined)) {
        skippedSpam += 1;
        maxUidSeen = Math.max(maxUidSeen, uid);
        continue;
      }

      const fromAddr = parsed.from?.value?.[0]?.address || "unknown";
      const fromName = parsed.from?.value?.[0]?.name || null;
      const toAddrs = addrList(parsed.to);
      const ccAddrs = addrList(parsed.cc);
      const messageId = parsed.messageId || null;
      const inReplyTo = parsed.inReplyTo || null;
      const references: string[] = Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references
          ? [parsed.references]
          : [];

      let threadId: string | null = null;
      const candidateIds = [inReplyTo, ...references].filter(Boolean) as string[];
      if (candidateIds.length) {
        const { data: linked } = await admin
          .from("email_messages")
          .select("thread_id")
          .eq("account_id", account.id)
          .in("message_id", candidateIds)
          .limit(1)
          .maybeSingle();
        if (linked) threadId = linked.thread_id;
      }
      if (!threadId) {
        const normSubj = normalizeSubject(parsed.subject as string | undefined);
        if (normSubj) {
          const { data: recent } = await admin
            .from("email_messages")
            .select("thread_id, subject, from_address, to_addresses")
            .eq("account_id", account.id)
            .gte("sent_at", new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString())
            .order("sent_at", { ascending: false })
            .limit(50);
          const participants = new Set([fromAddr, ...toAddrs.map((a) => a.address)].map((s) => s.toLowerCase()));
          const match = (recent || []).find((r: any) => {
            if (normalizeSubject(r.subject) !== normSubj) return false;
            const rParticipants = [r.from_address, ...(r.to_addresses || []).map((a: any) => a.address)].map((s: string) => s.toLowerCase());
            return rParticipants.some((p) => participants.has(p));
          });
          if (match) threadId = match.thread_id;
        }
      }

      let clientId: string | null = null;
      for (const addr of [fromAddr, ...toAddrs.map((a) => a.address), ...ccAddrs.map((a) => a.address)]) {
        const { data: matchId } = await admin.rpc("match_email_to_client", { p_address: addr });
        if (matchId) {
          clientId = matchId as string;
          break;
        }
      }

      // Out-of-office / auto-replies: Auto-Submitted (anything but "no"), X-Autoreply / X-Autorespond, Precedence: auto_reply.
      // The database also recognises the usual subjects; this catches the ones that only announce themselves in headers.
      const hdr = (n: string) => String(parsed.headers?.get(n) ?? "").toLowerCase();
      const isAutoReply = (hdr("auto-submitted") !== "" && hdr("auto-submitted") !== "no") || parsed.headers?.has("x-autoreply") || parsed.headers?.has("x-autorespond") || /auto[_-]?reply/.test(hdr("precedence"));

      const snippet = ((parsed.text as string) || "").replace(/\s+/g, " ").trim().slice(0, 200);

      // Preview only — no body_text/body_html and no attachment files are
      // stored; opening the message reads them live from the mailbox by
      // imap_uid (email-live).
      const insertPayload: Record<string, unknown> = {
        account_id: account.id,
        imap_uid: uid,
        message_id: messageId,
        in_reply_to: inReplyTo,
        direction: "inbound",
        from_address: fromAddr,
        from_name: fromName,
        to_addresses: toAddrs,
        cc_addresses: ccAddrs,
        subject: parsed.subject || null,
        body_text: null,
        body_html: null,
        snippet,
        client_id: clientId,
        sent_at: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
      };
      if (threadId) insertPayload.thread_id = threadId;
      if (isAutoReply) insertPayload.is_auto_reply = true;

      const { error: insertErr } = await admin.from("email_messages").insert(insertPayload);
      if (insertErr) {
        if (!/duplicate key/i.test(insertErr.message)) {
          console.error(`email-sync: insert failed for account ${account.id} uid ${uid}:`, insertErr.message);
        }
      } else {
        inserted += 1;
      }
      maxUidSeen = Math.max(maxUidSeen, uid);
    }

    await admin
      .from("email_accounts")
      .update({ last_uid: maxUidSeen, uidvalidity: uidValidity, last_synced_at: new Date().toISOString(), last_sync_error: null })
      .eq("id", account.id);

    return { account_id: account.id, label: account.label, exists, synced: processed, inserted, skippedLarge, skippedSpam, truncated };
  } finally {
    await imapLogout(c);
  }
}

// Daily housekeeping (pg_cron -> { cleanup: true }). Keeps stored mail a
// small preview set:
//  - inbound previews older than RETENTION_DAYS and NOT linked to a client are
//    deleted (with any stored attachment files). The real email stays in the
//    mailbox, and the UID watermark means it is never re-synced.
//  - everything else that old (client-linked inbound, all outbound) keeps its
//    row but loses any stored body, so threads, follow-up detection and the
//    daily send cap keep working.
async function runCleanup(admin: ReturnType<typeof createClient>) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  let deletedRows = 0;
  let removedFiles = 0;
  const { data: old } = await admin
    .from("email_messages")
    .select("id")
    .eq("direction", "inbound")
    .is("client_id", null)
    .lt("sent_at", cutoff)
    .limit(500);
  const ids = (old || []).map((r: any) => r.id);
  if (ids.length) {
    const { data: atts } = await admin.from("email_attachments").select("storage_path").in("message_id", ids);
    const paths = (atts || []).map((a: any) => a.storage_path).filter(Boolean);
    if (paths.length) {
      await admin.storage.from("email-attachments").remove(paths);
      removedFiles = paths.length;
    }
    await admin.from("email_attachments").delete().in("message_id", ids);
    await admin.from("email_messages").delete().in("id", ids);
    deletedRows = ids.length;
  }
  const { data: stripped } = await admin
    .from("email_messages")
    .update({ body_text: null, body_html: null })
    .lt("sent_at", cutoff)
    .or("body_text.not.is.null,body_html.not.is.null")
    .select("id");
  return { deletedRows, removedFiles, bodiesStripped: (stripped || []).length };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let body: { account_id?: string; cleanup?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine — defaults apply
  }

  const cronSecret = req.headers.get("x-cron-secret");
  let ownerFilter: string | null = null;

  if (CRON_SHARED_SECRET && cronSecret === CRON_SHARED_SECRET && body.cleanup) {
    return jsonResponse({ ok: true, cleanup: await runCleanup(admin) });
  }

  if (!CRON_SHARED_SECRET || cronSecret !== CRON_SHARED_SECRET) {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return jsonResponse({ error: "Missing authorization." }, 401);
    const { data: callerData, error: callerErr } = await admin.auth.getUser(jwt);
    if (callerErr || !callerData?.user) return jsonResponse({ error: "Your session isn't valid." }, 401);
    const { data: callerProfile } = await admin.from("profiles").select("role").eq("id", callerData.user.id).single();
    if (!callerProfile || !["team_lead", "admin", "intern", "independent_lead"].includes(callerProfile.role)) {
      return jsonResponse({ error: "You can't sync mail." }, 403);
    }
    if (callerProfile.role !== "admin") ownerFilter = callerData.user.id;
  }

  let query = admin.from("email_accounts").select("*").eq("sync_enabled", true);
  if (ownerFilter) query = query.eq("owner_id", ownerFilter);
  if (body.account_id) query = query.eq("id", body.account_id);
  const { data: accounts, error: acctErr } = await query;
  if (acctErr) return jsonResponse({ error: acctErr.message }, 500);

  const results = [];
  for (const account of accounts || []) {
    try {
      results.push(await syncOneAccount(admin, account));
    } catch (e) {
      const message = String(e);
      console.error(`email-sync: account ${account.id} (${account.label}) failed:`, message);
      await admin.from("email_accounts").update({ last_sync_error: message, last_synced_at: new Date().toISOString() }).eq("id", account.id);
      results.push({ account_id: account.id, label: account.label, error: message });
    }
  }

  return jsonResponse({ ok: true, results });
});
