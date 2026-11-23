// CSV import engine (no DOM, no network): parse, auto-map columns, validate, find duplicates, build dial rows.
// Used by js/importWizard.js (the Import dialog) and by tools/testenv/import_unit.test.mjs.
// Behavior for CSVs that import today is unchanged: same aliases (plus more), same status mapping, same row shape.
import { STATES, stateToCode } from "./clientForm.js";

// ---------------------------------------------------------------------------
// Parser: RFC4180-ish. Handles a BOM, CRLF / LF / lone CR line ends, quoted fields with commas, newlines and "" quotes,
// and comma / semicolon / tab delimiters (Excel in some locales exports ";"). Returns an array of string arrays.
// ---------------------------------------------------------------------------
export function sniffDelimiter(text) {
  // Look at the first line outside quotes.
  let q = false, counts = { ",": 0, ";": 0, "\t": 0 };
  for (let i = 0; i < text.length && i < 20000; i++) {
    const c = text[i];
    if (c === '"') q = !q;
    else if (!q && (c === "\n" || c === "\r")) break;
    else if (!q && c in counts) counts[c]++;
  }
  let best = ",", n = counts[","];
  for (const d of [";", "\t"]) if (counts[d] > n) { best = d; n = counts[d]; }
  return best;
}

// A quote only OPENS a quoted field at the start of a field (so Joe's 5" Pipe Co is plain text). `literal` = never open one.
function scan(text, delim, literal) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false, atStart = true, unclosed = false;
  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue; // closes; anything glued after it (ABC "The Best" Plumbing) just continues the field
      }
      const next = text.indexOf('"', i);
      if (next === -1) { field += text.slice(i); i = len; unclosed = true; break; }
      field += text.slice(i, next); i = next; continue;
    }
    if (ch === '"' && atStart && !literal) { inQuotes = true; atStart = false; i++; continue; }
    if (ch === delim) { row.push(field); field = ""; atStart = true; i++; continue; }
    if (ch === "\r") {
      row.push(field); rows.push(row); row = []; field = ""; atStart = true;
      i += text[i + 1] === "\n" ? 2 : 1; continue;
    }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; atStart = true; i++; continue; }
    field += ch; atStart = false; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return { rows, unclosed };
}
const ragged = (rows) => { const n = rows[0] ? rows[0].length : 0; return rows.filter((r) => r.length !== n && r.some((c) => c.trim() !== "")).length; };

// Returns an array of string arrays; `.warnings` lists anything odd (an unbalanced quote that was read as plain text).
export function parseCSV(text, delimiter) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = delimiter || sniffDelimiter(text);
  let { rows, unclosed } = scan(text, delim, false);
  const warnings = [];
  if (unclosed || ragged(rows) > Math.max(2, rows.length * 0.05)) {
    // A stray quote swallowed part of the file. Re-read treating every quote as plain text; keep whichever reads cleaner.
    const alt = scan(text, delim, true).rows;
    if (unclosed || ragged(alt) < ragged(rows)) {
      rows = alt;
      warnings.push("This file has a quote mark that is not closed, so quotes were read as plain text. Check the preview rows.");
    }
  }
  Object.defineProperty(rows, "warnings", { value: warnings, enumerable: false }); // not enumerable: the result still compares equal to a plain array
  return rows;
}

