// Run: node tools/testenv/copyLint.test.mjs
import assert from "node:assert/strict";
import { lintLead, lintBatch, summarize, splitEmail, bodyWordCount, firstNameOf, MAX_WORDS } from "../../dealflow-app/js/copyLint.js";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log("FAIL", name, "\n  ", e.message); } };
const good = (o = {}) => ({
  id: "1", full_name: "Pat Smith", company_name: "Acme Plumbing LLC",
  email_subject: "Quick question about Acme",
  email_1: "Hi Pat,\n\nWe represent a buyer looking at plumbing firms in Utah. Would you be open to a short call this week?\n\nBest,\nMason",
  email_2: "Hi Pat,\n\nJust floating this back up in case it got buried. Happy to answer questions.\n\nBest,\nMason",
  ...o,
});
const errs = (l) => lintLead(l).errors, warns = (l) => lintLead(l).warnings;
const has = (arr, re) => arr.some((x) => re.test(x));
const sig = "\n\nBest,\nMason";

t("clean lead passes", () => { assert.deepEqual(lintLead(good()), { errors: [], warnings: [] }); });

for (const [f, re] of [["email_subject", /subject/i], ["email_1", /Email 1/], ["email_2", /follow-up/i]]) {
  t(`missing ${f}`, () => { for (const v of ["", "  \n ", null, undefined]) assert.ok(has(errs(good({ [f]: v })), re)); });
}
t("all empty strings", () => { assert.equal(errs({ id: "x", full_name: "", company_name: "", email_subject: "", email_1: "", email_2: "" }).length, 3); });
t("empty object no throw", () => { assert.equal(errs({ id: "x" }).length, 3); });

for (const ph of ["{first_name}", "{{company}}", "[Name]", "<FIRST>", "%FIRST%"]) {
  t(`placeholder ${ph}`, () => { assert.ok(has(errs(good({ email_1: `Hi ${ph},\n\nWe have a buyer interested in your firm for real.` + sig })), /placeholder/)); });
}
t("placeholder in subject", () => { assert.ok(has(errs(good({ email_subject: "About {company}" })), /placeholder/)); });
t("no placeholder: URL angle/parens", () => { assert.ok(!has(errs(good({ email_2: "See <https://x.com/a> or (call me)." })), /placeholder/)); });

t("em dash", () => { assert.ok(has(errs(good({ email_1: "Hi Pat,\n\nWe buy firms — quickly and fairly, with cash in hand today." + sig })), /dash/)); });
t("en dash in subject", () => { assert.ok(has(errs(good({ email_subject: "2020–2024 growth" })), /dash/)); });
t("hyphen ok", () => { assert.ok(!has(errs(good({ email_subject: "Follow-up on well-known firm" })), /dash/)); });

const words = (n) => Array.from({ length: n }, (_, i) => "w" + i).join(" ");
t("85 words ok", () => { const e = `Hi Pat,\n\n${words(85)}\n\nBest,\nMason Quinn`; assert.equal(bodyWordCount(e), 85); assert.ok(!has(errs(good({ email_1: e })), /words/)); });
t("86 words error", () => { assert.ok(has(errs(good({ email_1: `Hi Pat,\n\n${words(86)}` + sig })), /86 words/)); });
t("CRLF counted the same", () => { const e = `Hi Pat,\r\n\r\n${words(86)}\r\n\r\nBest,\r\nMason`; assert.equal(bodyWordCount(e), 86); assert.ok(has(errs(good({ email_1: e })), /words/)); });
t("signoff + name lines not counted", () => { assert.equal(bodyWordCount("Hi Pat,\n\nOne two three.\n\nThanks,\nMason Quinn\nWaystation Advisors"), 3); });
t("no greeting still counts body", () => { assert.equal(bodyWordCount("One two three four."), 4); });
t("empty body = 0", () => { assert.equal(bodyWordCount(""), 0); assert.equal(bodyWordCount(null), 0); });
t("splitEmail", () => { const s = splitEmail("Hi Zoë,\n\nBody here.\n\nBest,\nMe"); assert.equal(s.greeting, "Hi Zoë,"); assert.equal(s.body, "Body here."); assert.match(s.signoff, /^Best,/); });

