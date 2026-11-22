// Run: node tools/testenv/import_unit.test.mjs   (pure engine: parser, auto-mapping, validation, duplicates)
import assert from "node:assert/strict";
import { parseCSV, autoMapColumns, buildDials, rowsToDials, validateDials, findFileDuplicates, dupCheckKeys, matchServerDuplicates, mappingProblems, cleanEmailCell, normEmail, stripInternal } from "../../dealflow-app/js/csvImport.js";
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; } catch (e) { fail++; console.log("FAIL", n, "\n  ", e.message); } };

t("BOM + CRLF + quoted commas/newlines/quotes", () => {
  const r = parseCSV('﻿Name,Company\r\n"Smith, Jo","Acme ""Best"" Co"\r\n"Li\nne",X\r\n');
  assert.deepEqual(r, [["Name", "Company"], ["Smith, Jo", 'Acme "Best" Co'], ["Li\nne", "X"]]);
});
t("lone CR line ends", () => assert.equal(parseCSV("a,b\rc,d\re,f").length, 3));
t("semicolon and tab delimiters", () => {
  assert.deepEqual(parseCSV("a;b;c\n1;2;3"), [["a", "b", "c"], ["1", "2", "3"]]);
  assert.deepEqual(parseCSV("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
});
t("no trailing newline; blank last cell", () => assert.deepEqual(parseCSV("a,b\n1,"), [["a", "b"], ["1", ""]]));
t("11-column standard header maps fully", () => {
  const h = ["Full name", "Company name", "City", "State", "Email", "Mobile number", "Company number", "LinkedIn", "Website", "Industry sector", "Summary"];
  const { map } = autoMapColumns(h);
  assert.deepEqual(Object.values(map), ["full_name", "company_name", "city", "state", "email", "mobile_phone", "company_phone", "linkedin", "website", "industry", "summary"]);
});
t("odd headers: typos, case, punctuation", () => {
  const { map, how } = autoMapColumns(["COMPANY_NAME", "E-mail", "Mobie number", "Compny Name", "Emial Address", "Phone - Website", "Call Status"]);
  assert.equal(map[0], "company_name"); assert.equal(map[1], "email"); assert.equal(map[2], "mobile_phone");
  assert.equal(map[3], undefined, "company_name already taken by exact match"); // first wins
  assert.equal(map[4], "email" === map[1] ? undefined : "email");
  assert.equal(map[5], "company_phone"); assert.equal(map[6], "contact_status");
  assert.equal(how[2], "header");
});
t("typo only fills a free field", () => {
  const { map, how } = autoMapColumns(["Compny Name", "Emial"]);
  assert.equal(map[0], "company_name"); assert.equal(how[0], "typo"); assert.equal(map[1], "email");
});
t("'Email 1' is copy, never the address column", () => {
  const { map } = autoMapColumns(["Email", "Email 1", "Email 2", "Subject"]);
  assert.deepEqual(map, { 0: "email", 1: "email_1", 2: "email_2", 3: "email_subject" });
});
t("Email Status / Mobile Status are not the dial status", () => {
  const { map } = autoMapColumns(["Company name", "Email status", "Status"]);
  assert.equal(map[1], undefined); assert.equal(map[2], "contact_status");
});
t("content sniff for unnamed columns", () => {
  const rows = [["Column 1", "Column 2", "Column 3"]];
  for (let i = 0; i < 10; i++) rows.push([`a${i}@x${i}.com`, "https://x.com/" + i, ["TX", "UT", "CA"][i % 3]]);
  const { map, how } = autoMapColumns(rows[0], rows.slice(1));
  assert.deepEqual(map, { 0: "email", 1: "website", 2: "state" }); assert.equal(how[0], "contents");
});
t("same-number mobile/company becomes unsure, state normalized, names joined", () => {
  const rows = [["First", "Last", "Company", "Phone", "Company phone", "State"], ["Jo", "Li", "Acme", "(801) 555-1234", "801-555-1234", "ut"]];
  const [d] = rowsToDials(rows, "L1");
  assert.equal(d.full_name, "Jo Li"); assert.equal(d.mobile_phone_unsure, true); assert.equal(d.company_phone, undefined); assert.equal(d.state, "Utah"); assert.equal(d.list_id, "L1");
  assert.equal(d.__row, undefined);
});
t("status mapping + every row has contact_status", () => {
  const rows = [["Company", "Status"], ["A", "Passed/Dead"], ["B", ""], ["C", "weird"], ["D", "NDA Signed"]];
  assert.deepEqual(rowsToDials(rows, "x").map((d) => d.contact_status), ["not_interested", "uncontacted", "uncontacted", "intro_call_scheduled"]);
});
t("blank rows skipped", () => assert.equal(rowsToDials([["Company"], ["A"], [""], ["  "], ["B"]], "x").length, 2));
t("email cell cleanup", () => {
  assert.equal(cleanEmailCell("mailto:a@b.com"), "a@b.com"); assert.equal(cleanEmailCell("Jane <j@x.org>"), "j@x.org");
  assert.equal(cleanEmailCell("a@b.com; c@d.com"), "a@b.com"); assert.equal(cleanEmailCell("n/a"), "n/a");
});
t("validation: email vs backup, role mailboxes, held copy", () => {
  const rows = [["Company", "Email", "Mobile", "Email 1", "Subject"],
    ["A", "pat@a.com", "(801) 555-1111", "Hi Pat", "Hello"], ["B", "info@b.com", "", "", ""], ["C", "bad@", "8015552222", "", ""], ["D", "x@d.com", "", "", ""], ["E", "", "", "", ""]];
  const s = validateDials(buildDials(rows, autoMapColumns(rows[0]).map, "x"));
  assert.equal(s.total, 5); assert.equal(s.with_personal_email, 2); assert.equal(s.backup, 3);
  assert.equal(s.email_has_copy, 1); assert.equal(s.email_missing_copy, 1); assert.equal(s.role_email, 1); assert.equal(s.bad_email, 1);
  assert.equal(s.no_contact, 1); assert.equal(s.copy_columns, true);
});
t("invalid email is left blank (never saved), still counted as invalid", () => {
  const rows = [["Company", "Email", "Mobile"], ["A", "bad@", "8015552222"], ["B", "n/a", ""], ["C", "ok@c.com", ""]];
  const ds = buildDials(rows, autoMapColumns(rows[0]).map, "x");
  assert.equal(ds[0].email, undefined); assert.equal(ds[1].email, undefined); assert.equal(ds[2].email, "ok@c.com");
  assert.equal(validateDials(ds).bad_email, 2);
  assert.ok(!("__bad_email" in stripInternal(ds[0])) && !("__row" in stripInternal(ds[0])));
});
t("file duplicates: email (gmail dots/plus), mobile, company+city", () => {
  const rows = [["Company", "City", "Email", "Mobile"],
    ["Acme LLC", "Provo", "a.b@gmail.com", ""], ["Other", "X", "ab+x@gmail.com", ""], ["Third", "Y", "", "(801) 555-1000"], ["Fourth", "Z", "", "1-801-555-1000"],
    ["Acme, Inc", "Provo", "", ""], ["Acme LLC", "Orem", "", ""]];
  const ds = buildDials(rows, autoMapColumns(rows[0]).map, "x");
  const dup = findFileDuplicates(ds);
  assert.deepEqual([...dup.keys()], [1, 3, 4]); assert.equal(dup.get(1).why, "same email");
});
t("server hit matching + keys", () => {
  const rows = [["Company", "Email", "Mobile"], ["A", "Pat@Gmail.com", "(801) 555-1111"], ["B", "", "(801) 555-2222"]];
  const ds = buildDials(rows, autoMapColumns(rows[0]).map, "x");
  const k = dupCheckKeys(ds); assert.deepEqual(k.phones.sort(), ["8015551111", "8015552222"]);
  const hits = matchServerDuplicates(ds, [{ kind: "email", key: normEmail("pat@gmail.com"), list_name: "L" }, { kind: "phone", key: "8015552222", list_name: "M" }]);
  assert.deepEqual([...hits.keys()], [0, 1]);
});
t("mapping problems", () => {
  assert.ok(mappingProblems({}).length); assert.equal(mappingProblems({ 0: "company_name", 1: "email" }).length, 0);
  assert.ok(mappingProblems({ 0: "city" }).length);
});
t("2,500-row parse + build is fast", () => {
  let s = "Company name,Email,Mobile number,City,State\r\n";
  for (let i = 0; i < 2500; i++) s += `"Co ${i}, LLC",o${i}@co${i}.com,(801) 555-${String(i).padStart(4, "0")},Provo,UT\r\n`;
  const t0 = performance.now(); const rows = parseCSV(s); const ds = buildDials(rows, autoMapColumns(rows[0], rows.slice(1)).map, "x"); validateDials(ds); findFileDuplicates(ds);
  const ms = performance.now() - t0; assert.equal(ds.length, 2500); assert.ok(ms < 800, "took " + ms);
});
console.log(`${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