// ---------------------------------------------------------------------------
// Fields and header aliases
// ---------------------------------------------------------------------------
export const DIAL_FIELD_ALIASES = {
  full_name: ["full name", "fullname", "name", "client name", "contact name", "owner name", "owner", "contact", "person", "decision maker", "lead name", "primary contact"],
  first_name: ["first name", "firstname", "first", "given name", "owner first name"],
  last_name: ["last name", "lastname", "last", "surname", "family name", "owner last name"],
  company_name: ["company name", "company", "business name", "business", "organization", "organisation", "org", "account name", "account", "firm", "employer", "dba", "company legal name", "legal name", "biz", "biz name", "co", "co name", "company account", "company or account", "practice", "practice name", "store name"],
  email: ["email", "email address", "e mail", "e mail address", "owner email", "primary email", "work email", "contact email", "email addr", "emails"],
  // "Mobie number" is a real observed header typo; the fuzzy matcher below would also catch it.
  mobile_phone: ["mobile phone", "mobile", "cell phone", "cell", "phone", "phone number", "phone mobile", "mobile number", "mobie number", "cell number", "owner mobile", "owner phone", "direct phone", "direct dial", "personal phone", "mobile phone number", "telephone", "tel", "phone 1"],
  company_phone: ["company phone", "office phone", "business phone", "work phone", "phone website", "company number", "main phone", "main line", "office number", "business number", "company phone number", "hq phone", "main number", "phone 2", "phone maps"],
  linkedin: ["linkedin", "linkedin url", "linkedin profile", "linkedin link", "owner linkedin", "linked in"],
  city: ["city", "town"],
  state: ["state", "st", "state province", "state code", "state abbreviation"],
  website: ["website", "url", "web site", "web address", "business url", "site", "homepage", "company website", "website url", "domain", "web"],
  industry: ["industry", "industry sector", "sector", "mandate industry sector", "mandate", "trade", "vertical", "category"],
  summary: ["summary", "notes", "description", "about", "company summary", "bio"],
  call_notes: ["call notes", "callnotes", "call note"],
  contact_status: ["status"],
  email_1_greeting: ["email 1 greeting"],
  email_1_pitch: ["email 1 pitch"],
  email_1_cta: ["email 1 cta", "email 1 call to action"],
  email_subject: ["subject", "email subject", "subject line", "email 1 subject", "first email subject", "subject 1", "email subject line"],
  email_1: ["email 1", "email1", "email 1 body", "first email", "first email body", "email body", "email one"],
  email_2: ["email 2", "email2", "follow up", "followup", "follow up email", "followup email", "follow up body", "second email", "email two"],
  email_2_greeting: ["email 2 greeting"],
  email_2_body: ["email 2 body"],
};

// Human labels for the mapping dropdown, in display order. `full_name` etc. are what the lead card shows.
export const FIELD_LABELS = {
  full_name: "Full name", first_name: "First name", last_name: "Last name", company_name: "Company name",
  email: "Email", mobile_phone: "Mobile number", company_phone: "Company number", linkedin: "LinkedIn",
  city: "City", state: "State", website: "Website", industry: "Industry sector", summary: "Summary",
  call_notes: "Call notes", contact_status: "Status", email_subject: "Email subject", email_1: "Email 1 (first email)",
  email_2: "Email 2 (follow-up)", email_1_greeting: "Email 1 greeting", email_1_pitch: "Email 1 pitch",
  email_1_cta: "Email 1 call to action", email_2_greeting: "Email 2 greeting", email_2_body: "Email 2 body",
};

export const CSV_STATUS_VALUE_MAP = {
  "": "uncontacted",
  "passed/dead": "not_interested",
  "scheduling intro": "intro_call_scheduled",
  "call unanswered": "no_response",
  "not a fit": "not_interested",
  "completed outreach": "unable_to_contact",
  "busy, call back": "busy_callback",
  "busy call back": "busy_callback",
  "busy": "busy_callback",
  "follow-up": "no_response",
  "follow up": "no_response",
};
const normalizeStatusValue = (v) => String(v || "").trim().toLowerCase();