const G = "\n\nWe have a buyer interested in your firm for real." + sig;
t("greeting mismatch warns", () => { assert.ok(has(warns(good({ email_1: "Hi Sam," + G })), /greeting/)); });
t("greeting match no warn", () => { assert.ok(!has(warns(good()), /greeting/)); });
t("Zoë vs Zoe matches", () => { assert.ok(!has(warns(good({ full_name: "Zoë Adams", email_1: "Hi Zoe," + G, email_2: "Hi Zoë,\n\nBumping this up for you." + sig })), /greeting/)); });
t("O'Brien last name", () => { assert.ok(!has(warns(good({ full_name: "Sean O'Brien", email_1: "Hi Sean," + G, email_2: "Hi Sean,\n\nBumping this up." + sig })), /greeting/)); });
t("O'Brien first name", () => { assert.equal(firstNameOf("O'Brien Smith"), "O'Brien"); assert.ok(!has(warns(good({ full_name: "O'Brien Smith", email_1: "Hi O'Brien," + G, email_2: "Hi O’Brien,\n\nBumping this up." + sig })), /greeting/)); });
t("title stripped", () => { assert.equal(firstNameOf("Dr. Pat Smith"), "Pat"); });
t("Hi there no warn", () => { assert.ok(!has(warns(good({ email_1: "Hi there," + G })), /greeting/)); });
t("empty full_name no warn", () => { assert.ok(!has(warns(good({ full_name: "" })), /greeting/)); });
t("CRLF greeting", () => { assert.ok(has(warns(good({ email_1: "Hi Sam,\r\n\r\nWe have a buyer interested in your firm.\r\n\r\nBest,\r\nM" })), /greeting/)); });

t("subject 61 warns", () => { assert.ok(has(warns(good({ email_subject: "x".repeat(61) })), /Subject is 61/)); });
t("subject 60 ok", () => { assert.ok(!has(warns(good({ email_subject: "x".repeat(60) })), /Subject/)); });
t("link warns", () => { assert.ok(has(warns(good({ email_2: "Hi Pat,\n\nSee https://example.com for details on us." + sig })), /link/i)); });
t("no link no warn", () => { assert.ok(!has(warns(good()), /link/i)); });

