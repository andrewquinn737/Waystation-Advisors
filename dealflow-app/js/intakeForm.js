// Submission popup for the questionnaire-flow buyer's sellers (see clients.tracking_flow = 'questionnaire' and
// QUESTIONNAIRE_FLOW in js/clients.js). Opened from Dials ("Intro call / form", see openQuestionnaireIntroPopup in
// js/dials.js). Three steps, done in whatever order suits the call, each saved on the dial (dials.intake_form) the
// moment it is completed: (1) the six qualifying questions, which must pass; (2) booking on the buyer's own calendar,
// shown inside the app; (3) entering that time in the app. When all three are done "Submit client" unlocks.
// The extra step flags live in the same jsonb under keys starting with "_" (formFieldsOnly strips them).
// The client's own profile has no form section any more — just Profile / Progress / Timeline.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { timeOptionsHTML, timezoneOptionsHTML, defaultTimezone, zonedTimeToUtcIso } from "./eventTime.js";

// The buyer's booking page. The `/calendar/appointments/...?gv=true` form is Google's embeddable version of it
// (the plain `/appointments/...` page refuses to be framed), so it is shown INSIDE the app (see openCalendarPanel)
// instead of navigating away — leaving the page is what cut the rep's call audio off on phones.
const BUYER_CALENDAR_ID = "AcZssZ27l3atfY31Iup9lYPEub4Ib_PqiUNofDVefq6Ew8FloNLEnT_F40TgHDu4O8v3oQSOyQ7SXanB";
const BUYER_CALENDAR_EMBED_URL = `https://calendar.google.com/calendar/appointments/schedules/${BUYER_CALENDAR_ID}?gv=true`;
const BUYER_CALENDAR_URL = `https://calendar.google.com/appointments/schedules/${BUYER_CALENDAR_ID}`;
export function buyerCalendarUrl(email) {
  const e = String(email || "").trim();
  return e ? `${BUYER_CALENDAR_URL}?email=${encodeURIComponent(e)}` : BUYER_CALENDAR_URL;
}

function detailRowsHTML(rows) {
  return rows.map((d, i) => `<div class="calendar-detail"><div class="calendar-detail-text"><span class="calendar-detail-label">${escapeHtml(d.label)}</span><span class="calendar-detail-value">${escapeHtml(d.value)}</span></div><button type="button" class="btn secondary calendar-copy" data-i="${i}">Copy</button></div>`).join("");
}
function wireCopyButtons(root, rows) {
  root.querySelectorAll(".calendar-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const value = rows[Number(btn.dataset.i)].value;
      try { await navigator.clipboard.writeText(value); btn.textContent = "Copied"; }
      catch { btn.textContent = "Select & copy"; }
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
  });
}

let calendarEl = null;
// Full-screen sheet with the buyer's booking page in a frame and the lead's details pinned above it, each with a
// Copy button — the booking form asks for an email and company name, and they are no longer out of sight.
//  details  — [{ label, value }] rows shown with Copy buttons (empty values are skipped)
//  onBooked — the rep tapped "Booked — enter the time"
//  onClose  — the rep closed it without booking
export function openCalendarPanel({ details = [], bookedLabel = "Booked — enter the time", onBooked, onClose }) {
  closeCalendarPanel(true);
  calendarEl = document.createElement("div");
  calendarEl.className = "calendar-panel";
  // Leave room for the call bar (it floats over the bottom of the screen during a call).
  const callBar = document.querySelector(".call-panel");
  calendarEl.style.paddingBottom = callBar ? `${callBar.offsetHeight + 36}px` : "0px";
  const rows = details.filter((d) => d.value);
  calendarEl.innerHTML = `
    <div class="calendar-panel-head">
      <div class="calendar-panel-title">Book the intro call</div>
      <button type="button" class="btn secondary" id="calCloseBtn">Close</button>
    </div>
    <div class="calendar-panel-details">
      ${detailRowsHTML(rows)}
    </div>
    <iframe class="calendar-frame" src="${BUYER_CALENDAR_EMBED_URL}" title="Book the intro call" allow="clipboard-write"></iframe>
    <div class="calendar-panel-foot">
      <a class="calendar-newtab" href="${BUYER_CALENDAR_URL}" target="_blank" rel="noopener">Calendar not loading? Open it in a new tab</a>
      <button type="button" class="btn yellow" id="calBookedBtn">${escapeHtml(bookedLabel)}</button>
    </div>`;
  document.body.appendChild(calendarEl);
  wireCopyButtons(calendarEl, rows);
  calendarEl.querySelector("#calCloseBtn").addEventListener("click", () => { closeCalendarPanel(); onClose?.(); });
  calendarEl.querySelector("#calBookedBtn").addEventListener("click", () => { closeCalendarPanel(); onBooked?.(); });
}

