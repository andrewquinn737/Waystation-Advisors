// Spintax + merge-tag expander for campaigns (pure JS: runs in the claude-connector edge function and in node tests,
// tools/testenv/spintax.test.mjs). Claude DESIGNS the pools; this code EXPANDS them. Never shipped to a recipient as braces.
//
//   {a|b|c}          pick one option (options may contain merge tags or nested groups, e.g. {a|{b|c}d})
//   {{first_name}}   merge tags: first_name, company, city (filled from the lead; a lead missing one is skipped, not guessed)
//
// Expansion is deterministic (seeded per lead) and picks WITHOUT replacement across the list: every group tracks how
// often each option was used and each lead takes the least-used option among several seeded candidates, while
// candidates that would repeat a sentence already used by another lead (the copy gate's hard rule) are avoided.
import { bodySentences, normBody } from "./copyLint.js";

export const MERGE_TAGS = ["first_name", "company", "city"];
export class SpintaxError extends Error {}
const MAX_DEPTH = 4;
const DASH_RE = /[–—―]/;

// ---------------------------------------------------------------- parse
// AST: {t:'text',v} | {t:'tag',v} | {t:'grp',id,opts:[nodes[]]}
export function parse(src) {
  const s = String(src ?? "");
  let i = 0, gid = 0;
  const near = () => JSON.stringify(s.slice(Math.max(0, i - 12), i + 18));
  function seq(inGroup, depth) {
    const nodes = []; let buf = "";
    const flush = () => { if (buf) { nodes.push({ t: "text", v: buf }); buf = ""; } };
    while (i < s.length) {
      const c = s[i];
      if (c === "{") {
        if (s[i + 1] === "{") {
          const m = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/.exec(s.slice(i));
          if (!m) throw new SpintaxError(`Bad merge tag near ${near()}. Merge tags look like {{first_name}}. (A group can't start right after another "{": put a word before it.)`);
          const name = m[1].toLowerCase();
          if (!MERGE_TAGS.includes(name)) throw new SpintaxError(`Unknown merge tag {{${m[1]}}}. Allowed tags: ${MERGE_TAGS.map((t) => `{{${t}}}`).join(", ")}.`);
          flush(); nodes.push({ t: "tag", v: name }); i += m[0].length; continue;
        }
        if (depth >= MAX_DEPTH) throw new SpintaxError(`Spintax groups are nested too deeply near ${near()}.`);
        flush(); i++;
        const id = gid++, opts = [];
        for (;;) {
          const o = seq(true, depth + 1);
          if (i >= s.length) throw new SpintaxError(`Unbalanced braces: a "{" is never closed (near ${near()}).`);
          if (!o.length || o.every((n) => n.t === "text" && n.v.trim() === "")) throw new SpintaxError(`Empty option in a {a|b} group near ${near()}. Remove the stray "|".`);
          opts.push(o);
          if (s[i] === "|") { i++; continue; }
          i++; break; // "}"
        }
        if (opts.length < 2) throw new SpintaxError(`A group needs at least two options like {a|b}, found one near ${near()}. For merge tags use {{first_name}}, {{company}} or {{city}}.`);
        nodes.push({ t: "grp", id, opts });
      } else if (c === "}") {
        if (!inGroup) throw new SpintaxError(`Unbalanced braces: a "}" has no matching "{" (near ${near()}).`);
        break;
      } else if (c === "|") {
        if (!inGroup) throw new SpintaxError(`Stray "|" outside a {a|b} group (near ${near()}).`);
        break;
      } else { buf += c; i++; }
    }
    flush();
    return nodes;
  }
  const nodes = seq(false, 0);
  return { nodes, groups: gid };
}

// text-level checks that would fail every lead anyway
export function checkTemplateText(label, src) {
  const errs = [];
  const s = String(src ?? "");
  if (!s.trim()) errs.push(`${label} is empty.`);
  if (DASH_RE.test(s)) errs.push(`${label} contains an em/en dash. Use a period, comma or "but".`);
  if (s.length > 8000) errs.push(`${label} is too long.`);
  return errs;
}

export function tagsUsed(nodes, set = new Set()) {
  for (const n of nodes) { if (n.t === "tag") set.add(n.v); else if (n.t === "grp") n.opts.forEach((o) => tagsUsed(o, set)); }
  return set;
}
// distinct renderings (capped)
export function capacity(nodes) {
  const CAP = 1e12;
  let total = 1;
  for (const n of nodes) {
    if (n.t !== "grp") continue;
    let sum = 0;
    for (const o of n.opts) sum += capacity(o);
    total = Math.min(CAP, total * sum);
  }
  return total;
}

