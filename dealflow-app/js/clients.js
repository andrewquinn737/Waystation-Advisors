import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;
const isLead = profile.role === "team_lead";

const STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
  "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri",
  "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York",
  "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming", "Not in the US",
];

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

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtNum(n) {
  return n === null || n === undefined || n === "" ? "0" : Number(n).toLocaleString();
}
function monthName(m) {
  return MONTH_NAMES[m] || "";
}
function lookingForLabel(type) {
  return type === "seller" ? "What they're looking for in a buyer" : "What they're looking for in a seller";
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

function defaultClient() {
  return {
    first_name: "", last_name: "", client_type: "buyer", city: "", state: "",
    email: "", phone: "", linkedin: "", company_name: "", industry: "",
    annual_revenue: null, employee_count: null, founded_year: null, founded_month: null,
    money_to_spend_min: null, money_to_spend_max: null, looking_for: "", other_notes: "",
    intern_name: profile.full_name,
  };
}

function buildEditableSections(client) {
  const type = client.client_type || "buyer";
  const founded = client.founded_year ? `${client.founded_year}-${String(client.founded_month || 1).padStart(2, "0")}` : "";
  return `
    <div class="accordion-section open" data-section="personal">
      <div class="accordion-header"><span>Personal information</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="form-row">
          <div>
            <div class="field-label-row"><label for="f_first_name">First name</label><span class="field-required-msg hidden" data-field="first_name">required</span></div>
            <input id="f_first_name" value="${escapeHtml(client.first_name)}" />
          </div>
          <div>
            <div class="field-label-row"><label for="f_last_name">Last name</label><span class="field-required-msg hidden" data-field="last_name">required</span></div>
            <input id="f_last_name" value="${escapeHtml(client.last_name)}" />
          </div>
        </div>
        <div class="field-label-row"><label for="f_client_type">Buyer / Seller</label><span class="field-required-msg hidden" data-field="client_type">required</span></div>
        <select id="f_client_type">
          <option value="buyer" ${type === "buyer" ? "selected" : ""}>Buyer</option>
          <option value="seller" ${type === "seller" ? "selected" : ""}>Seller</option>
        </select>
        <div class="form-row">
          <div>
            <div class="field-label-row"><label for="f_city">City</label><span class="field-required-msg hidden" data-field="city">required</span></div>
            <input id="f_city" value="${escapeHtml(client.city)}" />
          </div>
          <div>
            <div class="field-label-row"><label for="f_state">State</label><span class="field-required-msg hidden" data-field="state">required</span></div>
            <select id="f_state">
              <option value="">Select a state...</option>
              ${STATES.map((s) => `<option value="${s}" ${client.state === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="field-label-row"><label for="f_intern_name">Intern's name</label><span class="field-required-msg hidden" data-field="intern_name">required</span></div>
        <input id="f_intern_name" value="${escapeHtml(client.intern_name || profile.full_name)}" readonly style="background:var(--bg); color:var(--text-muted);" />
      </div>
    </div>

    <div class="accordion-section" data-section="contact">
      <div class="accordion-header"><span>Contact information</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="field-label-row"><label for="f_email">Email</label><span class="field-required-msg hidden" data-field="contact">required</span></div>
        <input id="f_email" type="email" value="${escapeHtml(client.email)}" />
        <label for="f_phone">Phone number</label>
        <input id="f_phone" type="tel" value="${escapeHtml(client.phone)}" />
        <label for="f_linkedin">LinkedIn</label>
        <input id="f_linkedin" value="${escapeHtml(client.linkedin)}" />
      </div>
    </div>

    <div class="accordion-section" data-section="company">
      <div class="accordion-header"><span>Company &amp; investment details</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="seller-fields ${type === "seller" ? "" : "hidden"}">
          <div class="field-label-row"><label for="f_company_name">Company name</label><span class="field-required-msg hidden" data-field="company_name">required</span></div>
          <input id="f_company_name" value="${escapeHtml(client.company_name)}" />
          <div class="field-label-row"><label for="f_industry">Industry sector</label><span class="field-required-msg hidden" data-field="industry">required</span></div>
          <input id="f_industry" value="${escapeHtml(client.industry)}" />
          <div class="form-row">
            <div>
              <label for="f_revenue">Annual revenue ($)</label>
              <input id="f_revenue" type="number" step="0.1" min="0" value="${client.annual_revenue ?? ""}" />
            </div>
            <div>
              <label for="f_employees">Employees</label>
              <input id="f_employees" type="number" step="1" min="0" value="${client.employee_count ?? ""}" />
            </div>
          </div>
          <label for="f_founded">Founded (year / month)</label>
          <input id="f_founded" type="month" value="${founded}" />
        </div>
        <div class="buyer-fields ${type === "buyer" ? "" : "hidden"}">
          <div class="section-title" style="margin-top:0;">Money to spend (range)</div>
          <div class="form-row">
            <div>
              <label for="f_money_min">Minimum ($)</label>
              <input id="f_money_min" type="number" step="0.1" min="0" value="${client.money_to_spend_min ?? ""}" />
            </div>
            <div>
              <label for="f_money_max">Maximum ($)</label>
              <input id="f_money_max" type="number" step="0.1" min="0" value="${client.money_to_spend_max ?? ""}" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="accordion-section" data-section="preferences">
      <div class="accordion-header"><span>Preferences</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <div class="field-label-row"><label for="f_looking_for" id="lookingForLabel">${lookingForLabel(type)}</label><span class="field-required-msg hidden" data-field="looking_for">required</span></div>
        <textarea id="f_looking_for">${escapeHtml(client.looking_for || "")}</textarea>
      </div>
    </div>

    <div class="accordion-section" data-section="notes">
      <div class="accordion-header"><span>Other notes</span><span class="chevron">&#9662;</span></div>
      <div class="accordion-body">
        <textarea id="f_other_notes">${escapeHtml(client.other_notes || "")}</textarea>
      </div>
    </div>
  `;
}

function rf(label, value) {
  const v = value === null || value === undefined || value === "" ? "" : String(value);
  return `<div class="readonly-field"><div class="rf-label">${escapeHtml(label)}</div><div class="rf-value ${v ? "" : "empty"}">${v ? escapeHtml(v) : "Not provided"}</div></div>`;
}

function buildReadonlySections(client) {
  const type = client.client_type;
  const location = [client.city, client.state].filter(Boolean).join(", ");
  const founded = client.founded_year ? `${monthName(client.founded_month)} ${client.founded_year}` : "";
  return `
    <div class="accordion-section open" data-section="personal">
      <div class="accordion-header"><span>Personal information</span><span class="chevron">&#9662;</span></div>
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
        ${rf("Email", client.email)}
        ${rf("Phone number", client.phone)}
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

function wireEditableFormEvents() {
  wireAccordions();
  const typeSel = document.getElementById("f_client_type");
  const sellerFields = els.clientModalBody.querySelector(".seller-fields");
  const buyerFields = els.clientModalBody.querySelector(".buyer-fields");
  const lookingLabel = document.getElementById("lookingForLabel");
  typeSel.addEventListener("change", () => {
    const v = typeSel.value;
    sellerFields.classList.toggle("hidden", v !== "seller");
    buyerFields.classList.toggle("hidden", v !== "buyer");
    lookingLabel.textContent = lookingForLabel(v);
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function collectFormData() {
  const type = document.getElementById("f_client_type").value;
  const data = {
    first_name: document.getElementById("f_first_name").value.trim(),
    last_name: document.getElementById("f_last_name").value.trim(),
    client_type: type,
    city: document.getElementById("f_city").value.trim(),
    state: document.getElementById("f_state").value,
    email: document.getElementById("f_email").value.trim(),
    phone: document.getElementById("f_phone").value.trim(),
    linkedin: document.getElementById("f_linkedin").value.trim(),
    looking_for: document.getElementById("f_looking_for").value.trim(),
    other_notes: document.getElementById("f_other_notes").value.trim(),
    intern_name: document.getElementById("f_intern_name").value.trim(),
  };
  if (type === "seller") {
    data.company_name = document.getElementById("f_company_name").value.trim();
    data.industry = document.getElementById("f_industry").value.trim();
    const rev = document.getElementById("f_revenue").value;
    const emp = document.getElementById("f_employees").value;
    data.annual_revenue = rev === "" ? null : Number(rev);
    data.employee_count = emp === "" ? null : Number(emp);
    const founded = document.getElementById("f_founded").value;
    if (founded) {
      const [y, m] = founded.split("-");
      data.founded_year = Number(y);
      data.founded_month = Number(m);
    } else {
      data.founded_year = null;
      data.founded_month = null;
    }
    data.money_to_spend_min = null;
    data.money_to_spend_max = null;
  } else {
    data.company_name = null;
    data.industry = null;
    data.annual_revenue = null;
    data.employee_count = null;
    data.founded_year = null;
    data.founded_month = null;
    const min = document.getElementById("f_money_min").value;
    const max = document.getElementById("f_money_max").value;
    data.money_to_spend_min = min === "" ? null : Number(min);
    data.money_to_spend_max = max === "" ? null : Number(max);
  }
  return data;
}

function getMissingFields(data) {
  const missing = [];
  const popupLabels = [];

  let nameMissing = false;
  if (!data.first_name) { missing.push("first_name"); nameMissing = true; }
  if (!data.last_name) { missing.push("last_name"); nameMissing = true; }
  if (nameMissing) popupLabels.push("Name");

  if (!data.client_type) { missing.push("client_type"); popupLabels.push("Buyer/Seller"); }

  if (data.client_type === "seller" && !data.company_name) { missing.push("company_name"); popupLabels.push("Company name"); }

  if (!data.email && !data.phone) { missing.push("contact"); popupLabels.push("Phone number and/or email"); }

  let locMissing = false;
  if (!data.city) { missing.push("city"); locMissing = true; }
  if (!data.state) { missing.push("state"); locMissing = true; }
  if (locMissing) popupLabels.push("Location");

  if (data.client_type === "seller" && !data.industry) { missing.push("industry"); popupLabels.push("Sector"); }

  if (!data.looking_for) { missing.push("looking_for"); popupLabels.push("What they're looking for"); }

  if (!data.intern_name) { missing.push("intern_name"); popupLabels.push("Intern's name"); }

  return { missing, popupLabels };
}

function clearFieldErrors() {
  els.clientModalBody.querySelectorAll(".field-required-msg").forEach((el) => el.classList.add("hidden"));
}

function validateAndCollect() {
  const data = collectFormData();
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
    <div class="timeline-header">
      <div></div>
      <div style="position:relative;">
        <button type="button" class="timeline-add-btn" id="timelineAddBtn" title="Add event">+</button>
        <div class="timeline-add-menu hidden" id="timelineAddMenu">
          <button type="button" id="addIntroCallBtn">Intro Call</button>
        </div>
      </div>
    </div>
    <div class="timeline-list">
      ${itemsHTML}
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
      ${buildEditableSections(defaultClient())}
      <div class="form-actions">
        <button type="button" class="btn" id="saveClientBtn">Save</button>
        <button type="button" class="btn secondary" id="cancelClientBtn">Cancel</button>
      </div>
    `;
    wireEditableFormEvents();
    document.getElementById("saveClientBtn").addEventListener("click", handleCreateSave);
    document.getElementById("cancelClientBtn").addEventListener("click", closeModal);
    return;
  }

  els.clientModalTitle.textContent = clientDisplayName(currentClient);
  updateSubtabActiveState();

  if (currentTab === "profile") {
    const editIconHTML =
      currentMode === "view"
        ? `<div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><button type="button" class="edit-icon-btn" id="editProfileBtn" title="Edit profile">&#9998;</button></div>`
        : "";
    els.clientModalBody.innerHTML = `
      ${editIconHTML}
      <div id="clientModalError" class="error-msg hidden"></div>
      ${currentMode === "edit" ? buildEditableSections(currentClient) : buildReadonlySections(currentClient)}
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
      wireEditableFormEvents();
      document.getElementById("saveClientBtn").addEventListener("click", handleEditSave);
      document.getElementById("cancelClientBtn").addEventListener("click", () => {
        currentMode = "view";
        renderModalBody();
      });
      const delBtn = document.getElementById("deleteClientBtn");
      if (delBtn) delBtn.addEventListener("click", handleDelete);
    } else {
      wireAccordions();
      document.getElementById("editProfileBtn").addEventListener("click", () => {
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
