// Autodial: which number each sequence step dials, and that "No answer" on a first mobile try rings it again.
import fs from "fs";
import path from "path";
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "dealflow-app", "js");
const src = fs.readFileSync(path.join(dir, "dials.js"), "utf8");
const home = fs.readFileSync(path.join(dir, "dialsHome.js"), "utf8");
const sequenceNumber = new Function(src.match(/function sequenceNumber[\s\S]*?\n}\n/)[0] + "return sequenceNumber;")();
let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) pass++; else { fail++; console.log("FAIL", name, got ?? ""); } };
const both = { mobile_phone: "M", company_phone: "C" };
check("Call step dials the mobile", sequenceNumber(both, "call")?.method === "mobile");
check("Call company line step dials the office", sequenceNumber(both, "call_company")?.method === "company");
check("office step with no office number falls back to the mobile", sequenceNumber({ mobile_phone: "M" }, "call_company")?.phone === "M");
check("mobile step with no mobile falls back to the office", sequenceNumber({ company_phone: "C" }, "call")?.phone === "C");
check("no number = nothing to dial", sequenceNumber({}, "call") === null);
const at = src.slice(src.indexOf("function autodialTarget("), src.indexOf("function nextCallTarget("));
check("No answer on the first mobile try rings the same mobile again", /no_response/.test(at) && /attempt === 1/.test(at) && /attempt: 2/.test(at));
const pc = src.slice(src.indexOf("function placeCall("), src.indexOf("function placeCall(") + 600);
check("every call counts tries on the same number", /attempt: autoCall\.attempt \+ 1/.test(pc));
const run = src.slice(src.indexOf("function runAutodial("), src.indexOf("function handleDeleteDial("));
check("autodial opens the card before it calls", run.indexOf("openCardFrom") > 0 && run.indexOf("openCardFrom") < run.indexOf("placeCall"));
check("Next company and autodial share one order", /function nextCompanyTarget\(\)[\s\S]{0,120}nextCallTarget/.test(src));
const q = home.slice(home.indexOf("callQueue()"), home.indexOf("callQueue()") + 900);
check("queue = Past due, Due today, Not called yet only", /g\.n > 3/.test(q));
check("queue skips LinkedIn / reply steps and callbacks not due yet", /CALL_KINDS\.includes/.test(q) && /it\.cb > dueBy/.test(q));
check("a callback outcome asks for the time before autodial moves on", /openCallbackModal\(dial, \{ after: target \? \(\) => runAutodial\(target\)/.test(src));
const adv = fs.readFileSync(path.join(dir, "advancedSettings.js"), "utf8");
check("About us email no longer changes the email icon", /export function resolveAboutUsEmailBody\(\) \{\s*return null;/.test(adv));
for (const f of ["dials.html", "clients.html", "profile.html"]) {
  const h = fs.readFileSync(path.join(dir, "..", f), "utf8");
  check(`${f}: About us email row is hidden`, /id="aboutUsEmailRow" hidden>/.test(h));
}
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
