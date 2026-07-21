import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";
import {
  STATES,
  escapeHtml,
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

let allLists = []; // every dial_lists row (all types/statuses)
let dials = []; // dials belonging to the currently selected tab
let currentType = "buyer"; // 'buyer' | 'seller'
let currentStatus = "current"; // 'current' | 'archived'
let currentListId = null;
let currentDialIndex = -1;
let currentDial = null;
let dialMode = "view"; // 'view' | 'edit' | 'create'

const els = {
  errorBox: document.getElementById("errorBox"),
  typeSwitch: document.getElementById("typeSwitch"),
  statusSwitch: document.getElementById("statusSwitch"),
  dialTabs: document.getElementById("dialTabs"),
  addTabBtn: document.getElementById("addTabBtn"),
  generateListBtn: document.getElementById("generateListBtn"),
  dialsTableWrap: document.getElementById("dialsTableWrap"),
  addDialBtn: document.getElementById("addDialBtn"),
  dialModalBackdrop: document.getElementById("dialModalBackdrop"),
  dialModalTitle: document.getElementById("dialModalTitle"),
  dialModalClose: document.getElementById("dialModalClose"),
  dialModalError: document.getElementById("dialModalError"),
  dialModalBody: document.getElementById("dialModalBody"),
  dialModalActions: document.getElementById("dialModalActions"),
  dialNavRow: document.getElementById("dialNavRow"),
  dialPrevBtn: document.getElementById("dialPrevBtn"),
  dialNextBtn: document.getElementById("dialNextBtn"),
  clientModal: document.getElementById("clientModal"),
  clientModalTitle: document.getElementById("clientModalTitle"),
  clientModalBody: document.getElementById("clientModalBody"),
  clientModalClose: document.getElementById("clientModalClose"),
  requiredPopup: document.getElementById("requiredPopup"),
  requiredPopupText: document.getElementById("requiredPopupText"),
  requiredPopupOk: document.getElementById("requiredPopupOk"),
};

const CONTACT_ICONS = {
  sms: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
  tel: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  mailto: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>',
};

function rf(label, value) {
  const v = value === null || value === undefined || value === "" ? "" : String(value);
  return `<div class="readonly-field"><div class="rf-label">${escapeHtml(label)}</div><div class="rf-value ${v ? "" : "empty"}">${v ? escapeHtml(v) : "Not provided"}</div></div>`;
}

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

function rfWebsite(label, value) {
  const v = value ? String(value) : "";
  const href = v && !/^https?:\/\//i.test(v) ? `https://${v}` : v;
  return `
    <div class="readonly-field">
      <div class="rf-label">${escapeHtml(label)}</div>
      <div class="rf-value ${v ? "" : "empty"}">${v ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(v)}</a>` : "Not provided"}</div>
    </div>`;
}

function dialDisplayName(d) {
  return `${d.first_name || ""} ${d.last_name || ""}`.trim() || "Unnamed dial";
}
function dialLocation(d) {
  return [d.city, d.state].filter(Boolean).join(", ") || "—";
}
function emptyDial() {
  return { first_name: "", last_name: "", city: "", state: "", email: "", phone: "", linkedin: "", company_name: "", website: "", call_notes: "" };
}

// ---------------------------------------------------------------------------
// Lists (tabs)
// ---------------------------------------------------------------------------

async function loadLists() {
  const { data, error } = await supabase.from("dial_lists").select("*").order("sort_order", { ascending: true });
  if (error) return showError(els.errorBox, error);
  allLists = data || [];
  renderTabs();
}

function filteredLists() {
  return allLists
    .filter((l) => l.dial_type === currentType && l.status === currentStatus)
    .sort((a, b) => a.sort_order - b.sort_order || new Date(a.created_at) - new Date(b.created_at));
}

function renderTabs() {
  const filtered = filteredLists();
  if (!currentListId || !filtered.some((l) => l.id === currentListId)) {
    currentListId = filtered.length ? filtered[0].id : null;
  }

  if (filtered.length === 0) {
    els.dialTabs.innerHTML = `<span class="help-text">No lists yet — tap + to create one.</span>`;
  } else {
    els.dialTabs.innerHTML = filtered
      .map((l) => `<button type="button" class="dial-tab ${l.id === currentListId ? "active" : ""}" data-id="${l.id}">${escapeHtml(l.name)}</button>`)
      .join("");
    els.dialTabs.querySelectorAll("[data-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentListId = btn.dataset.id;
        renderTabs();
      });
      btn.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startRenameTab(btn, filtered.find((l) => l.id === btn.dataset.id));
      });
    });
  }
  loadDials();
}

function startRenameTab(btn, list) {
  const input = document.createElement("input");
  input.className = "dial-tab-rename-input";
  input.value = list.name;
  btn.replaceWith(input);
  input.focus();
  input.select();
  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    if (newName && newName !== list.name) {
      const { error } = await supabase.from("dial_lists").update({ name: newName }).eq("id", list.id);
      if (error) showError(els.errorBox, error);
    }
    await loadLists();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.value = list.name;
      input.blur();
    }
  });
}

els.addTabBtn.addEventListener("click", async () => {
  const name = prompt("Name this list:");
  if (!name || !name.trim()) return;
  const sortOrder = filteredLists().length;
  const { data, error } = await supabase
    .from("dial_lists")
    .insert({ name: name.trim(), dial_type: currentType, status: currentStatus, sort_order: sortOrder })
    .select()
    .single();
  if (error) return showError(els.errorBox, error);
  currentListId = data.id;
  await loadLists();
});

els.typeSwitch.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentType = btn.dataset.type;
    els.typeSwitch.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    currentListId = null;
    renderTabs();
  });
});
els.statusSwitch.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentStatus = btn.dataset.status;
    els.statusSwitch.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    currentListId = null;
    renderTabs();
  });
});

// "Generate new list" is an intentional no-op placeholder for now.

// ---------------------------------------------------------------------------
// Dials list (spreadsheet-like table)
// ---------------------------------------------------------------------------

async function loadDials() {
  if (!currentListId) {
    dials = [];
    renderDialsTable();
    return;
  }
  const { data, error } = await supabase.from("dials").select("*").eq("list_id", currentListId).order("created_at", { ascending: true });
  if (error) return showError(els.errorBox, error);
  dials = data || [];
  renderDialsTable();
}

function renderDialsTable() {
  if (!currentListId) {
    els.dialsTableWrap.innerHTML = `<div class="empty-state">No lists yet for this category — tap + next to the tabs to create one.</div>`;
    return;
  }
  if (dials.length === 0) {
    els.dialsTableWrap.innerHTML = `<div class="empty-state">No dials in this list yet — tap + to add one.</div>`;
    return;
  }
  const showCompany = currentType === "seller";
  els.dialsTableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          ${showCompany ? "<th>Company</th>" : ""}
          <th>Location</th>
          <th>Phone</th>
          <th>Email</th>
        </tr>
      </thead>
      <tbody>
        ${dials
          .map(
            (d, i) => `
          <tr class="clickable-row" data-index="${i}">
            <td>${escapeHtml(dialDisplayName(d))}</td>
            ${showCompany ? `<td class="muted">${escapeHtml(d.company_name || "—")}</td>` : ""}
            <td class="muted">${escapeHtml(dialLocation(d))}</td>
            <td class="muted">${escapeHtml(d.phone || "—")}</td>
            <td class="muted">${escapeHtml(d.email || "—")}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
  els.dialsTableWrap.querySelectorAll("[data-index]").forEach((row) => {
    row.addEventListener("click", () => openDialModal(Number(row.dataset.index)));
  });
}

