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
import { rfContact, contactActionIcons, stopContactActionPropagation, locationPinLink } from "./contactIcons.js";
import { wirePageHeaderMenu } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;

const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let clients = [];
let currentClient = null; // null while creating a new client
let currentMode = "create"; // 'create' | 'view' | 'edit'

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
  clientModalSubtitle: document.getElementById("clientModalSubtitle"),
  clientModalBody: document.getElementById("clientModalBody"),
  clientModalClose: document.getElementById("clientModalClose"),
  editProfileBtn: document.getElementById("editProfileBtn"),
  requiredPopup: document.getElementById("requiredPopup"),
  requiredPopupText: document.getElementById("requiredPopupText"),
  requiredPopupOk: document.getElementById("requiredPopupOk"),
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

// Location as its own readonly row (above Email), with the map pin next to
// it — same idea as rfContact's icon row, but for the location + pin instead
// of a phone/email + contact icons.
function rfLocation(client) {
  const loc = clientLocation(client);
  const mapsLink = locationPinLink(client.city, client.state, "pin-body-row");
  return `
    <div class="readonly-field">
      <div class="rf-label">Location</div>
      <div class="rf-value-row">
        <div class="rf-value ${loc === "—" ? "empty" : ""}">${loc === "—" ? "Not provided" : escapeHtml(loc)}</div>
        ${mapsLink}
      </div>
    </div>`;
}

// Flat, non-tabbed read-only view — matches the Dials detail popup's layout
// (see buildDialViewHTML in js/dials.js) instead of the old
// accordion-sections-in-tabs design. Name is only shown once, up in the
// header (see renderModalBody) — company name lives in the header subtitle,
// but location has moved down here (above Email) instead of being in that
// subtitle too.
function buildClientViewHTML(client) {
  // founded_month can now be blank while founded_year is set (see
  // clientForm.js's separate month/year selects) — filter(Boolean) avoids a
  // stray leading space in that case instead of assuming both are present.
  const founded = client.founded_year ? [monthName(client.founded_month), client.founded_year].filter(Boolean).join(" ") : "";
  return `
    ${rfLocation(client)}
    ${rfContact("Email", client.email, "email")}
    ${rfContact("Phone number", client.phone, "phone")}
    ${rf("LinkedIn", client.linkedin)}
    ${rf("Intern's name", client.intern_name)}
    ${rf("Industry sector", client.industry)}
    ${rf("Annual revenue", client.annual_revenue != null ? `$${Number(client.annual_revenue).toLocaleString()}` : "")}
    ${rf("Employees", client.employee_count)}
    ${rf("Founded", founded)}
    ${rf(lookingForLabel(), client.looking_for)}
    ${rf("Notes", client.other_notes)}
  `;
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
// Modal rendering / mode switching
// ---------------------------------------------------------------------------

function renderModalBody() {
  // Edit icon lives in the header (left of the x), not beside "Personal
  // information" — only shown in view mode.
  els.editProfileBtn.classList.toggle("hidden", currentMode !== "view");

  if (currentMode === "create") {
    els.clientModalTitle.textContent = "New client";
    els.clientModalSubtitle.classList.add("hidden");
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
  // Subtitle is just the company name now — location used to live here too,
  // but it's moved down into the body as its own field, above Email (see
  // rfLocation/buildClientViewHTML), with the map pin next to it there.
  const subtitle = currentClient.company_name || "";
  els.clientModalSubtitle.textContent = subtitle;
  els.clientModalSubtitle.classList.toggle("hidden", !subtitle);

  els.clientModalBody.innerHTML = `
    <div id="clientModalError" class="error-msg hidden"></div>
    ${currentMode === "edit" ? buildEditableSections(currentClient) : buildClientViewHTML(currentClient)}
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
  els.clientModal.classList.remove("hidden");
  lockPageScroll();
  renderModalBody();
}

async function openDetailModal(client) {
  currentClient = client;
  currentMode = "view";
  els.clientModal.classList.remove("hidden");
  lockPageScroll();
  renderModalBody();
}

function closeModal() {
  els.clientModal.classList.add("hidden");
  unlockPageScroll();
}

els.addBtn.addEventListener("click", openCreateModal);
els.clientModalClose.addEventListener("click", closeModal);
wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu });
els.editProfileBtn.addEventListener("click", () => {
  currentMode = "edit";
  renderModalBody();
});

await loadClients();
