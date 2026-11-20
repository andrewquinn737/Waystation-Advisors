// Pure lint functions for uploaded email copy (no DOM, no network, node-testable:
// tools/testenv/copyLint.test.mjs). Used by js/copyReview.js.
//
// WORD COUNT RULE: email_1 is counted as the BODY ONLY. The greeting line ("Hi Pat,") and the
// sign-off block (a closing phrase like "Best," / "Thanks," and every line after it, i.e. the
// sender's name/title) are NOT counted. Hard limit: 85 words.
//
// Lead shape: { id, full_name, company_name, email_subject, email_1, email_2 }.
// Results: { errors: string[], warnings: string[] } per lead.

export const MAX_WORDS = 85;
export const MAX_SUBJECT = 60;
const MIN_SENTENCE_WORDS = 5; // shorter sentences ("Thanks.", "Worth a chat?") may legitimately repeat

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
export const normNewlines = (t) => str(t).replace(/\r\n?/g, "\n");
const blank = (v) => str(v).trim() === "";
const stripAccents = (s) => str(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
const normWord = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]/g, "");

const GREETING_RE = /^(hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\b[^.!?\n]{0,60}$/i;
const SIGNOFF_RE = /^(best|best regards|kind regards|warm regards|regards|thanks|thank you|many thanks|cheers|sincerely|respectfully|talk soon|all the best|take care|appreciate it|thanks again)\s*[,.!]?$/i;

// Split an email into { greeting, body, signoff } (strings). CRLF-safe.
export function splitEmail(text) {
  const lines = normNewlines(text).split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  let greeting = "";
  if (start < lines.length && GREETING_RE.test(lines[start].trim())) {
    greeting = lines[start].trim();
    start++;
  }
  let end = lines.length;
  let signoff = "";
  for (let i = lines.length - 1; i >= start && i >= lines.length - 6; i--) {
    if (SIGNOFF_RE.test(lines[i].trim())) {
      signoff = lines.slice(i).join("\n").trim();
      end = i;
      break;
    }
  }
  return { greeting, body: lines.slice(start, end).join("\n").trim(), signoff };
}

export function wordCount(text) {
  const t = str(text).trim();
  return t ? t.split(/\s+/).length : 0;
}
export const bodyWordCount = (email) => wordCount(splitEmail(email).body);

const normSentence = (s) =>
  stripAccents(s).toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

// Normalized sentences (>= MIN_SENTENCE_WORDS words) of the body, greeting/sign-off excluded.
export function bodySentences(email) {
  const { body } = splitEmail(email);
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normSentence)
    .filter((s) => s.split(" ").length >= MIN_SENTENCE_WORDS);
}
export const normBody = (email) => normSentence(splitEmail(email).body);

const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\{[^{}\n]{1,40}\}|\[[^\]\n]{1,40}\]|<(?![a-z]+:\/\/)[A-Za-z_ ]{1,30}>|%[A-Za-z_]{2,30}%/;
const DASH_RE = /[–—―]/;
const LINK_RE = /https?:\/\/|\bwww\./i;
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir"]);
const GENERIC_GREETEES = new Set(["there", "team", "all", "everyone", "folks", "friends", "and", "&"]);

export function firstNameOf(fullName) {
  const parts = str(fullName).trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && TITLES.has(normWord(parts[0]))) parts.shift();
  return parts[0] || "";
}