export function normalizeHeader(h) {
  return String(h || "").replace(/^﻿/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

// "Status" is matched loosely (any "... status" header), but not when the header is about something else
// (an email-verification status, a mobile status, a sequence status).
const NOT_DIAL_STATUS = /\b(email|e mail|mail|mv|verif\w*|phone|mobile|cell|enrich\w*|copy|sequence|seq|mailbox|bounce\w*)\b/;
function headerMatchesField(field, aliases, norm) {
  if (field === "contact_status") return norm.includes("status") && !NOT_DIAL_STATUS.test(norm);
  return aliases.some((a) => normalizeHeader(a) === norm);
}

function editDistance(a, b, max) {
  // Optimal string alignment: insert / delete / substitute / swap two neighbours each cost 1.
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}

// Typo tolerance for headers that match no alias ("Compny Name", "Emial", "Mobil Number"). Headers with digits never
// fuzzy match ("Email 1" must not become "Email"); short words need an exact hit.
function fuzzyField(norm, usedFields) {
  if (/\d/.test(norm) || norm.length < 5) return null;
  const max = norm.length >= 10 ? 2 : 1;
  let best = null, bestD = max + 1;
  for (const [field, aliases] of Object.entries(DIAL_FIELD_ALIASES)) {
    if (usedFields.has(field) || field === "contact_status") continue;
    for (const a of aliases) {
      const na = normalizeHeader(a);
      if (/\d/.test(na) || na.length < 5) continue;
      const d = editDistance(norm, na, max);
      if (d < bestD) { bestD = d; best = field; }
    }
  }
  return best;
}

const looksEmail = (v) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v.trim());
const looksLinkedin = (v) => /linkedin\.com\//i.test(v);
const looksUrl = (v) => /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v.trim()) && !looksEmail(v);
const looksState = (v) => /^[A-Za-z]{2}$/.test(v.trim()) && !!STATE_ABBREVIATIONS[v.trim().toUpperCase()];
const looksPhone = (v) => { const d = v.replace(/\D/g, ""); return d.length >= 10 && d.length <= 11 && /^[\d\s().+\-x]+$/i.test(v.trim()); };

// Auto-map: returns { map: {colIndex: field}, how: {colIndex: "header"|"typo"|"contents"}, headers: [...] }.
// Existing behavior is preserved: exact alias matches run first in the same order as before (first matching header wins
// per field); typo matches and content sniffing only fill fields no header claimed.
export function autoMapColumns(headerRow, dataRows = []) {
  const map = {}, how = {};
  const used = new Set();
  headerRow.forEach((raw, ci) => {
    const norm = normalizeHeader(raw);
    if (!norm) return;
    for (const [field, aliases] of Object.entries(DIAL_FIELD_ALIASES)) {
      if (used.has(field)) continue;
      if (headerMatchesField(field, aliases, norm)) { map[ci] = field; how[ci] = "header"; used.add(field); break; }
    }
  });
  headerRow.forEach((raw, ci) => {
    if (map[ci] !== undefined) return;
    const norm = normalizeHeader(raw);
    if (!norm) return;
    const f = fuzzyField(norm, used);
    if (f) { map[ci] = f; how[ci] = "typo"; used.add(f); }
  });
  // Content sniff for columns nobody could name (a header-less export, "Column 7", a header like "Contact info").
  const sample = dataRows.slice(0, 200);
  headerRow.forEach((raw, ci) => {
    if (map[ci] !== undefined) return;
    const vals = sample.map((r) => String(r[ci] || "").trim()).filter(Boolean);
    if (vals.length < 3) return;
    const share = (fn) => vals.filter(fn).length / vals.length;
    let f = null;
    if (!used.has("email") && share(looksEmail) >= 0.8) f = "email";
    else if (!used.has("linkedin") && share(looksLinkedin) >= 0.8) f = "linkedin";
    else if (!used.has("website") && share((v) => looksUrl(v) && !looksLinkedin(v)) >= 0.8) f = "website";
    else if (!used.has("state") && share(looksState) >= 0.9) f = "state";
    else if (!used.has("mobile_phone") && share(looksPhone) >= 0.8) f = "mobile_phone";
    if (f) { map[ci] = f; how[ci] = "contents"; used.add(f); }
  });
  return { map, how };
}