export function closeCalendarPanel(silent) {
  if (!calendarEl) return;
  calendarEl.remove();
  calendarEl = null;
}

// Employee ranges (the box is optional, so the second value is no longer used).
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
  { key: "employees", label: "Employee range", type: "select", options: EMPLOYEE_RANGES.map((r) => r[0]), rule: "Optional" },
  { key: "willing_to_sell", label: "Are they willing to sell their data?", type: "select", options: YES_NO, rule: "Must be yes" },
  { key: "able_to_sell", label: "Can they sell their data?", type: "select", options: YES_NO, rule: "Must be yes" },
  { key: "no_other_brokers", label: "Are they NOT talking to other brokers?", type: "select", options: YES_NO, rule: "Must be yes" },
  { key: "contact_email", label: "Email on record", type: "email", rule: "Needs an email (put it in here if there isn't one)" },
  { key: "years_in_business", label: "Years in business", type: "number", rule: "Must have been in business over 10 years" },
];

// Which checks aren't met yet. `answered` = every field has something in it.
export function evaluateIntake(data = {}) {
  const failures = [];
  // Employee range is optional: recorded when given, never blocks scheduling.
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

export const formFieldsOnly = (data = {}) => Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("_")));

// First / last name for the booking form, from the dial's single full-name field.
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") };
}