const mk = (id, name, co, e1, e2) => good({ id, full_name: name, company_name: co, email_1: e1, email_2: e2 });
t("duplicate sentence across leads (case/space/CRLF-insensitive)", () => {
  const a = mk("a", "Pat Smith", "Acme Plumbing", "Hi Pat,\n\nWe represent a buyer that wants plumbing firms in Utah." + sig, "Hi Pat,\n\nBumping this up for you today." + sig);
  const b = mk("b", "Lee Jones", "Zed Pipe", "Hi Lee,\r\n\r\n  we represent   a BUYER that wants plumbing firms in utah.\r\n\r\nThis one line is different." + sig, "Hi Lee,\n\nCircling back on my note from earlier." + sig);
  const r = lintBatch([a, b]);
  assert.ok(has(r.get("a").errors, /Same sentence/)); assert.ok(has(r.get("b").errors, /Same sentence/));
});
t("greeting/signoff lines ignored for dup check", () => {
  const a = mk("a", "Pat Smith", "Acme Plumbing", "Hi Pat,\n\nFirst unique body sentence for Pat here." + sig, "Hi Pat,\n\nBumping this up for you today." + sig);
  const b = mk("b", "Pat Smith", "Zed Pipe", "Hi Pat,\n\nA completely different body sentence for Lee." + sig, "Hi Pat,\n\nCircling back on my note from earlier." + sig);
  const r = lintBatch([a, b]);
  assert.deepEqual(r.get("a").errors, []); assert.deepEqual(r.get("b").errors, []);
});
t("short repeated sentence ok", () => {
  const a = mk("a", "Pat Smith", "Acme Plumbing", "Hi Pat,\n\nUnique opening about Acme here today.\n\nWorth a chat?" + sig, "Hi Pat,\n\nBumping this up for you today." + sig);
  const b = mk("b", "Lee Jones", "Zed Pipe", "Hi Lee,\n\nA different opener entirely for Zed.\n\nWorth a chat?" + sig, "Hi Lee,\n\nCircling back on my note from earlier." + sig);
  assert.deepEqual(lintBatch([a, b]).get("a").errors, []);
});
t("identical follow-up across leads", () => {
  const a = mk("a", "Pat Smith", "Acme Plumbing", "Hi Pat,\n\nOpener one is about Acme only." + sig, "Hi Pat,\n\nJust floating this back up to the top." + sig);
  const b = mk("b", "Lee Jones", "Zed Pipe", "Hi Lee,\n\nOpener two is about Zed only." + sig, "Hi Lee,\r\n\r\njust floating this back up to the top." + sig);
  const r = lintBatch([a, b]);
  assert.ok(has(r.get("a").errors, /Follow-up is identical/)); assert.ok(has(r.get("b").errors, /Follow-up is identical/));
});
t("empty follow-ups not flagged identical", () => {
  const a = mk("a", "Pat", "Acme Plumbing", "Hi Pat,\n\nOpener one is about Acme only." + sig, "");
  const b = mk("b", "Lee", "Zed Pipe", "Hi Lee,\n\nOpener two is about Zed only." + sig, "");
  assert.ok(!has(lintBatch([a, b]).get("a").errors, /identical/));
});
t("other company mentioned warns", () => {
  const a = mk("a", "Pat Smith", "Acme Plumbing LLC", "Hi Pat,\n\nWe think Zed Pipe would be a great fit for this buyer." + sig, "Hi Pat,\n\nBumping this up for you today." + sig);
  const b = mk("b", "Lee Jones", "Zed Pipe Inc.", "Hi Lee,\n\nOpener two is about Zed only." + sig, "Hi Lee,\n\nCircling back on my note from earlier." + sig);
  const r = lintBatch([a, b]);
  assert.ok(has(r.get("a").warnings, /another lead's company/)); assert.deepEqual(r.get("a").errors, []);
  assert.ok(!has(r.get("b").warnings, /another lead's company/));
});
t("own company mention no warn (suffix + O'Brien)", () => {
  const a = mk("a", "Sean O'Brien", "O'Brien Roofing, Inc.", "Hi Sean,\n\nWe like what O'Brien Roofing has built in Utah." + sig, "Hi Sean,\n\nBumping this up for you today." + sig);
  const b = mk("b", "Lee Jones", "Zed Pipe Inc.", "Hi Lee,\n\nOpener two is about Zed only." + sig, "Hi Lee,\n\nCircling back on my note from earlier." + sig);
  assert.ok(!has(lintBatch([a, b]).get("a").warnings, /another lead's company/));
});
t("summarize counts", () => {
  const a = mk("a", "Pat", "Acme Plumbing", "Hi Pat,\n\nOpener one is about Acme only." + sig, "Hi Pat,\n\nBumping this up for you today." + sig);
  const b = mk("b", "Lee", "Zed Pipe", "Hi Lee,\n\nOpener two is about Zed only." + sig, "");
  assert.deepEqual(summarize(lintBatch([a, b])), { total: 2, ready: 1, errors: 1, warnings: 0 });
});
t("empty batch", () => { assert.deepEqual(summarize(lintBatch([])), { total: 0, ready: 0, errors: 0, warnings: 0 }); });
t("MAX_WORDS", () => assert.equal(MAX_WORDS, 85));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