// ---------------------------------------------------------------- lead data
const SUFFIX = /[\s,]+(inc|llc|l\.l\.c|co|corp|corporation|company|ltd|lp|llp|pc|plc)\.?$/i;
export function displayCompany(name) {
  let t = String(name ?? "").trim().replace(/\s+/g, " ");
  for (let k = 0; k < 3 && SUFFIX.test(t) && t.replace(SUFFIX, "").trim(); k++) t = t.replace(SUFFIX, "").trim();
  t = t.replace(/[,.]+$/, "");
  if (t.length > 3 && t === t.toUpperCase()) t = t.toLowerCase().replace(/(^|[\s&'-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
  return t;
}
export function displayFirst(fullName) {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && /^(mr|mrs|ms|miss|dr|prof|sir)\.?$/i.test(parts[0])) parts.shift();
  let f = parts[0] || "";
  if (f && (f === f.toUpperCase() || f === f.toLowerCase())) f = f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
  return f;
}
export const tagValues = (lead) => ({ first_name: displayFirst(lead.full_name), company: displayCompany(lead.company_name), city: String(lead.city ?? "").trim() });

// ---------------------------------------------------------------- rng
function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function mulberry(a) { return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// render one template: pick(gid, n) -> option index; rec(gid, idx) is called for every pick
function render(nodes, tags, pick, rec) {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "tag") out += tags[n.v];
    else { const k = pick(n.id, n.opts.length); rec(n.id, k); out += render(n.opts[k], tags, pick, rec); }
  }
  return out;
}
const tidy = (t) => t.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").replace(/ +([,.!?])/g, "$1").trim();

// ---------------------------------------------------------------- expand a list
// templates: { subjects: string[], email1: string, followup: string }
// leads: [{id, full_name, company_name, city}]. Returns { ok, errors[], warnings[], rows[], skipped[], capacity }.
export function expandList(templates, leads, { seed = "x", tries = 24 } = {}) {
  const errors = [], warnings = [];
  const pools = Array.isArray(templates.subjects) ? templates.subjects : [];
  if (!pools.length) errors.push("subject_pools needs at least one subject.");
  if (pools.length > 20) errors.push("subject_pools can have at most 20 entries.");
  errors.push(...checkTemplateText("email1_template", templates.email1), ...checkTemplateText("followup_template", templates.followup));
  pools.forEach((p, k) => errors.push(...checkTemplateText(`subject_pools[${k}]`, p)));
  const parsed = { subjects: [], email1: null, followup: null };
  const tryParse = (label, src) => { try { return parse(src); } catch (e) { if (e instanceof SpintaxError) { errors.push(`${label}: ${e.message}`); return null; } throw e; } };
  pools.forEach((p, k) => { const a = tryParse(`subject_pools[${k}]`, p); if (a) parsed.subjects.push(a); });
  parsed.email1 = tryParse("email1_template", templates.email1);
  parsed.followup = tryParse("followup_template", templates.followup);
  if (errors.length) return { ok: false, errors, warnings, rows: [], skipped: [], capacity: null };

  const used = new Set();
  const cap = { email1: capacity(parsed.email1.nodes), followup: capacity(parsed.followup.nodes), subjects: parsed.subjects.reduce((a, p) => a + capacity(p.nodes), 0) };
  if (leads.length > cap.email1) warnings.push(`email1_template has only ${cap.email1} distinct versions for ${leads.length} leads, so some sentences will repeat. Add options or put {{company}}/{{city}} in more sentences.`);
  if (leads.length > cap.followup) warnings.push(`followup_template has only ${cap.followup} distinct versions for ${leads.length} leads, so some follow-ups will be identical.`);

  const need = new Set();
  [parsed.email1, parsed.followup, ...parsed.subjects].forEach((p) => tagsUsed(p.nodes, need));
  const usedF = new Set(), usage = new Map(), subjUse = new Array(parsed.subjects.length).fill(0);
  const bump = (key) => usage.set(key, (usage.get(key) || 0) + 1);
  const rows = [], skipped = [];
  const sorted = [...leads].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const lead of sorted) {
    const tags = tagValues(lead);
    const missing = [...need].filter((t) => !tags[t]);
    if (missing.length) { skipped.push({ id: lead.id, company: lead.company_name, reason: `missing ${missing.join(", ")}` }); continue; }
    const rng = mulberry(fnv(`${seed}:${lead.id}`));
    let best = null;
    for (let k = 0; k < tries; k++) {
      const picks = { e1: [], fu: [], s: [] };
      const mk = (bucket, tpl) => ({ pick: (g, n) => Math.floor(rng() * n), rec: (g, i) => picks[bucket].push(`${tpl}:${g}:${i}`) });
      const si = Math.floor(rng() * parsed.subjects.length);
      const a1 = mk("e1", "e"), a2 = mk("fu", "f"), a3 = mk("s", "s" + si);
      const s = tidy(render(parsed.subjects[si].nodes, tags, a3.pick, a3.rec));
      const e1 = tidy(render(parsed.email1.nodes, tags, a1.pick, a1.rec));
      const fu = tidy(render(parsed.followup.nodes, tags, a2.pick, a2.rec));
      const sentences = bodySentences(e1);
      let score = sentences.filter((x) => used.has(x)).length * 1000 + (usedF.has(normBody(fu)) ? 1000 : 0) + subjUse[si] * 0.5;
      for (const key of [...picks.e1, ...picks.fu]) score += usage.get(key) || 0;
      if (!best || score < best.score) best = { score, s, e1, fu, si, picks, sentences };
      if (score === 0) break;
    }
    best.sentences.forEach((x) => used.add(x)); usedF.add(normBody(best.fu));
    [...best.picks.e1, ...best.picks.fu].forEach(bump); subjUse[best.si]++;
    const code = (arr) => arr.map((x) => x.split(":").slice(1).join(".")).join(",");
    rows.push({ id: lead.id, s: best.s, e1: best.e1, e2: best.fu, v: `s${best.si}/e1:${code(best.picks.e1)}/f:${code(best.picks.fu)}`.slice(0, 200) });
  }
  return { ok: true, errors, warnings, rows, skipped, capacity: cap };
}