// Names mentioned in the greeting line ("Hi Pat and Sam," -> ["pat","sam"]); [] if none.
function greetingNames(greeting) {
  const m = str(greeting).match(/^(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\b[\s,]*(.*)$/i);
  if (!m) return [];
  return m[1].split(/[\s,:!]+/).map(normWord).filter((w) => w && !GENERIC_GREETEES.has(w));
}

const COMPANY_SUFFIX = new Set(["inc", "llc", "co", "corp", "corporation", "company", "ltd", "lp", "llp", "pc", "plc", "the"]);
export function companyCore(name) {
  const words = stripAccents(name).toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  while (words.length > 1 && COMPANY_SUFFIX.has(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === "the") words.shift();
  return words.join(" ");
}

function textFields(lead) {
  return [["Subject", lead.email_subject], ["Email 1", lead.email_1], ["Follow-up", lead.email_2]];
}

// Per-lead rules (no cross-lead context).
export function lintLead(lead) {
  const errors = [];
  const warnings = [];
  if (blank(lead.email_subject)) errors.push("Missing subject");
  if (blank(lead.email_1)) errors.push("Missing Email 1");
  if (blank(lead.email_2)) errors.push("Missing follow-up");

  for (const [label, v] of textFields(lead)) {
    if (blank(v)) continue;
    const ph = normNewlines(v).match(PLACEHOLDER_RE);
    if (ph) errors.push(`${label} has an unfilled placeholder: ${ph[0]}`);
    if (DASH_RE.test(v)) errors.push(`${label} contains an em/en dash`);
  }
  if (!blank(lead.email_1)) {
    const n = bodyWordCount(lead.email_1);
    if (n > MAX_WORDS) errors.push(`Email 1 is ${n} words (max ${MAX_WORDS}, greeting and sign-off not counted)`);
  }

  // warnings
  const first = normWord(firstNameOf(lead.full_name));
  if (first) {
    for (const [label, v] of [["Email 1", lead.email_1], ["Follow-up", lead.email_2]]) {
      if (blank(v)) continue;
      const { greeting } = splitEmail(v);
      if (!greeting) continue;
      const names = greetingNames(greeting);
      if (names.length && !names.includes(first)) {
        warnings.push(`${label} greeting says "${greeting.replace(/[,:!]+$/, "")}" but the lead is ${firstNameOf(lead.full_name)}`);
      }
    }
  }
  if (!blank(lead.email_subject) && lead.email_subject.trim().length > MAX_SUBJECT) {
    warnings.push(`Subject is ${lead.email_subject.trim().length} characters (aim for ${MAX_SUBJECT} or fewer)`);
  }
  if (LINK_RE.test(str(lead.email_1)) || LINK_RE.test(str(lead.email_2))) warnings.push("Contains a link");
  return { errors, warnings };
}

// Lint a whole list: per-lead rules + cross-lead repetition + company-name slips.
// Returns Map(id -> { errors, warnings }).
export function lintBatch(leads) {
  const out = new Map();
  for (const l of leads) out.set(l.id, lintLead(l));

  // identical sentences across different leads' email_1
  const bySentence = new Map();
  for (const l of leads) {
    for (const s of new Set(bodySentences(l.email_1))) {
      if (!bySentence.has(s)) bySentence.set(s, []);
      bySentence.get(s).push(l.id);
    }
  }
  for (const [s, ids] of bySentence) {
    if (ids.length < 2) continue;
    const shown = s.length > 70 ? s.slice(0, 67) + "..." : s;
    for (const id of ids) out.get(id).errors.push(`Same sentence is in ${ids.length - 1} other lead email(s): "${shown}"`);
  }

  // identical follow-up body across leads
  const byFollow = new Map();
  for (const l of leads) {
    const b = normBody(l.email_2);
    if (!b) continue;
    if (!byFollow.has(b)) byFollow.set(b, []);
    byFollow.get(b).push(l.id);
  }
  for (const ids of byFollow.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) out.get(id).errors.push(`Follow-up is identical in ${ids.length - 1} other lead(s)`);
  }

  // another lead's company name inside this lead's copy (copy/paste slip)
  const names = new Map(); // core -> Set(ids)
  for (const l of leads) {
    const core = companyCore(l.company_name);
    if (!core) continue;
    if (!core.includes(" ") && core.length < 6) continue; // too generic to trust
    if (!names.has(core)) names.set(core, new Set());
    names.get(core).add(l.id);
  }
  for (const l of leads) {
    const own = companyCore(l.company_name);
    const found = new Set();
    for (const [label, v] of [["Email 1", l.email_1], ["Follow-up", l.email_2]]) {
      const words = normSentence(str(v).replace(/['\u2019]/g, "")).split(" ").filter(Boolean);
      for (let i = 0; i < words.length; i++) {
        for (let n = 1; n <= 5 && i + n <= words.length; n++) {
          const gram = words.slice(i, i + n).join(" ");
          const ids = names.get(gram);
          if (!ids || ids.has(l.id)) continue;
          if (own && (own.includes(gram) || gram.includes(own))) continue;
          found.add(`${label} mentions "${gram}", which is another lead's company`);
        }
      }
    }
    for (const w of found) out.get(l.id).warnings.push(w);
  }
  return out;
}

export function summarize(results) {
  let ready = 0, errors = 0, warnings = 0;
  for (const r of results.values()) {
    if (r.errors.length) errors++;
    else ready++;
    if (r.warnings.length) warnings++;
  }
  return { total: results.size, ready, errors, warnings };
}
