// Cross-batch uniqueness helpers for the copy gate. Uses copyLint.js's own exports so the
// normalization is the same one the review screen uses (SQL copy_sentences() is parity-tested
// against it: tools/testenv/test_sentence_parity.py).
import { bodySentences, normBody } from "./copyLint.js";

const MIN_FOLLOWUP_CHARS = 1;
export function leadTexts(lead) {
  return {
    s: lead.email_1_sent ? [] : [...new Set(bodySentences(lead.email_1))],            // email 1 already sent = it is in the index itself
    b: lead.followup_sent ? "" : (normBody(lead.email_2).length >= MIN_FOLLOWUP_CHARS ? normBody(lead.email_2) : ""),
  };
}
const short = (s) => (s.length > 70 ? s.slice(0, 67) + "..." : s);
const day = (d) => String(d).slice(0, 10);

// hits: rows of copy_uniqueness_hits(); returns errors[] for one lead's texts.
export function uniquenessErrors(texts, hits) {
  const key = (k, t) => k + "\u0001" + t;
  const m = new Map(hits.map((h) => [key(h.kind, h.txt), h]));
  const errs = [];
  for (const s of texts.s) {
    const h = m.get(key("s", s));
    if (!h) continue;
    errs.push(h.src === "sent"
      ? `Sentence already used in an email sent on ${day(h.first_seen)}: '${short(s)}'`
      : `Sentence already used in another active lead's email (list "${h.list_name}"): '${short(s)}'`);
  }
  if (texts.b) {
    const h = m.get(key("b", texts.b));
    if (h) errs.push(h.src === "sent"
      ? `Follow-up already used in an email sent on ${day(h.first_seen)}: '${short(texts.b)}'`
      : `Follow-up is already used by another active lead (list "${h.list_name}"): '${short(texts.b)}'`);
  }
  return errs;
}