// Back-compat name used by older callers/tests.
export function buildHeaderFieldMap(headerRow) { return autoMapColumns(headerRow).map; }

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
export const STATE_ABBREVIATIONS = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
};
export function normalizeStateValue(raw) {
  const v = String(raw || "").trim();
  if (!v) return v;
  // One format everywhere: the 2-letter code ("UT"). "Not in the US" and anything that is not a US state stay as typed.
  const byAbbreviation = STATE_ABBREVIATIONS[v.toUpperCase()];
  if (byAbbreviation) return stateToCode(byAbbreviation);
  const byName = STATES.find((s) => s.toLowerCase() === v.toLowerCase());
  return byName ? stateToCode(byName) : v;
}

const EMAIL_FIND = /[^\s<>"';,()]+@[^\s<>"';,()]+\.[a-z]{2,}/i;
// Same shape rules as the database (is_personal_email): well-formed, and not a role mailbox like info@.
const ROLE_LOCAL = /^(info|sales|office|admin|support|contact|hello|team|service|services|help|billing|accounts?|hr|jobs|careers|marketing|mail|enquiries|inquiries|reception|frontdesk|noreply|no-reply|webmaster|orders?)$/i;
export const isValidEmail = (e) => looksEmail(e || "");
export const isPersonalEmail = (e) => isValidEmail(e) && !ROLE_LOCAL.test(String(e).split("@")[0]);
export const normEmail = (e) => {
  const t = String(e || "").trim().toLowerCase();
  if (!t.includes("@")) return t;
  let [local, dom] = [t.split("@")[0], t.split("@")[1]];
  local = local.split("+")[0];
  if (dom === "gmail.com" || dom === "googlemail.com") local = local.replace(/\./g, "");
  return `${local}@${dom}`;
};
// "mailto:x@y.com", "<x@y.com>", "Jane <x@y.com>", "a@b.com; c@d.com" -> the first address. Anything else stays as written.
export function cleanEmailCell(v) {
  const m = String(v || "").replace(/^mailto:/i, "").match(EMAIL_FIND);
  return m ? m[0].replace(/^mailto:/i, "") : String(v || "").trim();
}
export const phoneDigits = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return d;
};
export const phoneKey = (p) => { const d = phoneDigits(p); return d.length >= 10 ? d.slice(-10) : ""; };
const nameKey = (s) => String(s || "").toLowerCase().replace(/\b(llc|inc|corp|co|ltd|company|the|and)\b/g, " ").replace(/[^a-z0-9]+/g, "");

// ---------------------------------------------------------------------------
// Rows -> dial insert objects
// ---------------------------------------------------------------------------
// `mapping` is {colIndex: field}. `rows` includes the header at index 0 unless opts.noHeader. Blank rows are skipped.
export function buildDials(rows, mapping, listId, opts = {}) {
  const start = opts.noHeader ? 0 : 1;
  const out = [];
  for (let ri = start; ri < rows.length; ri++) {
    const r = rows[ri];
    if (!r.some((cell) => (cell || "").trim() !== "")) continue;
    const d = rowToDial(r, mapping, listId);
    d.__row = ri + 1; // 1-based CSV line (header = 1); stripped before insert
    out.push(d);
  }
  return out;
}