// opts:
//  dial          — the dial (name + company shown for the booking form)
//  data          — everything saved so far (dial.intake_form: form answers + "_" step flags)
//  onPersist(patch) — async; merge `patch` into the saved data (throw to show the error)
//  onSubmit(form, appTime) — async; creates the client. Throw to show the error inline.
//  onClose()     — called after the popup closes for any reason
export function openSubmissionPopup(opts) {
  ensureModal();
  const { dial, data = {}, onPersist, onSubmit, onClose } = opts;
  const state = { ...data };
  const box = modalEl.querySelector(".modal");
  const nm = splitName(dial.full_name);
  const title = dial.company_name || dial.full_name || "Intro call";
  box.innerHTML = `
    <h2>${escapeHtml(title)}</h2>
    <p class="help-text">Do these three in whatever order suits the call. Each one saves as soon as you finish it; when all three are done you can submit the client.</p>

    <div class="sub-step" data-step="form">
      <div class="sub-step-head"><span class="sub-badge"></span><span class="sub-step-title">Form &amp; checks</span></div>
      <div class="sub-step-body">
        ${INTAKE_FIELDS.map((f) => fieldHTML(f, state[f.key])).join("")}
        <div class="intake-status" id="subFormStatus"></div>
        <div class="form-actions"><button type="button" class="btn" id="subFormSave">Save form</button></div>
      </div>
    </div>

    <div class="sub-step" data-step="cal">
      <div class="sub-step-head"><span class="sub-badge"></span><span class="sub-step-title">Book on the buyer's calendar</span></div>
      <div class="sub-step-body">
        <p class="help-text">Opens the calendar here in the app (your call keeps going) with the details to copy into it.</p>
        <div class="form-actions">
          <button type="button" class="btn yellow" id="subCalOpen">Open calendar</button>
          <button type="button" class="btn secondary" id="subCalToggle">Mark as booked</button>
        </div>
      </div>
    </div>

    <div class="sub-step" data-step="app">
      <div class="sub-step-head"><span class="sub-badge"></span><span class="sub-step-title">Schedule it in the app</span></div>
      <div class="sub-step-body">
        <p class="help-text">The date and time you booked on the calendar.</p>
        <label for="subDate">Date</label><input type="date" id="subDate" />
        <label for="subTime">Time</label><select id="subTime"></select>
        <label for="subTz">Time zone</label><select id="subTz"></select>
        <div class="form-actions"><button type="button" class="btn" id="subAppSave">Save time</button></div>
      </div>
    </div>

    <div class="error-msg hidden" id="subError"></div>
    <div class="form-actions intake-submit-row">
      <button type="button" class="btn secondary" id="subClose">Close</button>
      <button type="button" class="btn yellow" id="subSubmit" disabled>Submit client</button>
    </div>
    <p class="help-text" id="subHint"></p>`;

  const $ = (sel) => box.querySelector(sel);
  const errEl = $("#subError");
  const showErr = (msg) => { errEl.textContent = msg; errEl.classList.remove("hidden"); };
  const collectForm = () => {
    const out = {};
    INTAKE_FIELDS.forEach((f) => { out[f.key] = (box.querySelector(`[data-key="${f.key}"]`)?.value || "").trim(); });
    return out;
  };
  const persist = async (patch) => {
    errEl.classList.add("hidden");
    try { await onPersist(patch); } catch (err) { showErr(err?.message || String(err)); return false; }
    Object.assign(state, patch);
    refresh();
    return true;
  };

  // Booking details to copy: first name, last name, email and company only.
  const bookingDetails = () => [
    { label: "First name", value: nm.first },
    { label: "Last name", value: nm.last },
    { label: "Email", value: collectForm().contact_email || state.contact_email || dial.email || "" },
    { label: "Company", value: dial.company_name || "" },
  ];

  $("#subDate").value = state._app_time?.val || (() => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); })();
  $("#subTime").innerHTML = timeOptionsHTML(state._app_time?.time || "", { includeNoTime: false });
  $("#subTz").innerHTML = timezoneOptionsHTML(state._app_time?.timezone || defaultTimezone());

  const done = () => ({
    form: evaluateIntake(formFieldsOnly(state)).passes,
    cal: !!state._cal_booked,
    app: !!state._app_time?.eventDate,
  });
  const refresh = () => {
    const d = done();
    Object.entries(d).forEach(([k, ok]) => {
      const step = $(`.sub-step[data-step="${k}"]`);
      step.classList.toggle("done", ok);
      step.querySelector(".sub-badge").textContent = ok ? "✓" : "";
    });
    const { passes, failures } = evaluateIntake(collectForm());
    const st = $("#subFormStatus");
    st.className = `intake-status ${passes ? "pass" : "fail"}`;
    st.innerHTML = passes ? "✓ Passes every check." : `Not passing yet:<ul>${failures.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`;
    $("#subCalToggle").textContent = d.cal ? "Undo booked" : "Mark as booked";
    $("#subAppSave").textContent = d.app ? "Update time" : "Save time";
    const all = d.form && d.cal && d.app;
    $("#subSubmit").disabled = !all;
    const left = [!d.form && "the form", !d.cal && "the calendar booking", !d.app && "the time in the app"].filter(Boolean);
    $("#subHint").textContent = all ? "All three are done — submit the client when you're ready." : `Still to do: ${left.join(", ")}.`;
  };

  box.addEventListener("input", refresh);
  box.addEventListener("change", refresh);
  box.querySelectorAll(".sub-step-head").forEach((h) => h.addEventListener("click", () => h.parentElement.classList.toggle("collapsed")));

  $("#subFormSave").addEventListener("click", async () => {
    const values = collectForm();
    const ok = await persist(values);
    if (ok && evaluateIntake(values).passes) $('.sub-step[data-step="form"]').classList.add("collapsed");
  });
  $("#subCalOpen").addEventListener("click", () => {
    modalEl.classList.add("hidden"); // out of the way while the calendar sheet is up; the page stays locked
    const back = () => modalEl.classList.remove("hidden");
    openCalendarPanel({
      details: bookingDetails(),
      bookedLabel: "I booked it",
      onBooked: async () => { back(); await persist({ _cal_booked: true }); },
      onClose: back,
    });
  });
  $("#subCalToggle").addEventListener("click", () => persist({ _cal_booked: !state._cal_booked }));
  $("#subAppSave").addEventListener("click", async () => {
    const val = $("#subDate").value, time = $("#subTime").value, timezone = $("#subTz").value;
    if (!val || !time) return showErr("Please enter both a date and a time.");
    await persist({ _app_time: { val, time, timezone, eventDate: zonedTimeToUtcIso(val, time, timezone) } });
  });
  $("#subClose").addEventListener("click", closeIntakeForm);
  $("#subSubmit").addEventListener("click", async () => {
    const btn = $("#subSubmit");
    btn.disabled = true;
    errEl.classList.add("hidden");
    try {
      await onSubmit(formFieldsOnly(state), state._app_time);
    } catch (err) {
      showErr(err?.message || String(err));
      refresh();
      return;
    }
    closeIntakeForm();
  });

  refresh();
  ["form", "cal", "app"].forEach((k) => { if (done()[k]) $(`.sub-step[data-step="${k}"]`).classList.add("collapsed"); });
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
