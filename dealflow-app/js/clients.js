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
import { buildIntroCallFormHTML, wireIntroCallForm } from "./introCall.js";
import { rfContact, contactActionIcons, stopContactActionPropagation } from "./contactIcons.js";
import { wirePageHeaderMenu } from "./pageHeaderMenu.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile, user } = session;
const internEmail = user?.email || "";

const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let clients = [];
let currentClient = null; // null while creating a new client
let currentMode = "create"; // 'create' | 'view' | 'edit'
let currentTab = "profile"; // 'profile' | 'progress' | 'timeline'
let events = [];

const els = {
  errorBox: document.getElementById("errorBox"),
  pageMenuToggle: document.getElementById("pageMenuToggle"),
  pageHeaderMenu: document.getElementById("pageHeaderMenu"),
  tableWrap: document.getElementById("tableWrap"),
  search: document.getElementById("search"),
  countBadge: document.getElementById("countBadge"),
  addBtn: document.getElementById("addBtn"),
  clientModal: document.getElementById("clientModal"),
  clientModalTitle: document.getElementById("clientModalTitle"),
  clientModalBody: document.getElementById("clientModalBody"),
  clientModalClose: document.getElementById("clientModalClose"),
  editProfileBtn: document.getElementById("editProfileBtn"),
  clientSubtabs: document.getElementById("clientSubtabs"),
  requiredPopup: document.getElementById("requiredPopup"),
  requiredPopupText: document.getElementById("requiredPopupText"),
  requiredPopupOk: document.getElementById("requiredPopupOk"),
  eventPopup: document.getElementById("eventPopup"),
  eventPopupTitle: document.getElementById("eventPopupTitle"),
  eventPopupBody: document.getElementById("eventPopupBody"),
  eventPopupClose: document.getElementById("eventPopupClose"),
  confirmDeleteModal: document.getElementById("confirmDeleteModal"),
};