function rowToDial(r, mapping, listId) {
  const d = { list_id: listId, contact_status: "uncontacted" };
  for (const colIndex in mapping) {
    const field = mapping[colIndex];
    if (!field) continue;
    const v = (r[Number(colIndex)] || "").trim();
    if (field === "contact_status") {
      const norm = normalizeStatusValue(v);
      if (CSV_STATUS_VALUE_MAP[norm]) d.contact_status = CSV_STATUS_VALUE_MAP[norm];
      else if (norm.includes("nda") || norm.includes("loi")) d.contact_status = "intro_call_scheduled";
      else d.contact_status = "uncontacted";
      continue;
    }
    if (v && field === "email") {
      d.email = cleanEmailCell(v).toLowerCase();
      const all = new Set((v.match(new RegExp(EMAIL_FIND.source, "gi")) || []).map((x) => x.toLowerCase()));
      if (all.size > 1) d.__extra_email = true; // "a@x.com; b@x.com": the first is kept, the preview says so
    } else if (v) d[field] = v;
  }
  if (!d.full_name) {
    const combined = `${d.first_name || ""} ${d.last_name || ""}`.trim();
    if (combined) d.full_name = combined;
  }
  delete d.first_name; delete d.last_name;
  const compile = (...parts) => parts.filter(Boolean).join("\n\n");
  const email1 = compile(d.email_1_greeting, d.email_1_pitch, d.email_1_cta);
  const email2 = compile(d.email_2_greeting, d.email_2_body);
  if (email1) d.email_1 = email1;
  if (email2) d.email_2 = email2;
  delete d.email_1_greeting; delete d.email_1_pitch; delete d.email_1_cta; delete d.email_2_greeting; delete d.email_2_body;
  if (d.state) d.state = normalizeStateValue(d.state);
  // An email that is not an address ("n/a", "bad@") is never saved into the lead; it is counted as invalid in the preview.
  if (d.email && !isValidEmail(d.email)) { d.__bad_email = d.email; delete d.email; }
  // Same number under mobile and company: saved once, flagged "(Unsure)". Always set (bulk insert sends one column list).
  const md = (d.mobile_phone || "").replace(/\D/g, "");
  const cd = (d.company_phone || "").replace(/\D/g, "");
  d.mobile_phone_unsure = Boolean(md) && md === cd;
  if (d.mobile_phone_unsure) delete d.company_phone;
  return d;
}

// Back-compat: the old one-shot entry point (auto-mapped).
export function rowsToDials(rows, listId) {
  if (rows.length < 2) return [];
  const { map } = autoMapColumns(rows[0], rows.slice(1));
  return buildDials(rows, map, listId).map(stripInternal);
}
export function stripInternal(d) { const rest = {}; for (const k of Object.keys(d)) if (!k.startsWith("__")) rest[k] = d[k]; return rest; }

// ---------------------------------------------------------------------------
// Validation + duplicate detection
// ---------------------------------------------------------------------------
// dials: output of buildDials. Returns counts for the preview and per-row flags.
export function validateDials(dials) {
  const s = {
    total: dials.length, with_personal_email: 0, backup: 0, no_email: 0, bad_email: 0, role_email: 0, multi_email: 0,
    with_mobile: 0, with_company_phone: 0, no_phone: 0, bad_phone: 0, no_contact: 0, no_name: 0,
    email_missing_copy: 0, email_has_copy: 0, copy_columns: false,
    status_values: 0,
  };
  const seenCols = { email_1: false, email_subject: false };
  for (const d of dials) {
    const hasEmail = !!d.email;
    if (d.__extra_email) s.multi_email++;
    if (d.__bad_email) s.bad_email++;
    else if (hasEmail && !isPersonalEmail(d.email)) s.role_email++;
    if (isPersonalEmail(d.email)) {
      s.with_personal_email++;
      const copy = (d.email_1 || "").trim() && (d.email_subject || "").trim();
      if (copy) s.email_has_copy++; else s.email_missing_copy++;
    } else s.backup++;
    if (!hasEmail) s.no_email++;
    if (d.mobile_phone) { s.with_mobile++; if (phoneDigits(d.mobile_phone).length < 10 || phoneDigits(d.mobile_phone).length > 15) s.bad_phone++; }
    if (d.company_phone) { s.with_company_phone++; if (phoneDigits(d.company_phone).length < 10 || phoneDigits(d.company_phone).length > 15) s.bad_phone++; }
    if (!d.mobile_phone && !d.company_phone) s.no_phone++;
    if (!d.mobile_phone && !d.company_phone && !hasEmail) s.no_contact++;
    if (!d.full_name && !d.company_name) s.no_name++;
    if (d.email_1) seenCols.email_1 = true;
    if (d.email_subject) seenCols.email_subject = true;
  }
  s.copy_columns = seenCols.email_1 || seenCols.email_subject;
  return s;
}

