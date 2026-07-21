import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";
import {
  escapeHtml,
  lookingForLabel,
  defaultClient,
  buildEditableSections,
  wireEditableFormEvents,
  collectFormData,
  getMissingFields,
} from "./clientForm.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;
const isLead = profile.role === "team_lead";

const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let clients = [];
let currentClient = null; // null while creating a new client
let currentMode = "create"; // 'create' | 'view' | 'edit'
let currentTab = "profile"; // 'profile' | 'progress' | 'timeline'
let events = [];

const els = {
  errorBox: document.getElementById("errorBox"),
  tableWrap: document.getElementById("tableWrap"),
  search: document.getElementById("search"),
  countBadge: document.getElementById("countBadge"),
  addBtn: document.getElementById("addBtn"),
  clientModal: document.getElementById("clientModal"),
  clientModalTitle: document.getElementById("clientModalTitle"),
  clientModalBody: document.getElementById("clientModalBody"),
  clientModalClose: document.getElementById("clientModalClose"),
  clientSubtabs: document.getElementById("clientSubtabs"),
  requiredPopup: document.getElementById("requiredPopup"),
  requiredPopupText: document.getElementById("requiredPopupText"),
  requiredPopupOk: document.getElementById("requiredPopupOk"),
  eventPopup: document.getElementById("eventPopup"),
  eventPopupTitle: document.getElementById("eventPopupTitle"),
  eventPopupBody: document.getElementById("eventPopupBody"),
  eventPopupClose: document.getElementById("eventPopupClose"),
};