function openConfirmDelete(onConfirm) {
  els.confirmDeleteModal.classList.remove("hidden");
  const yesBtn = document.getElementById("confirmDeleteYesBtn");
  const noBtn = document.getElementById("confirmDeleteNoBtn");
  const cleanup = () => {
    els.confirmDeleteModal.classList.add("hidden");
    yesBtn.removeEventListener("click", onYes);
    noBtn.removeEventListener("click", onNo);
  };
  const onYes = () => {
    cleanup();
    onConfirm();
  };
  const onNo = () => cleanup();
  yesBtn.addEventListener("click", onYes);
  noBtn.addEventListener("click", onNo);
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
  return c.company_name || "—";
}
// "Company name, City, State" (or just location if no company) — used in the
// mobile card list's subtitle line.
function clientCompanyAndLocation(c) {
  const loc = clientLocation(c);
  return [c.company_name || "", loc === "—" ? "" : loc].filter(Boolean).join(", ");
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
        <tr><th>Name</th><th>Company</th><th>Location</th><th>Intern's name</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (c) => `
          <tr class="clickable-row" data-id="${c.id}">
            <td data-label="Name">${escapeHtml(clientDisplayName(c))}</td>
            <td class="muted" data-label="Company">${escapeHtml(clientSecondary(c))}</td>
            <td class="muted" data-label="Location">${escapeHtml(clientLocation(c))}</td>
            <td class="muted" data-label="Intern's name">${escapeHtml(c.intern_name || "—")}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>

    <!-- Mobile-only simplified card list (shown instead of the table below
         the 720px breakpoint — see css/style.css). No column labels: just
         the name, then company + location, then instant-contact icons. -->
    <div class="mobile-list">
      ${rows
        .map(
          (c) => `
        <div class="mobile-card clickable-row" data-id="${c.id}">
          <div class="mc-main">
            <div class="mc-name">${escapeHtml(clientDisplayName(c))}</div>
            <div class="mc-sub">${escapeHtml(clientCompanyAndLocation(c))}</div>
          </div>
          ${contactActionIcons({ phone: c.phone, email: c.email })}
        </div>`
        )
        .join("")}
    </div>
  `;

  els.tableWrap.querySelectorAll("[data-id]").forEach((row) => {
    row.addEventListener("click", () => openDetailModal(clients.find((c) => c.id === row.dataset.id)));
  });
  stopContactActionPropagation(els.tableWrap);
}

els.search.addEventListener("input", renderTable);

// ---------------------------------------------------------------------------
// Field sections — shared between "new client" and the Profile tab
// ---------------------------------------------------------------------------

function rf(label, value) {
  const v = value === null || value === undefined || value === "" ? "" : String(value);
  return `<div class="readonly-field"><div class="rf-label">${escapeHtml(label)}</div><div class="rf-value ${v ? "" : "empty"}">${v ? escapeHtml(v) : "Not provided"}</div></div>`;
}

function buildReadonlySections(client) {
  const location = [client.city, client.state].filter(Boolean).join(", ");
  const founded = client.founded_year ? `${monthName(client.founded_month)} ${client.founded_year}` : "";
  return `
    <div class="accordion-section open" data-section="personal">
      <div class="accordion-header">
        <span>Personal information</span>
        <span class="chevron">&#9662;</span>
      </div>
      <div class="accordion-body">
        ${rf("First name", client.first_name)}
        ${rf("Last name", client.last_name)}
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
      <div class="accordion-header"><span>Company details</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        ${rf("Company name", client.company_name)}
        ${rf("Industry sector", client.industry)}
        ${rf("Annual revenue", client.annual_revenue != null ? `$${Number(client.annual_revenue).toLocaleString()}` : "")}
        ${rf("Employees", client.employee_count)}
        ${rf("Founded", founded)}
      </div>
    </div>
    <div class="accordion-section" data-section="preferences">
      <div class="accordion-header"><span>Preferences</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        ${rf(lookingForLabel(), client.looking_for)}
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
    els.eventPopupBody.innerHTML = buildIntroCallFormHTML();
    els.eventPopup.classList.remove("hidden");
    wireIntroCallForm(els.eventPopupBody, {
      client: currentClient,
      internEmail,
      onScheduled: async () => {
        // We don't know the actual booked time here (Calendly handles that in
        // its own tab), so this just logs that the link was opened,
        // timestamped to now.
        await supabase.from("client_events").insert({
          client_id: currentClient.id,
          event_type: "intro_call",
          event_date: new Date().toISOString(),
          details: { via: "calendly_link" },
          created_by: profile.id,
        });
        setTimeout(async () => {
          els.eventPopup.classList.add("hidden");
          if (currentTab === "timeline") {
            await loadEvents(currentClient.id);
            renderModalBody();
          }
        }, 1200);
      },
    });
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

// Progress and Timeline sub-tabs are hidden for now (code kept intact for
// when they're re-enabled) — the sub-tab bar itself stays hidden always, so
// Profile is the only view shown.
const SUBTABS_ENABLED = false;

function renderModalBody() {
  els.clientSubtabs.classList.toggle("hidden", !SUBTABS_ENABLED || currentMode === "create");
  // Edit icon lives in the header (left of the x), not beside "Personal
  // information" — only shown in view mode.
  els.editProfileBtn.classList.toggle("hidden", currentMode !== "view");

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
      ${currentMode === "edit" ? buildEditableSections(currentClient) : buildReadonlySections(currentClient)}
      ${
        currentMode === "edit"
          ? `<div class="form-actions">
          <button type="button" class="btn" id="saveClientBtn">Save</button>
          <button type="button" class="btn secondary" id="cancelClientBtn">Cancel</button>
          <button type="button" class="btn danger" id="deleteClientBtn" style="margin-left:auto;">Delete</button>
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

function handleDelete() {
  openConfirmDelete(async () => {
    const { error } = await supabase.from("clients").delete().eq("id", currentClient.id);
    if (error) return showError(document.getElementById("clientModalError"), error);
    closeModal();
    await loadClients();
  });
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
wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu });
els.editProfileBtn.addEventListener("click", () => {
  currentMode = "edit";
  renderModalBody();
});

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
