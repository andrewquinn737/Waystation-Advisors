// Run: node tools/testenv/spintax.test.mjs   (pure expander: parsing, merge tags, uniqueness on a 50-lead list)
import assert from "node:assert/strict";
import { parse, expandList, capacity, SpintaxError, displayCompany, displayFirst } from "../../dealflow-app/supabase/functions/_shared/spintax.js";
import { lintBatch } from "../../dealflow-app/supabase/functions/_shared/copyLint.js";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log("FAIL", name, "\n  ", e.message); } };
const bad = (src, re) => assert.throws(() => parse(src), (e) => e instanceof SpintaxError && re.test(e.message));

t("balanced / nested parse + capacity", () => { assert.equal(capacity(parse("{a|b|c} x {d|{e|f}g}").nodes), 3 * (1 + 2)); });
t("unbalanced open", () => bad("hello {a|b", /Unbalanced/));
t("unbalanced close", () => bad("hello a|b}", /(Unbalanced|Stray)/));
t("stray close", () => bad("hello } there", /Unbalanced/));
t("stray pipe", () => bad("a | b", /Stray/));
t("unknown merge tag", () => bad("Hi {{nickname}},", /Unknown merge tag/));
t("bad merge tag", () => bad("Hi {{first name}},", /Bad merge tag/));
t("single-brace tag is rejected", () => bad("Hi {company},", /at least two options/));
t("empty option", () => bad("{a|}", /Empty option/));
t("depth cap", () => bad("{a|{b|{c|{d|{e|f}}}}}", /nested too deeply/));
t("tag casing + spaces ok", () => { parse("Hi {{ First_Name }}, {{company}}"); });
t("display helpers", () => {
  assert.equal(displayCompany("ACME PLUMBING, LLC"), "Acme Plumbing");
  assert.equal(displayCompany("Bob's Heating Inc."), "Bob's Heating");
  assert.equal(displayFirst("Dr. PAT Smith"), "Pat");
});

const leads = Array.from({ length: 50 }, (_, i) => ({ id: `id-${String(i).padStart(3, "0")}`, full_name: `Pat${i} Owner`, company_name: `Company ${i} Plumbing LLC`, city: ["Provo", "Ogden", "Orem", "Logan"][i % 4] }));
const T = {
  subjects: ["{plumbing|heating|service} buyer, {{city}} area", "{{company}} and a {local|regional} buyer"],
  email1: "Hi {{first_name}},\n\n{I saw|I noticed|I came across} {{company}} {while looking at|while reading about|while researching} {plumbing|heating|service} firms {around|near|in} {{city}}. {A family-owned firm|A buyer I work with|One buyer I know} {is looking to add|wants to add|would like to add} {one more|another} {shop|business|company} in the area, and {yours|{{company}}} {looks like|seems like} {a good fit|a strong match|a natural match}.\n\n{Could we|Would you be open to|Do you have time for|Might you have} {a short call|a quick call|a fifteen minute call|a brief chat} {this week|next week|soon} to talk it {through|over}?\n\n{Best|Thanks|Cheers},\nMason",
  followup: "Hi {{first_name}}, {I wanted to follow up|just following back up|circling back} {about|on} {{company}} in {{city}}.\n\nMason",
};
t("expands 50 leads: tags filled, no braces, no placeholders", () => {
  const r = expandList(T, leads, { seed: "L1:1" });
  assert.ok(r.ok, r.errors.join(";")); assert.equal(r.rows.length, 50); assert.equal(r.skipped.length, 0);
  for (const x of r.rows) { assert.ok(!/[{}|]/.test(x.s + x.e1 + x.e2), x.e1); }
  const l0 = leads.find((l) => l.id === r.rows[0].id);
  assert.ok(r.rows[0].e1.includes(`Hi ${l0.full_name.split(" ")[0]},`)); assert.ok(r.rows[0].e1.includes(`Company ${l0.company_name.split(" ")[1]} Plumbing`));
});
t("uniqueness: no sentence repeats across the 50 leads (lint passes)", () => {
  const r = expandList(T, leads, { seed: "L1:1" });
  const res = lintBatch(r.rows.map((x) => { const l = leads.find((q) => q.id === x.id); return { id: x.id, full_name: l.full_name, company_name: l.company_name, email_subject: x.s, email_1: x.e1, email_2: x.e2 }; }));
  const errs = [...res.values()].flatMap((v) => v.errors);
  assert.deepEqual(errs, []);
  assert.equal(new Set(r.rows.map((x) => x.e1)).size, 50);
});
t("deterministic for the same seed + leads, different for another seed", () => {
  const a = expandList(T, leads, { seed: "L1:1" }), b = expandList(T, [...leads].reverse(), { seed: "L1:1" }), c = expandList(T, leads, { seed: "L1:2" });
  assert.deepEqual(a.rows, b.rows); assert.notDeepEqual(a.rows, c.rows);
});
t("without replacement: every option of a group is used before any is used a third time", () => {
  const r = expandList({ subjects: ["Hello there {{city}}"], email1: "Hi {{first_name}},\n\n{Alpha one two three four|Bravo one two three four|Charlie one two three four|Delta one two three four}.\n\nBest,\nM", followup: "Hi {{first_name}}, a {note|ping} {{company}}.\n\nM" }, leads.slice(0, 8), { seed: "z" });
  const counts = {}; r.rows.forEach((x) => { const k = x.e1.match(/(Alpha|Bravo|Charlie|Delta)/)[1]; counts[k] = (counts[k] || 0) + 1; });
  assert.deepEqual(Object.values(counts).sort(), [2, 2, 2, 2]);
});
t("lead missing a used merge tag is skipped with a reason", () => {
  const r = expandList(T, [...leads.slice(0, 3), { id: "id-x", full_name: "Kim Q", company_name: "NoCity Co", city: "" }]);
  assert.equal(r.rows.length, 3); assert.equal(r.skipped.length, 1); assert.match(r.skipped[0].reason, /city/);
});
t("template errors: unbalanced / unknown tag / dash are returned, nothing expanded", () => {
  let r = expandList({ ...T, email1: "Hi {{first_name}}, {a|b" }, leads); assert.ok(!r.ok && r.rows.length === 0 && /Unbalanced/.test(r.errors[0]));
  r = expandList({ ...T, followup: "Hi {{owner}}" }, leads); assert.ok(!r.ok && /Unknown merge tag/.test(r.errors[0]));
  r = expandList({ ...T, subjects: ["a — b"] }, leads); assert.ok(!r.ok && /dash/.test(r.errors[0]));
  r = expandList({ ...T, subjects: [] }, leads); assert.ok(!r.ok);
});
t("capacity warning when too few combinations", () => {
  const r = expandList({ subjects: ["Hello {{city}}"], email1: "Hi {{first_name}},\n\nOne fixed sentence with five words.\n\nBest,\nM", followup: "Hi {{first_name}}, a {note|ping}.\n\nM" }, leads.slice(0, 5));
  assert.ok(r.ok && r.warnings.length >= 1);
});
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
