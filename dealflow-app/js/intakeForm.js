// "Form" for the questionnaire-flow buyer's sellers (see clients.tracking_flow
// = 'questionnaire' and QUESTIONNAIRE_FLOW in js/clients.js). For that one
// buyer we're sourcing DATA from companies rather than the companies
// themselves, so the intro call is about the company's data and the form below
// is the equivalent of an intro call write-up. Fields mirror the public intake
// form at https://workingsignaldata.com/intake?full=1, plus two key questions
// that form doesn't ask outright (willing / able to sell).
//
// - Save: needs at least the 4 "key questions" (data they have, how much,
//   willing to sell, able to sell) — everything else can wait.
// - Submit form: only offered once every non-optional field is filled in. It
//   completes the client's intro call and tells the intake-submit edge function
//   to post the lead to Slack.
//
// Used from two places: Dials (before the client exists — see
// openQuestionnaireIntroPopup in js/dials.js, which just holds the answers
// until "Create client") and the Clients page ("Form" subtab and the Timeline
// intro-call check-off — see openClientIntakeForm in js/clients.js).

import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { defaultTimezone } from "./eventTime.js";

const DATA_TYPES = [
  "Customer and CRM",
  "Transactions and orders",
  "Customer support",
  "Operational or project data",
  "Email and internal communications",
  "Proposals and contracts",
  "Call recordings",
  "Documents and shared files",
  "Other",
];

// `minimum` = one of the 4 needed to save; `optional` = not needed to submit.
export const INTAKE_SECTIONS = [
  {
    title: "Key questions",
    note: "Answer at least these four to save.",
    fields: [
      { key: "data_types", label: "What data do they have?", type: "checkboxes", options: DATA_TYPES, minimum: true },
      {
        key: "data_volume",
        label: "How much of it do they have?",
        type: "select",
        options: ["Under 100 GB", "100–500 GB", "500 GB–1 TB", "1–10 TB", "More than 10 TB", "Unsure"],
        minimum: true,
      },
      { key: "willing_to_sell", label: "Are they willing to sell it?", type: "select", options: ["Yes", "Maybe", "No", "Unsure"], minimum: true },
      { key: "able_to_sell", label: "Are they able to sell it?", type: "select", options: ["Yes", "Needs confirmation", "No", "Unsure"], minimum: true },
    ],
  },
  {
    title: "Company",
    fields: [
      { key: "company_name", label: "Company name", type: "text" },
      { key: "company_website", label: "Company website", type: "text", optional: true },
      { key: "contact_name", label: "Contact name", type: "text" },
      { key: "contact_email", label: "Contact email", type: "email" },
      { key: "year_founded", label: "Year founded", type: "number" },
      { key: "employee_count", label: "Approx. employee count", type: "number" },
      { key: "company_does", label: "What does the company do?", type: "textarea", optional: true, hint: "A sentence or two is plenty." },
    ],
  },
  {
    title: "Data details",
    fields: [
      { key: "systems", label: "Which systems contain the data?", type: "text", hint: "Separate names with commas." },
      { key: "years_history", label: "Years of history available", type: "text" },
      { key: "data_central", label: "Is the data held centrally?", type: "select", options: ["Yes", "Mostly", "No", "Unsure"] },
      {
        key: "data_control",
        label: "Does the company control the data?",
        type: "select",
        options: ["Yes", "Probably, but needs confirmation", "Unsure"],
      },
      {
        key: "sensitive",
        label: "Does the data include sensitive information?",
        type: "checkboxes",
        options: ["Personal information", "Financial information", "Health information", "Confidential customer information", "None of these", "Unsure"],
      },
      { key: "licensing_restrictions", label: "Known restrictions on licensing or reuse?", type: "select", options: ["No", "Yes", "Unsure"] },
      {
        key: "stage",
        label: "Where are they in the process?",
        type: "select",
        options: [
          "Exploring what the data might be worth",
          "Interested in a preliminary bid",
          "Ready to discuss a transaction",
          "Working toward a specific deadline",
        ],
      },
      { key: "timing", label: "Timing or deadline", type: "text", optional: true },
      { key: "anything_else", label: "Anything else we should know?", type: "textarea", optional: true },
    ],
  },
];

const ALL_FIELDS = INTAKE_SECTIONS.flatMap((s) => s.fields);
const MINIMUM_FIELDS = ALL_FIELDS.filter((f) => f.minimum);

