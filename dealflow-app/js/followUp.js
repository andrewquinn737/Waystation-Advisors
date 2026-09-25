// Helpers for the Recommended SECOND email, which is a follow-up threaded
// onto the first one (same thread, "Re: <subject>", In-Reply-To the first
// email's Message-ID) rather than a fresh message. Used by Messages' compose
// deep link and by Dials' Mass email.

import { supabase } from "./supabaseClient.js";

export function stripReplyPrefix(subject) {
  return (subject || "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim();
}

export function isReplySubject(subject) {
  return /^\s*re\s*:/i.test(subject || "");
}

// The most recent email this app sent TO `recipient` whose subject matches
// `baseSubject` (ignoring Re:/Fwd: and case); with no baseSubject, simply the
// most recent one sent to them. Returns { id, account_id, message_id,
// thread_id, subject } or null. Nothing outbound is ever matched to a
// message ID it doesn't have (message_id is the RFC Message-ID email-send
// stamped on the mail, which is what In-Reply-To needs).
export async function findPriorOutbound(recipient, baseSubject) {
  if (!recipient) return null;
  const tries = [...new Set([recipient, recipient.toLowerCase()])];
  const wanted = stripReplyPrefix(baseSubject).toLowerCase();
  for (const addr of tries) {
    const { data } = await supabase
      .from("email_messages")
      .select("id, account_id, message_id, thread_id, subject, in_reply_to, sent_at")
      .eq("direction", "outbound")
      .contains("to_addresses", [{ address: addr }])
      .order("sent_at", { ascending: false })
      .limit(20);
    // The very first email of a thread — never a follow-up we sent ourselves.
    const match = (data || []).find((m) => m.message_id && !m.in_reply_to && (!wanted || stripReplyPrefix(m.subject).toLowerCase() === wanted));
    if (match) return match;
  }
  return null;
}

// True if a follow-up (a reply to `priorMessageId`) was already sent — so
// running Mass email twice never double-sends the second email.
export async function followUpAlreadySent(priorMessageId) {
  const { data } = await supabase
    .from("email_messages")
    .select("id")
    .eq("direction", "outbound")
    .eq("in_reply_to", priorMessageId)
    .limit(1);
  return !!(data && data.length);
}
