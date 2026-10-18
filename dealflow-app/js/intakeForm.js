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

// Every field below is a column of the leads Google Sheet (same names and
// dropdown values as its "Answer Options" tab) or an input on
// https://workingsignaldata.com/intake?full=1 — apart from the two app-only
// key questions (willing / able to sell), which are NOT published to the
// sheet. "Date Called" isn't an input: it's stamped when the form is submitted.
const STATUSES = ["Not Reached", "Left Voicemail", "Callback Scheduled", "Qualified", "Form Submitted", "Not a Fit"];
const EMPLOYEES = ["1–10", "11–25", "26–50", "51–100", "101–250", "251–500", "500+"];
const KINDS_OF_DATA = [
  "Email",
  "CRM and sales",
  "Customer service",
  "Jobs and operations",
  "Accounting and transactions",
  "Internal messages",
  "Documents and shared files",
  "E-commerce",
  "Images / audio / video",
  "Other",
];
const SYSTEMS = ["Gmail", "Outlook", "Salesforce", "HubSpot", "QuickBooks", "Google Drive", "SharePoint", "Slack", "Shopify", "Zendesk"];
const WORKFLOW_CATEGORIES = ["Sales", "Customer service", "Jobs or service delivery", "E-commerce orders", "Manufacturing", "Finance", "Other"];
const ENGLISH = ["Yes", "Mostly", "Mixed", "No", "Unsure"];
const CAN_LICENSE = ["Yes", "Needs review", "Unsure"];
const DE_ID = ["Nothing known", "Personal information", "Health information", "Financial information", "Confidential customer information", "Unsure"];
const EXPORT_SPEED = ["Immediately", "Within 2 weeks", "Within 1 month", "Need help", "Unsure"];