// In-file duplicates. A row is a duplicate of an earlier row when it shares a normalized email, a 10-digit mobile,
// or (same company name AND same city when both are given). Returns Map(dialIndex -> {of: dialIndex, why}).
export function findFileDuplicates(dials) {
  const byEmail = new Map(), byMobile = new Map(), byCo = new Map();
  const dup = new Map();
  dials.forEach((d, i) => {
    let why = null, of = null;
    const ek = d.email && isValidEmail(d.email) ? normEmail(d.email) : "";
    const mk = phoneKey(d.mobile_phone);
    const ck = d.company_name ? `${nameKey(d.company_name)}|${String(d.city || "").toLowerCase().trim()}` : "";
    if (ek && byEmail.has(ek)) { of = byEmail.get(ek); why = "same email"; }
    else if (mk && byMobile.has(mk)) { of = byMobile.get(mk); why = "same mobile number"; }
    else if (ck && ck.length > 3 && byCo.has(ck)) { of = byCo.get(ck); why = "same company and city"; }
    if (why) dup.set(i, { of, why });
    if (ek && !byEmail.has(ek)) byEmail.set(ek, i);
    if (mk && !byMobile.has(mk)) byMobile.set(mk, i);
    if (ck && ck.length > 3 && !byCo.has(ck)) byCo.set(ck, i);
  });
  return dup;
}

// Keys to send to the server duplicate check (import_dup_check).
export function dupCheckKeys(dials) {
  const emails = new Set(), phones = new Set();
  for (const d of dials) {
    if (d.email && isValidEmail(d.email)) emails.add(String(d.email).trim().toLowerCase());
    for (const p of [d.mobile_phone, d.company_phone]) { const k = phoneKey(p); if (k) phones.add(k); }
  }
  return { emails: [...emails], phones: [...phones] };
}

// serverHits: array of {kind:"email"|"phone", key, list_id, list_name, owner_name, contact_status}. Returns Map(dialIndex -> hit).
export function matchServerDuplicates(dials, serverHits) {
  const em = new Map(), ph = new Map();
  for (const h of serverHits || []) (h.kind === "email" ? em : ph).set(h.key, h);
  const out = new Map();
  dials.forEach((d, i) => {
    const ek = d.email && isValidEmail(d.email) ? normEmail(d.email) : "";
    let hit = ek && em.get(ek);
    if (!hit) for (const p of [d.mobile_phone, d.company_phone]) { const k = phoneKey(p); if (k && ph.get(k)) { hit = ph.get(k); break; } }
    if (hit) out.set(i, hit);
  });
  return out;
}

// One-call analysis for a parsed file.
export function analyzeFile(text, fileName) {
  const t0 = performance.now();
  const parsed = parseCSV(text);
  const all = parsed.filter((r) => r.some((c) => (c || "").trim() !== ""));
  const headers = all[0] || [];
  const dataRows = all.slice(1);
  const blankRows = 0;
  const { map, how } = autoMapColumns(headers, dataRows);
  return { fileName, warnings: parsed.warnings || [], binary: /[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 2000)), rows: all, headers, dataRows, map, how, blankRows, parseMs: Math.round(performance.now() - t0) };
}

// Mapping must give the caller something to work with.
export function mappingProblems(map) {
  const f = new Set(Object.values(map).filter(Boolean));
  const p = [];
  if (!f.size) p.push("No columns matched. Pick what each column is below.");
  else {
    if (!f.has("company_name") && !f.has("full_name") && !f.has("first_name")) p.push("No name or company column mapped.");
    if (!f.has("mobile_phone") && !f.has("company_phone") && !f.has("email")) p.push("No phone or email column mapped.");
  }
  return p;
}

// Not blocking, but worth a visible line: leads would be saved without a company name.
export function mappingNotes(map) {
  const f = new Set(Object.values(map).filter(Boolean));
  return f.size && !f.has("company_name") ? ["No Company name column is mapped, so these leads would be saved with no company. Pick the right column below."] : [];
}