function fmtNum(n) {
  return n === null || n === undefined || n === "" ? "0" : Number(n).toLocaleString();
}
function monthName(m) {
  return MONTH_NAMES[m] || "";
}
function clientDisplayName(c) {
  return `${c.first_name || ""} ${c.last_name || ""}`.trim() || "—";
}
function clientLocation(c) {
  return [c.city, c.state].filter(Boolean).join(", ") || "—";
}
function clientSecondary(c) {
  if (c.client_type === "seller") return c.company_name || "—";
  if (c.money_to_spend_min != null || c.money_to_spend_max != null) {
    return `$${fmtNum(c.money_to_spend_min)} – $${fmtNum(c.money_to_spend_max)}`;
  }
  return "—";
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

async function loadClients() {
  const { data, error } = await supabase.from("clients").select("*").order("created_at", { ascending: false });
  if (error) return showError(els.errorBox, error);
  clients = data || [];
  renderTable();
}

function renderTable() {
  const q = els.search.value.trim().toLowerCase();
  const rows = clients.filter(
    (c) =>
      !q ||
      clientDisplayName(c).toLowerCase().includes(q) ||
      (c.company_name || "").toLowerCase().includes(q) ||
      (c.industry || "").toLowerCase().includes(q)
  );
  els.countBadge.textContent = `${rows.length} client${rows.length === 1 ? "" : "s"}`;

  if (rows.length === 0) {
    els.tableWrap.innerHTML = `<div class="empty-state">No clients yet — tap + to add one.</div>`;
    return;
  }

  els.tableWrap.innerHTML = `
    <table>
      <thead>
        <tr><th>Name</th><th>Type</th><th>Company / Money to spend</th><th>Location</th><th>Intern's name</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (c) => `
          <tr class="clickable-row" data-id="${c.id}">
            <td>${escapeHtml(clientDisplayName(c))}</td>
            <td><span class="pill ${c.client_type === "buyer" ? "active" : "new"}">${escapeHtml(c.client_type)}</span></td>
            <td class="muted">${escapeHtml(clientSecondary(c))}</td>
            <td class="muted">${escapeHtml(clientLocation(c))}</td>
            <td class="muted">${escapeHtml(c.intern_name || "—")}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;

  els.tableWrap.querySelectorAll("[data-id]").forEach((row) => {
    row.addEventListener("click", () => openDetailModal(clients.find((c) => c.id === row.dataset.id)));
  });
}

els.search.addEventListener("input", renderTable);

// ---------------------------------------------------------------------------
// Field sections — shared between "new client" and the Profile tab
// ---------------------------------------------------------------------------

function rf(label, value) {
  const v = value === null || value === undefined || value === "" ? "" : String(value);
  return `<div class="readonly-field"><div class="rf-label">${escapeHtml(label)}</div><div class="rf-value ${v ? "" : "empty"}">${v ? escapeHtml(v) : "Not provided"}</div></div>`;
}

const CONTACT_ICONS = {
  sms: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  tel: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  mailto: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>',
};

// Read-only phone/email field with "text / call / email" quick-action icons.
// Only used in view mode — these actions are hidden while editing.
function rfContact(label, value, kind) {
  const v = value ? String(value) : "";
  let actionsHTML = "";
  if (v) {
    if (kind === "phone") {
      actionsHTML = `
        <div class="contact-actions">
          <a class="contact-action-btn" href="sms:${escapeHtml(v)}" title="Text">${CONTACT_ICONS.sms}</a>
          <a class="contact-action-btn" href="tel:${escapeHtml(v)}" title="Call">${CONTACT_ICONS.tel}</a>
        </div>`;
    } else if (kind === "email") {
      actionsHTML = `
        <div class="contact-actions">
          <a class="contact-action-btn" href="mailto:${escapeHtml(v)}" title="Email">${CONTACT_ICONS.mailto}</a>
        </div>`;
    }
  }
  return `
    <div class="readonly-field">
      <div class="rf-label">${escapeHtml(label)}</div>
      <div class="rf-value-row">
        <div class="rf-value ${v ? "" : "empty"}">${v ? escapeHtml(v) : "Not provided"}</div>
        ${actionsHTML}
      </div>
    </div>`;
}

function buildReadonlySections(client, showEditButton) {
  const type = client.client_type;
  const location = [client.city, client.state].filter(Boolean).join(", ");
  const founded = client.founded_year ? `${monthName(client.founded_month)} ${client.founded_year}` : "";
  return `
    <div class="accordion-section open" data-section="personal">
      <div class="accordion-header">
        <div class="accordion-header-left">
          <span>Personal information</span>
          ${showEditButton ? `<button type="button" class="edit-icon-btn inline" id="editProfileBtn" title="Edit profile">&#9998;</button>` : ""}
        </div>
        <span class="chevron">&#9662;</span>
      </div>
      <div class="accordion-body">
        ${rf("First name", client.first_name)}
        ${rf("Last name", client.last_name)}
        ${rf("Buyer / Seller", type === "seller" ? "Seller" : "Buyer")}
        ${rf("Location", location)}
        ${rf("Intern's name", client.intern_name)}
      </div>
    </div>
    <div class="accordion-section" data-section="contact">
      <div class="accordion-header"><span>Contact information</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        ${rfContact("Email", client.email, "email")}
        ${rfContact("Phone number", client.phone, "phone")}
        ${rf("LinkedIn", client.linkedin)}
      </div>
    </div>
    <div class="accordion-section" data-section="company">
      <div class="accordion-header"><span>${type === "seller" ? "Company details" : "Investment details"}</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        ${
          type === "seller"
            ? `
          ${rf("Company name", client.company_name)}
          ${rf("Industry sector", client.industry)}
          ${rf("Annual revenue", client.annual_revenue != null ? `$${Number(client.annual_revenue).toLocaleString()}` : "")}
          ${rf("Employees", client.employee_count)}
          ${rf("Founded", founded)}
        `
            : `
          ${rf("Money to spend (range)", client.money_to_spend_min != null || client.money_to_spend_max != null ? `$${fmtNum(client.money_to_spend_min)} – $${fmtNum(client.money_to_spend_max)}` : "")}
        `
        }
      </div>
    </div>
    <div class="accordion-section" data-section="preferences">
      <div class="accordion-header"><span>Preferences</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        ${rf(lookingForLabel(type), client.looking_for)}
      </div>
    </div>
    <div class="accordion-section" data-section="notes">
      <div class="accordion-header"><span>Other notes</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        ${rf("Notes", client.other_notes)}
      </div>
    </div>
  `;
}

function wireAccordions() {
  els.clientModalBody.querySelectorAll(".accordion-header").forEach((header) => {
    header.addEventListener("click", () => {
      header.parentElement.classList.toggle("open");
    });
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function clearFieldErrors() {
  els.clientModalBody.querySelectorAll(".field-required-msg").forEach((el) => el.classList.add("hidden"));
}

function validateAndCollect() {
  const data = collectFormData(els.clientModalBody);
  clearFieldErrors();
  const { missing, popupLabels } = getMissingFields(data);
  if (missing.length) {
    missing.forEach((key) => {
      const el = els.clientModalBody.querySelector(`.field-required-msg[data-field="${key}"]`);
      if (el) el.classList.remove("hidden");
    });
    els.requiredPopupText.textContent = `Please fill out the missing information. The following is required: ${popupLabels.join(", ")}.`;
    els.requiredPopup.classList.remove("hidden");
    return null;
  }
  return data;
}

els.requiredPopupOk.addEventListener("click", () => els.requiredPopup.classList.add("hidden"));

// ---------------------------------------------------------------------------
// Timeline tab
// ---------------------------------------------------------------------------

function eventTypeLabel(t) {
  if (t === "created") return "Client profile created";
  if (t === "intro_call") return "Intro Call";
  return t;
}
function formatEventDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function loadEvents(clientId) {
  const { data, error } = await supabase
    .from("client_events")
    .select("*")
    .eq("client_id", clientId)
    .order("event_date", { ascending: false });
  events = error ? [] : data || [];
}

function buildTimelineHTML() {
  const itemsHTML =
    events.length === 0
      ? `<div class="empty-state">No events yet.</div>`
      : events
          .map(
            (ev) => `
        <div class="timeline-item">
          <div class="timeline-line"></div>
          <div class="timeline-dot"></div>
          <div class="timeline-box">
            <div class="tl-date">${escapeHtml(formatEventDate(ev.event_date))}</div>
            <div class="tl-type">${escapeHtml(eventTypeLabel(ev.event_type))}</div>
          </div>
        </div>`
          )
          .join("");

  return `
    <div class="timeline-list">
      ${itemsHTML}
    </div>
    <button type="button" class="timeline-add-btn" id="timelineAddBtn" title="Add event">+</button>
    <div class="timeline-add-menu hidden" id="timelineAddMenu">
      <button type="button" id="addIntroCallBtn">Intro Call</button>
    </div>
  `;
}

function wireTimelineEvents() {
  const addBtn = document.getElementById("timelineAddBtn");
  const menu = document.getElementById("timelineAddMenu");
  if (!addBtn) return;
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", () => menu.classList.add("hidden"), { once: true });
  document.getElementById("addIntroCallBtn").addEventListener("click", () => {
    menu.classList.add("hidden");
    els.eventPopupTitle.textContent = "Intro Call";
    els.eventPopupBody.innerHTML = `<p class="help-text">Intro call details coming soon.</p>`;
    els.eventPopup.classList.remove("hidden");
  });
}

els.eventPopupClose.addEventListener("click", () => els.eventPopup.classList.add("hidden"));

// ---------------------------------------------------------------------------
// Modal rendering / mode switching
// ---------------------------------------------------------------------------

function updateSubtabActiveState() {
  els.clientSubtabs.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === currentTab);
  });
}

function renderModalBody() {
  els.clientSubtabs.classList.toggle("hidden", currentMode === "create");

  if (currentMode === "create") {
    els.clientModalTitle.textContent = "New client";
    els.clientModalBody.innerHTML = `
      <div id="clientModalError" class="error-msg hidden"></div>
      ${buildEditableSections(defaultClient(profile))}
      <div class="form-actions">
        <button type="button" class="btn" id="saveClientBtn">Save</button>
        <button type="button" class="btn secondary" id="cancelClientBtn">Cancel</button>
      </div>
    `;
    wireEditableFormEvents(els.clientModalBody);
    document.getElementById("saveClientBtn").addEventListener("click", handleCreateSave);
    document.getElementById("cancelClientBtn").addEventListener("click", closeModal);
    return;
  }

  els.clientModalTitle.textContent = clientDisplayName(currentClient);
  updateSubtabActiveState();

  if (currentTab === "profile") {
    els.clientModalBody.innerHTML = `
      <div id="clientModalError" class="error-msg hidden"></div>
      ${currentMode === "edit" ? buildEditableSections(currentClient) : buildReadonlySections(currentClient, true)}
      ${
        currentMode === "edit"
          ? `<div class="form-actions">
          <button type="button" class="btn" id="saveClientBtn">Save</button>
          <button type="button" class="btn secondary" id="cancelClientBtn">Cancel</button>
          ${isLead ? `<button type="button" class="btn danger" id="deleteClientBtn" style="margin-left:auto;">Delete</button>` : ""}
        </div>`
          : ""
      }
    `;
    if (currentMode === "edit") {
      wireEditableFormEvents(els.clientModalBody);
      document.getElementById("saveClientBtn").addEventListener("click", handleEditSave);
      document.getElementById("cancelClientBtn").addEventListener("click", () => {
        currentMode = "view";
        renderModalBody();
      });
      const delBtn = document.getElementById("deleteClientBtn");
      if (delBtn) delBtn.addEventListener("click", handleDelete);
    } else {
      wireAccordions();
      document.getElementById("editProfileBtn").addEventListener("click", (e) => {
        e.stopPropagation();
        currentMode = "edit";
        renderModalBody();
      });
    }
  } else if (currentTab === "progress") {
    els.clientModalBody.innerHTML = `<div class="empty-state">Progress tracking is coming soon.</div>`;
  } else if (currentTab === "timeline") {
    els.clientModalBody.innerHTML = buildTimelineHTML();
    wireTimelineEvents();
  }
}

async function handleCreateSave() {
  const data = validateAndCollect();
  if (!data) return;
  data.assigned_to = profile.id;
  const { error } = await supabase.from("clients").insert(data);
  if (error) return showError(document.getElementById("clientModalError"), error);
  closeModal();
  await loadClients();
}

async function handleEditSave() {
  const data = validateAndCollect();
  if (!data) return;
  const { error } = await supabase.from("clients").update(data).eq("id", currentClient.id);
  if (error) return showError(document.getElementById("clientModalError"), error);
  Object.assign(currentClient, data);
  currentMode = "view";
  renderModalBody();
  await loadClients();
}

async function handleDelete() {
  if (!confirm("Delete this client? This cannot be undone.")) return;
  const { error } = await supabase.from("clients").delete().eq("id", currentClient.id);
  if (error) return showError(document.getElementById("clientModalError"), error);
  closeModal();
  await loadClients();
}

function openCreateModal() {
  currentClient = null;
  currentMode = "create";
  currentTab = "profile";
  events = [];
  els.clientModal.classList.remove("hidden");
  renderModalBody();
}

async function openDetailModal(client) {
  currentClient = client;
  currentMode = "view";
  currentTab = "profile";
  events = [];
  els.clientModal.classList.remove("hidden");
  renderModalBody();
}

function closeModal() {
  els.clientModal.classList.add("hidden");
}

els.addBtn.addEventListener("click", openCreateModal);
els.clientModalClose.addEventListener("click", closeModal);

els.clientSubtabs.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (currentMode === "create" || !currentClient) return;
    currentTab = btn.dataset.tab;
    currentMode = "view";
    if (currentTab === "timeline") await loadEvents(currentClient.id);
    renderModalBody();
  });
});

await loadClients();