// `minimum` = one of the 4 needed to save; `optional` = not needed to submit;
// `alsoKey` = this field counts as filled if that other field is.
export const INTAKE_SECTIONS = [
  {
    title: "Key questions",
    note: "Answer at least these four to save.",
    fields: [
      { key: "data_types", label: "Kinds of Data — what data do they have?", type: "checkboxes", options: KINDS_OF_DATA, minimum: true },
      { key: "data_amount", label: "Amount of Data — how much do they have?", type: "text", hint: "For example: About 40GB.", minimum: true },
      { key: "willing_to_sell", label: "Are they willing to sell it?", type: "select", options: ["Yes", "Maybe", "No", "Unsure"], minimum: true, appOnly: true },
      { key: "able_to_sell", label: "Are they able to sell it?", type: "select", options: ["Yes", "Needs confirmation", "No", "Unsure"], minimum: true, appOnly: true },
    ],
  },
  {
    title: "About the company",
    fields: [
      { key: "status", label: "Status", type: "select", options: STATUSES, optional: true, hint: "Leave blank to publish as Form Submitted." },
      { key: "company_name", label: "Company Name", type: "text" },
      { key: "company_website", label: "Website", type: "text" },
      { key: "contact_name", label: "Contact Name", type: "text" },
      { key: "contact_email", label: "Business Email", type: "email" },
      { key: "contact_phone", label: "Phone Number", type: "tel" },
      { key: "employees", label: "Employees", type: "select", options: EMPLOYEES },
      { key: "company_does", label: "What does the company do?", type: "textarea", hint: "One or two sentences is enough." },
      { key: "years_in_business", label: "Years in Business", type: "number" },
    ],
  },
  {
    title: "Their data",
    fields: [
      { key: "systems", label: "Systems — which systems contain it?", type: "checkboxes", options: SYSTEMS, alsoKey: "other_systems" },
      { key: "other_systems", label: "Other systems (type them in, separated by commas)", type: "text", optional: true },
      { key: "workflow", label: "Typical Workflow", type: "textarea", hint: "Give one simple example from start to finish." },
      { key: "workflow_category", label: "Workflow Category — which workflow is that closest to?", type: "select", options: WORKFLOW_CATEGORIES },
      {
        key: "unique_data",
        label: "Unique or Hard-to-Find Data",
        type: "textarea",
        optional: true,
        hint: "Anything that could be difficult for an AI company to find elsewhere.",
      },
    ],
  },
  {
    title: "Final checks",
    fields: [
      { key: "mostly_english", label: "Mostly English? — is most of the data in English?", type: "select", options: ENGLISH },
      { key: "can_license", label: "Can License for AI? — can the company license this data for AI use?", type: "select", options: CAN_LICENSE },
      { key: "deid", label: "Needs Removal / De-ID — what may need to be removed or de-identified?", type: "checkboxes", options: DE_ID },
      { key: "export_speed", label: "Export Speed — how quickly could they provide an export?", type: "select", options: EXPORT_SPEED },
      { key: "notes", label: "Notes", type: "textarea", optional: true },
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
  return ALL_FIELDS.every((f) => f.optional || isFilled(data?.[f.key]) || (f.alsoKey && isFilled(data?.[f.alsoKey])));
}
export function countMinimum(data) {
  return MINIMUM_FIELDS.length - missingMinimum(data).length;
}

// Same buckets as the Employees dropdown.
function employeeRange(n) {
  const v = Number(n);
  if (!v || v < 1) return "";
  if (v <= 10) return EMPLOYEES[0];
  if (v <= 25) return EMPLOYEES[1];
  if (v <= 50) return EMPLOYEES[2];
  if (v <= 100) return EMPLOYEES[3];
  if (v <= 250) return EMPLOYEES[4];
  if (v <= 500) return EMPLOYEES[5];
  return EMPLOYEES[6];
}

// Company fields the dial/client already knows, so the form starts pre-filled.
// Anything already saved on the form wins over these.
export function intakeDefaults(client, saved) {
  const founded = Number(client?.founded_year);
  return {
    company_name: client?.company_name || "",
    company_website: client?.website || "",
    contact_name: client?.full_name || "",
    contact_email: client?.email || "",
    contact_phone: client?.mobile_phone || client?.company_phone || client?.phone || "",
    employees: employeeRange(client?.employee_count),
    years_in_business: founded > 1800 ? String(new Date().getFullYear() - founded) : "",
    ...(saved || {}),
  };
}

// Plain-text "label: value" lines for the form's answers — used for the intro
// call's report on the Timeline.
export function intakeSummaryLines(data) {
  return ALL_FIELDS.filter((f) => isFilled(data?.[f.key])).map((f) => {
    const v = data[f.key];
    return `${f.label}: ${Array.isArray(v) ? v.join(", ") : v}`;
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
        notified ? " · sent" : " · not fully sent yet"
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
        submittedAt && !notified ? "Send again" : submittedAt ? "Submit again" : "Submit form"
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
// send the lead to Slack and the leads Google Sheet. Returns
// { slack, sheet, errors } (each 'sent' | 'already_sent' | 'not_configured' |
// 'failed') — pass it to describeDelivery() for a message about any problem;
// the intro call is completed either way.
// ---------------------------------------------------------------------------
export async function submitIntakeForm(clientId, data, profile) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const timezone = defaultTimezone();
  const report = ["Intake form submitted.", ...intakeSummaryLines(data).map((l) => `• ${l}`)].join("\n");

  // "Date Called" column of the leads sheet — the local calendar day of submission.
  const dateCalled = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  data = { ...data, date_called: dateCalled };

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

  // Slack + Google Sheet — never blocks or undoes the completed call.
  try {
    const { data: res, error } = await supabase.functions.invoke("intake-submit", { body: { client_id: clientId } });
    if (error) {
      let msg = error.message;
      try {
        msg = (await error.context.json()).error || msg;
      } catch {
        // keep the generic message
      }
      return { slack: "failed", sheet: "failed", errors: { slack: msg, sheet: msg } };
    }
    return { slack: res?.slack || "failed", sheet: res?.sheet || "failed", errors: res?.errors || {} };
  } catch (err) {
    const msg = err?.message || String(err);
    return { slack: "failed", sheet: "failed", errors: { slack: msg, sheet: msg } };
  }
}

// Returns text explaining what didn't go out, or null when everything that's
// connected was delivered (and at least one destination is connected).
export function describeDelivery(result) {
  const names = { slack: "Slack", sheet: "the Google Sheet" };
  const failed = Object.keys(names).filter((k) => result[k] === "failed");
  const missing = Object.keys(names).filter((k) => result[k] === "not_configured");
  const ok = Object.keys(names).filter((k) => result[k] === "sent" || result[k] === "already_sent" || result[k] === "updated");
  if (!failed.length && !missing.length) return null;
  if (!failed.length && ok.length) return null; // the connected one(s) worked; the other just isn't set up
  const parts = [];
  if (failed.length) parts.push(failed.map((k) => `posting to ${names[k]} failed: ${result.errors?.[k] || "unknown error"}`).join("; "));
  if (missing.length && !ok.length) {
    const who = missing.map((k) => names[k]).join(" and ");
    parts.push(`${who.charAt(0).toUpperCase()}${who.slice(1)} ${missing.length > 1 ? "aren't" : "isn't"} connected yet`);
  }
  return `${parts.join(". ")}. Open the client's Form and use "Send again" to retry.`;
}
