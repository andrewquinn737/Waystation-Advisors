// Short pre-call form for the questionnaire-flow buyer's sellers (see clients.tracking_flow =
// 'questionnaire' and QUESTIONNAIRE_FLOW in js/clients.js). Opened from Dials ("Intro call / form",
// see openQuestionnaireIntroPopup in js/dials.js) BEFORE a call is booked: six qualifying questions.
// When every one passes, "Schedule intro call" unlocks and opens the buyer's own calendar; the form is
// saved on the dial (dials.intake_form) either way, so a lead that can't be booked yet keeps its answers.
// The client's own profile has no form section any more — just Profile / Progress / Timeline.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

// The buyer's booking page — opened by "Schedule intro call". The email is added to the link as a best-effort
// pre-fill (Google doesn't document one for booking pages, so it is ALSO copied to the clipboard by the caller).
const BUYER_CALENDAR_URL = "https://calendar.google.com/appointments/schedules/AcZssZ27l3atfY31Iup9lYPEub4Ib_PqiUNofDVefq6Ew8FloNLEnT_F40TgHDu4O8v3oQSOyQ7SXanB";
export function buyerCalendarUrl(email) {
  const e = String(email || "").trim();
  return e ? `${BUYER_CALENDAR_URL}?email=${encodeURIComponent(e)}` : BUYER_CALENDAR_URL;
}