function isFilled(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export function missingMinimum(data) {
  return MINIMUM_FIELDS.filter((f) => !isFilled(data?.[f.key])).map((f) => f.label);
}
export function meetsMinimum(data) {
  return missingMinimum(data).length === 0;
}
export function isIntakeComplete(data) {
  return ALL_FIELDS.every((f) => f.optional || isFilled(data?.[f.key]));
}
export function countMinimum(data) {
  return MINIMUM_FIELDS.length - missingMinimum(data).length;
}

// Company fields the dial/client already knows, so the form starts pre-filled.
// Anything already saved on the form wins over these.
export function intakeDefaults(client, saved) {
  return {
    company_name: client?.company_name || "",
    company_website: client?.website || "",
    contact_name: client?.full_name || "",
    contact_email: client?.email || "",
    year_founded: client?.founded_year || "",
    employee_count: client?.employee_count || "",
    ...(saved || {}),
  };
}

// Plain-text "label: value" lines for the form's answers — used for the intro
// call's report on the Timeline.
export function intakeSummaryLines(data) {
  return ALL_FIELDS.filter((f) => isFilled(data?.[f.key])).map((f) => {
    const v = data[f.key];
    return `${f.label} ${Array.isArray(v) ? v.join(", ") : v}`;
  });
}

function fieldHTML(f, value) {
  const req = f.minimum || !f.optional ? " *" : "";
  const label = `<label>${escapeHtml(f.label)}${f.minimum ? ' <span class="intake-key">key</span>' : ""}</label>`;
  const hint = f.hint ? `<div class="help-text">${escapeHtml(f.hint)}</div>` : "";
  void req;
  if (f.type === "checkboxes") {
    const picked = new Set(Array.isArray(value) ? value : []);
    return `<div class="intake-field">${label}<div class="intake-checks">${f.options
      .map(
        (o) =>
          `<label class="intake-check"><input type="checkbox" data-key="${f.key}" value="${escapeHtml(o)}" ${picked.has(o) ? "checked" : ""} /> <span>${escapeHtml(o)}</span></label>`
      )
      .join("")}</div></div>`;
  }
  if (f.type === "select") {
    return `<div class="intake-field">${label}<select data-key="${f.key}"><option value="">Select…</option>${f.options
      .map((o) => `<option value="${escapeHtml(o)}" ${value === o ? "selected" : ""}>${escapeHtml(o)}</option>`)
      .join("")}</select></div>`;
  }
  if (f.type === "textarea") {
    return `<div class="intake-field">${label}${hint}<textarea data-key="${f.key}" rows="2">${escapeHtml(value ?? "")}</textarea></div>`;
  }
  return `<div class="intake-field">${label}${hint}<input type="${f.type}" data-key="${f.key}" value="${escapeHtml(value ?? "")}" ${
    f.type === "number" ? 'inputmode="numeric"' : ""
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

function closeModal() {
  if (!modalEl || modalEl.classList.contains("hidden")) return;
  modalEl.classList.add("hidden");
  unlockPageScroll();
  const cb = closeHandler;
  closeHandler = null;
  if (cb) cb();
}

// opts:
//  title        — popup heading
//  note         — optional line under the heading
//  data         — starting answers (already merged with intakeDefaults())
//  submittedAt  — ISO string if this form was already submitted
//  notified     — true when the Slack post already went out
//  saveLabel    — text of the save button ("Save")
//  onSave(data)   — async; throw to show the error inline. Closes the popup after.
//  onSubmit(data) — async; same. Omit to hide "Submit form" entirely.
//  onClose()    — called after the popup closes for any reason
export function openIntakeForm(opts) {
  ensureModal();
  const { title = "Intro call form", note, data = {}, submittedAt, notified, saveLabel = "Save", onSave, onSubmit, onClose } = opts;
  const box = modalEl.querySelector(".modal");
  const submittedLine = submittedAt
    ? `<p class="help-text intake-submitted">Submitted ${escapeHtml(new Date(submittedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}${
        notified ? " · sent to Slack" : " · not sent to Slack yet"
      }.</p>`
    : "";
  box.innerHTML = `
    <h2>${escapeHtml(title)}</h2>
    ${note ? `<p class="help-text">${escapeHtml(note)}</p>` : ""}
    ${submittedLine}
    ${INTAKE_SECTIONS.map(
      (s) => `
      <h3 class="intake-section-title">${escapeHtml(s.title)}</h3>
      ${s.note ? `<p class="help-text">${escapeHtml(s.note)}</p>` : ""}
      ${s.fields.map((f) => fieldHTML(f, data[f.key])).join("")}`
    ).join("")}
    <div class="error-msg hidden" id="intakeError"></div>
    <div class="form-actions intake-actions">
      <button type="button" class="btn secondary" id="intakeCancelBtn">Cancel</button>
      <button type="button" class="btn" id="intakeSaveBtn">${escapeHtml(saveLabel)}</button>
    </div>
    <div class="form-actions intake-submit-row ${onSubmit ? "" : "hidden"}" id="intakeSubmitRow">
      <button type="button" class="btn yellow" id="intakeSubmitBtn">${
        submittedAt && !notified ? "Send to Slack again" : submittedAt ? "Submit again" : "Submit form"
      }</button>
    </div>`;

  const errEl = box.querySelector("#intakeError");
  const saveBtn = box.querySelector("#intakeSaveBtn");
  const submitBtn = box.querySelector("#intakeSubmitBtn");
  const submitRow = box.querySelector("#intakeSubmitRow");

  const collect = () => {
    const out = {};
    ALL_FIELDS.forEach((f) => {
      if (f.type === "checkboxes") {
        out[f.key] = [...box.querySelectorAll(`input[data-key="${f.key}"]:checked`)].map((i) => i.value);
      } else {
        out[f.key] = (box.querySelector(`[data-key="${f.key}"]`)?.value || "").trim();
      }
    });
    return out;
  };
  // "Submit form" only exists once everything non-optional is filled in.
  const syncSubmit = () => {
    if (!onSubmit) return;
    submitRow.classList.toggle("hidden", !isIntakeComplete(collect()));
  };
  syncSubmit();
  box.addEventListener("input", syncSubmit);
  box.addEventListener("change", syncSubmit);

  const run = async (fn, mustHaveMinimum) => {
    const values = collect();
    if (mustHaveMinimum && !meetsMinimum(values)) {
      errEl.textContent = `Please fill in at least the four key questions. Missing: ${missingMinimum(values).join("; ")}.`;
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    saveBtn.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    try {
      await fn(values);
    } catch (err) {
      errEl.textContent = err?.message || String(err);
      errEl.classList.remove("hidden");
      saveBtn.disabled = false;
      if (submitBtn) submitBtn.disabled = false;
      return;
    }
    saveBtn.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
    closeModal();
  };

  box.querySelector("#intakeCancelBtn").addEventListener("click", closeModal);
  saveBtn.addEventListener("click", () => run((v) => onSave(v), true));
  if (onSubmit) submitBtn.addEventListener("click", () => run((v) => onSubmit(v), true));

  closeHandler = onClose || null;
  modalEl.classList.remove("hidden");
  modalEl.scrollTop = 0;
  lockPageScroll();
}

// ---------------------------------------------------------------------------
// Submitting a form for an EXISTING client (the Clients page, or Dials right
// after the client was created). Saves the answers, completes the client's
// intro call as of right now (using the existing intro_call event if there is
// one — otherwise a new one), then asks the intake-submit edge function to
// post the lead to Slack. Returns { slack: 'sent' | 'not_configured' | 'failed',
// error? } so the caller can mention a problem; the intro call is completed
// either way.
// ---------------------------------------------------------------------------
export async function submitIntakeForm(clientId, data, profile) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const timezone = defaultTimezone();
  const report = ["Intake form submitted.", ...intakeSummaryLines(data).map((l) => `• ${l}`)].join("\n");

  const { error: saveErr } = await supabase
    .from("clients")
    .update({ intake_form: data, intake_submitted_at: now.toISOString() })
    .eq("id", clientId);
  if (saveErr) throw saveErr;

  // The client's intro call: prefer one that isn't completed yet; otherwise any.
  const { data: events, error: evErr } = await supabase
    .from("client_events")
    .select("id, confirmed, details, event_date")
    .eq("client_id", clientId)
    .eq("event_type", "intro_call")
    .order("event_date", { ascending: false });
  if (evErr) throw evErr;
  const existing = (events || []).find((e) => !e.confirmed) || (events || [])[0];
  let eventId = existing?.id;
  if (!eventId) {
    const { data: ev, error } = await supabase
      .from("client_events")
      .insert({
        client_id: clientId,
        event_type: "intro_call",
        event_date: now.toISOString(),
        details: { via: "form", time: `${hh}:${mm}`, timezone },
        created_by: profile.id,
      })
      .select("id")
      .single();
    if (error) throw error;
    eventId = ev.id;
  } else if (!existing.confirmed) {
    // Completing via the form counts as the intro call happening now.
    const { error } = await supabase
      .from("client_events")
      .update({ event_date: now.toISOString(), details: { ...(existing.details || {}), via: "form", time: `${hh}:${mm}`, timezone } })
      .eq("id", eventId);
    if (error) throw error;
  }
  if (!existing?.confirmed) {
    const { error } = await supabase.rpc("set_client_event_confirmed", { p_event_id: eventId, p_confirmed: true, p_report: report });
    if (error) throw error;
  }

  // Slack (and later Airtable) — never blocks or undoes the completed call.
  try {
    const { data: res, error } = await supabase.functions.invoke("intake-submit", { body: { client_id: clientId } });
    if (error) {
      let msg = error.message;
      try {
        msg = (await error.context.json()).error || msg;
      } catch {
        // keep the generic message
      }
      return { slack: "failed", error: msg };
    }
    return { slack: res?.slack || "sent", error: res?.error };
  } catch (err) {
    return { slack: "failed", error: err?.message || String(err) };
  }
}