// ---------------------------------------------------------------------------
// Dial detail / create popup
// ---------------------------------------------------------------------------

function buildDialViewHTML(dial) {
  const isSeller = currentType === "seller";
  return `
    ${rf("First name", dial.first_name)}
    ${rf("Last name", dial.last_name)}
    ${isSeller ? rf("Company name", dial.company_name) : ""}
    ${rf("Location", dialLocation(dial) === "—" ? "" : dialLocation(dial))}
    ${rfContact("Email", dial.email, "email")}
    ${rfContact("Phone number", dial.phone, "phone")}
    ${rf("LinkedIn", dial.linkedin)}
    ${isSeller ? rfWebsite("Website", dial.website) : ""}
    ${rf("Call notes", dial.call_notes)}
  `;
}

function buildDialEditHTML(dial) {
  const isSeller = currentType === "seller";
  return `
    <div class="form-row">
      <div><label for="d_first_name">First name</label><input id="d_first_name" value="${escapeHtml(dial.first_name)}" /></div>
      <div><label for="d_last_name">Last name</label><input id="d_last_name" value="${escapeHtml(dial.last_name)}" /></div>
    </div>
    ${isSeller ? `<label for="d_company_name">Company name</label><input id="d_company_name" value="${escapeHtml(dial.company_name)}" />` : ""}
    <div class="form-row">
      <div><label for="d_city">City</label><input id="d_city" value="${escapeHtml(dial.city)}" /></div>
      <div>
        <label for="d_state">State</label>
        <select id="d_state">
          <option value="">Select a state...</option>
          ${STATES.map((s) => `<option value="${s}" ${dial.state === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
    </div>
    <label for="d_email">Email</label>
    <input id="d_email" type="email" value="${escapeHtml(dial.email)}" />
    <label for="d_phone">Phone number</label>
    <input id="d_phone" type="tel" value="${escapeHtml(dial.phone)}" />
    <label for="d_linkedin">LinkedIn</label>
    <input id="d_linkedin" value="${escapeHtml(dial.linkedin)}" />
    ${isSeller ? `<label for="d_website">Website</label><input id="d_website" value="${escapeHtml(dial.website)}" />` : ""}
    <label for="d_call_notes">Call notes</label>
    <textarea id="d_call_notes">${escapeHtml(dial.call_notes || "")}</textarea>
  `;
}

function collectDialFormData() {
  const data = {
    first_name: document.getElementById("d_first_name").value.trim() || null,
    last_name: document.getElementById("d_last_name").value.trim() || null,
    city: document.getElementById("d_city").value.trim() || null,
    state: document.getElementById("d_state").value || null,
    email: document.getElementById("d_email").value.trim() || null,
    phone: document.getElementById("d_phone").value.trim() || null,
    linkedin: document.getElementById("d_linkedin").value.trim() || null,
    call_notes: document.getElementById("d_call_notes").value.trim() || null,
  };
  if (currentType === "seller") {
    data.company_name = document.getElementById("d_company_name").value.trim() || null;
    data.website = document.getElementById("d_website").value.trim() || null;
  }
  return data;
}

function renderDialModal() {
  const isCreate = dialMode === "create";
  const dial = isCreate ? emptyDial() : currentDial;
  els.dialModalTitle.textContent = isCreate ? "New dial" : dialDisplayName(currentDial);
  els.dialModalError.classList.add("hidden");
  els.dialModalError.textContent = "";

  const topRow =
    !isCreate && dialMode === "view"
      ? `<div class="dial-modal-toprow">
           <button type="button" class="edit-icon-btn" id="dialEditBtn" title="Edit">&#9998;</button>
           <button type="button" class="btn secondary small" id="createClientFromDialBtn">Create client</button>
         </div>`
      : "";

  const fieldsHTML = dialMode === "edit" || isCreate ? buildDialEditHTML(dial) : buildDialViewHTML(dial);
  els.dialModalBody.innerHTML = `${topRow}${fieldsHTML}`;

  if (dialMode === "edit" || isCreate) {
    els.dialModalActions.innerHTML = `
      <button type="button" class="btn" id="dialSaveBtn">Save</button>
      <button type="button" class="btn secondary" id="dialCancelBtn">Cancel</button>
      ${!isCreate && isLead ? `<button type="button" class="btn danger" id="dialDeleteBtn" style="margin-left:auto;">Delete</button>` : ""}
    `;
  } else {
    els.dialModalActions.innerHTML = "";
  }

  const showNav = !isCreate && dialMode === "view" && dials.length > 1;
  els.dialNavRow.classList.toggle("hidden", !showNav);
  els.dialPrevBtn.disabled = currentDialIndex <= 0;
  els.dialNextBtn.disabled = currentDialIndex >= dials.length - 1;

  if (isCreate) {
    document.getElementById("dialSaveBtn").addEventListener("click", handleCreateDialSave);
    document.getElementById("dialCancelBtn").addEventListener("click", closeDialModal);
  } else if (dialMode === "edit") {
    document.getElementById("dialSaveBtn").addEventListener("click", handleEditDialSave);
    document.getElementById("dialCancelBtn").addEventListener("click", () => {
      dialMode = "view";
      renderDialModal();
    });
    const delBtn = document.getElementById("dialDeleteBtn");
    if (delBtn) delBtn.addEventListener("click", handleDeleteDial);
  } else {
    document.getElementById("dialEditBtn").addEventListener("click", () => {
      dialMode = "edit";
      renderDialModal();
    });
    document.getElementById("createClientFromDialBtn").addEventListener("click", () => openCreateClientFromDial(currentDial));
  }
}

async function handleCreateDialSave() {
  if (!currentListId) return;
  const data = collectDialFormData();
  data.list_id = currentListId;
  const { error } = await supabase.from("dials").insert(data);
  if (error) return showError(els.dialModalError, error);
  closeDialModal();
  await loadDials();
}

async function handleEditDialSave() {
  const data = collectDialFormData();
  const { error } = await supabase.from("dials").update(data).eq("id", currentDial.id);
  if (error) return showError(els.dialModalError, error);
  Object.assign(currentDial, data);
  dialMode = "view";
  renderDialModal();
  await loadDials();
}

async function handleDeleteDial() {
  if (!confirm("Delete this dial? This cannot be undone.")) return;
  const { error } = await supabase.from("dials").delete().eq("id", currentDial.id);
  if (error) return showError(els.dialModalError, error);
  closeDialModal();
  await loadDials();
}

function openDialModal(index) {
  currentDialIndex = index;
  currentDial = dials[index];
  dialMode = "view";
  els.dialModalBackdrop.classList.remove("hidden");
  renderDialModal();
}

function closeDialModal() {
  els.dialModalBackdrop.classList.add("hidden");
}

els.addDialBtn.addEventListener("click", () => {
  if (!currentListId) {
    alert("Create a list first using the + next to the tabs.");
    return;
  }
  dialMode = "create";
  currentDial = null;
  currentDialIndex = -1;
  els.dialModalBackdrop.classList.remove("hidden");
  renderDialModal();
});
els.dialModalClose.addEventListener("click", closeDialModal);

// ---------------------------------------------------------------------------
// Prev/next navigation — swipe, on-screen arrows, and keyboard arrows
// ---------------------------------------------------------------------------

function goToDial(delta) {
  if (dialMode !== "view") return; // don't discard unsaved edits by navigating away
  const newIndex = currentDialIndex + delta;
  if (newIndex < 0 || newIndex >= dials.length) return;
  currentDialIndex = newIndex;
  currentDial = dials[newIndex];
  renderDialModal();
}

els.dialPrevBtn.addEventListener("click", () => goToDial(-1));
els.dialNextBtn.addEventListener("click", () => goToDial(1));

document.addEventListener("keydown", (e) => {
  if (els.dialModalBackdrop.classList.contains("hidden")) return;
  if (e.key === "ArrowLeft") goToDial(-1);
  if (e.key === "ArrowRight") goToDial(1);
});

let touchStartX = null;
els.dialModalBackdrop.addEventListener("touchstart", (e) => {
  touchStartX = e.touches[0].clientX;
});
els.dialModalBackdrop.addEventListener("touchend", (e) => {
  if (touchStartX === null) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 50) {
    if (dx < 0) goToDial(1);
    else goToDial(-1);
  }
  touchStartX = null;
});

// ---------------------------------------------------------------------------
// "Create client" from a dial — reuses the shared client form, pre-filled.
// ---------------------------------------------------------------------------

function openCreateClientFromDial(dial) {
  const prefill = defaultClient(profile, {
    first_name: dial.first_name || "",
    last_name: dial.last_name || "",
    client_type: currentType,
    city: dial.city || "",
    state: dial.state || "",
    email: dial.email || "",
    phone: dial.phone || "",
    linkedin: dial.linkedin || "",
    company_name: currentType === "seller" ? dial.company_name || "" : "",
  });
  els.clientModalTitle.textContent = "New client";
  els.clientModalBody.innerHTML = `
    <div id="clientModalError" class="error-msg hidden"></div>
    ${buildEditableSections(prefill)}
    <div class="form-actions">
      <button type="button" class="btn" id="saveNewClientBtn">Save</button>
      <button type="button" class="btn secondary" id="cancelNewClientBtn">Cancel</button>
    </div>
  `;
  wireEditableFormEvents(els.clientModalBody);
  document.getElementById("saveNewClientBtn").addEventListener("click", handleSaveNewClientFromDial);
  document.getElementById("cancelNewClientBtn").addEventListener("click", closeClientModal);
  els.clientModal.classList.remove("hidden");
}

function closeClientModal() {
  els.clientModal.classList.add("hidden");
}

async function handleSaveNewClientFromDial() {
  const data = collectFormData(els.clientModalBody);
  els.clientModalBody.querySelectorAll(".field-required-msg").forEach((el) => el.classList.add("hidden"));
  const { missing, popupLabels } = getMissingFields(data);
  if (missing.length) {
    missing.forEach((key) => {
      const el = els.clientModalBody.querySelector(`.field-required-msg[data-field="${key}"]`);
      if (el) el.classList.remove("hidden");
    });
    els.requiredPopupText.textContent = `Please fill out the missing information. The following is required: ${popupLabels.join(", ")}.`;
    els.requiredPopup.classList.remove("hidden");
    return;
  }
  data.assigned_to = profile.id;
  const { error } = await supabase.from("clients").insert(data);
  if (error) return showError(document.getElementById("clientModalError"), error);
  closeClientModal();
}

els.clientModalClose.addEventListener("click", closeClientModal);
els.requiredPopupOk.addEventListener("click", () => els.requiredPopup.classList.add("hidden"));

await loadLists();