// [label, passes?] — must be over 40 employees.
const EMPLOYEE_RANGES = [
  ["1–10", false],
  ["11–25", false],
  ["26–40", false],
  ["41–50", true],
  ["51–100", true],
  ["101–250", true],
  ["251–500", true],
  ["500+", true],
];
const YES_NO = ["Yes", "No"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const INTAKE_FIELDS = [
  { key: "employees", label: "Employee range", type: "select", options: EMPLOYEE_RANGES.map((r) => r[0]), rule: "Must be over 40 employees" },
  { key: "willing_to_sell", label: "Are they willing to sell their data?", type: "select", options: YES_NO, rule: "Must be yes" },
  { key: "able_to_sell", label: "Can they sell their data?", type: "select", options: YES_NO, rule: "Must be yes" },
  { key: "no_other_brokers", label: "Are they NOT talking to other brokers?", type: "select", options: YES_NO, rule: "Must be yes" },
  { key: "contact_email", label: "Email on record", type: "email", rule: "Needs an email (put it in here if there isn't one)" },
  { key: "years_in_business", label: "Years in business", type: "number", rule: "Must have been in business over 10 years" },
];

// Which checks aren't met yet. `answered` = every field has something in it.
export function evaluateIntake(data = {}) {
  const failures = [];
  const emp = EMPLOYEE_RANGES.find((r) => r[0] === data.employees);
  if (!emp) failures.push("Employee range not chosen");
  else if (!emp[1]) failures.push("Needs over 40 employees");
  if (data.willing_to_sell !== "Yes") failures.push(data.willing_to_sell === "No" ? "Not willing to sell their data" : "Willing to sell not answered");
  if (data.able_to_sell !== "Yes") failures.push(data.able_to_sell === "No" ? "Can't sell their data" : "Able to sell not answered");
  if (data.no_other_brokers !== "Yes") failures.push(data.no_other_brokers === "No" ? "Talking to other brokers" : "Other brokers not answered");
  if (!EMAIL_RE.test(String(data.contact_email || "").trim())) failures.push("Needs an email on record");
  const years = Number(data.years_in_business);
  if (data.years_in_business === undefined || data.years_in_business === "" || Number.isNaN(years)) failures.push("Years in business not entered");
  else if (years <= 10) failures.push("Needs over 10 years in business");
  return { passes: failures.length === 0, failures };
}

function fieldHTML(f, value) {
  const label = `<label>${escapeHtml(f.label)}</label>`;
  const hint = f.rule ? `<div class="help-text">${escapeHtml(f.rule)}</div>` : "";
  if (f.type === "select") {
    return `<div class="intake-field">${label}${hint}<select data-key="${f.key}"><option value="">Select…</option>${f.options
      .map((o) => `<option value="${escapeHtml(o)}" ${value === o ? "selected" : ""}>${escapeHtml(o)}</option>`)
      .join("")}</select></div>`;
  }
  return `<div class="intake-field">${label}${hint}<input type="${f.type}" data-key="${f.key}" value="${escapeHtml(value ?? "")}" ${
    f.type === "number" ? 'inputmode="numeric" min="0"' : ""
  } /></div>`;
}

let modalEl = null;
let closeHandler = null;

function ensureModal() {
  if (modalEl) return;
  modalEl = document.createElement("div");
  modalEl.className = "modal-backdrop hidden";
  modalEl.id = "intakeFormModal";
  modalEl.style.zIndex = "150";
  modalEl.innerHTML = `<div class="modal intake-form-modal"></div>`;
  document.body.appendChild(modalEl);
}

export function closeIntakeForm() {
  if (!modalEl || modalEl.classList.contains("hidden")) return;
  modalEl.classList.add("hidden");
  unlockPageScroll();
  const cb = closeHandler;
  closeHandler = null;
  if (cb) cb();
}

// opts:
//  title        — popup heading
//  data         — starting answers
//  onSave(data)     — async; throw to show the error inline. Closes the popup after.
//  onSchedule(data) — async; called from the click itself (so a calendar window can open right away).
//                     Only reachable once every check passes. Throw to show the error inline.
//  onClose()    — called after the popup closes for any reason
export function openIntakeForm(opts) {
  ensureModal();
  const { title = "Intro call form", data = {}, onSave, onSchedule, onClose } = opts;
  const box = modalEl.querySelector(".modal");
  box.innerHTML = `
    <h2>${escapeHtml(title)}</h2>
    <p class="help-text">Fill this out first. When every check passes you can schedule the intro call.</p>
    ${INTAKE_FIELDS.map((f) => fieldHTML(f, data[f.key])).join("")}
    <div class="intake-status" id="intakeStatus"></div>
    <div class="error-msg hidden" id="intakeError"></div>
    <div class="form-actions intake-actions">
      <button type="button" class="btn secondary" id="intakeCancelBtn">Close</button>
      <button type="button" class="btn secondary" id="intakeSaveBtn">Save</button>
    </div>
    <div class="form-actions intake-submit-row">
      <button type="button" class="btn yellow" id="intakeScheduleBtn" disabled>Schedule intro call</button>
    </div>
    <p class="help-text">Schedule intro call opens the calendar to book a time and copies the email above so you can paste it in. Can't get it booked? Save the form and come back to it.</p>`;

  const errEl = box.querySelector("#intakeError");
  const statusEl = box.querySelector("#intakeStatus");
  const saveBtn = box.querySelector("#intakeSaveBtn");
  const scheduleBtn = box.querySelector("#intakeScheduleBtn");

  const collect = () => {
    const out = {};
    INTAKE_FIELDS.forEach((f) => {
      out[f.key] = (box.querySelector(`[data-key="${f.key}"]`)?.value || "").trim();
    });
    return out;
  };
  const sync = () => {
    const { passes, failures } = evaluateIntake(collect());
    scheduleBtn.disabled = !passes;
    statusEl.className = `intake-status ${passes ? "pass" : "fail"}`;
    statusEl.innerHTML = passes
      ? "✓ Passes every check — you can schedule the intro call."
      : `Not ready to schedule yet:<ul>${failures.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`;
  };
  sync();
  box.addEventListener("input", sync);
  box.addEventListener("change", sync);

  box.querySelector("#intakeCancelBtn").addEventListener("click", closeIntakeForm);
  saveBtn.addEventListener("click", async () => {
    errEl.classList.add("hidden");
    saveBtn.disabled = true;
    try {
      await onSave(collect());
    } catch (err) {
      errEl.textContent = err?.message || String(err);
      errEl.classList.remove("hidden");
      saveBtn.disabled = false;
      return;
    }
    saveBtn.disabled = false;
    closeIntakeForm();
  });
  scheduleBtn.addEventListener("click", async () => {
    const values = collect();
    if (!evaluateIntake(values).passes) return;
    errEl.classList.add("hidden");
    scheduleBtn.disabled = true;
    try {
      await onSchedule(values);
    } catch (err) {
      errEl.textContent = err?.message || String(err);
      errEl.classList.remove("hidden");
      sync();
      return;
    }
    closeIntakeForm();
  });

  closeHandler = onClose || null;
  modalEl.classList.remove("hidden");
  modalEl.scrollTop = 0;
  lockPageScroll();
}

// Sends the booked lead to Slack and the leads Google Sheet (intake-submit edge function): the company's
// information plus the form's employees, years in business, email and willing/able to sell — never "not
// talking to other brokers". Stamps the lead's "date called" and submitted time first. Resolves to
// { slack, sheet, errors } ('sent' | 'updated' | 'already_sent' | 'not_configured' | 'failed').
export async function sendLeadToSheetAndSlack(clientId, form) {
  const now = new Date();
  const dateCalled = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const { error: saveErr } = await supabase
    .from("clients")
    .update({ intake_form: { ...form, date_called: dateCalled }, intake_submitted_at: now.toISOString() })
    .eq("id", clientId);
  if (saveErr) throw saveErr;
  try {
    const { data: res, error } = await supabase.functions.invoke("intake-submit", { body: { client_id: clientId } });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch { /* keep the generic message */ }
      return { slack: "failed", sheet: "failed", errors: { slack: msg, sheet: msg } };
    }
    return { slack: res?.slack || "failed", sheet: res?.sheet || "failed", errors: res?.errors || {} };
  } catch (err) {
    const msg = err?.message || String(err);
    return { slack: "failed", sheet: "failed", errors: { slack: msg, sheet: msg } };
  }
}

// Text explaining what didn't go out, or null when everything that's connected was delivered.
export function describeDelivery(result) {
  const names = { slack: "Slack", sheet: "the Google Sheet" };
  const failed = Object.keys(names).filter((k) => result[k] === "failed");
  if (!failed.length) return null;
  return failed.map((k) => `posting to ${names[k]} failed: ${result.errors?.[k] || "unknown error"}`).join("; ");
}
