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
  BUYERS_ENABLED,
} from "./clientForm.js";
import { buildIntroCallFormHTML, wireIntroCallForm } from "./introCall.js";
import { rfContact, contactActionIcons, stopContactActionPropagation } from "./contactIcons.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile, user } = session;
const isLead = profile.role === "team_lead";
const internEmail = user?.email || "";

let allLists = []; // every dial_lists row (all types/statuses)
let dials = []; // dials belonging to the currently selected tab
let currentType = BUYERS_ENABLED ? "buyer" : "seller"; // 'buyer' | 'seller'
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
  dialModalHeader: document.getElementById("dialModalHeader"),
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
  newListModal: document.getElementById("newListModal"),
  newListError: document.getElementById("newListError"),
  newListNameInput: document.getElementById("newListNameInput"),
  newListCreateBtn: document.getElementById("newListCreateBtn"),
  newListCancelBtn: document.getElementById("newListCancelBtn"),
  confirmDeleteModal: document.getElementById("confirmDeleteModal"),
  introCallPopup: document.getElementById("introCallPopup"),
  introCallPopupBody: document.getElementById("introCallPopupBody"),
  introCallPopupClose: document.getElementById("introCallPopupClose"),
};

els.introCallPopupClose.addEventListener("click", () => els.introCallPopup.classList.add("hidden"));

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

function rf(label, value) {
  const v = value === null || value === undefined || value === "" ? "" : String(value);
  return `<div class="readonly-field"><div class="rf-label">${escapeHtml(label)}</div><div class="rf-value ${v ? "" : "empty"}">${v ? escapeHtml(v) : "Not provided"}</div></div>`;
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
// "Company name, City, State" — shown as the small subtitle under the dial's
// name in the detail popup header, and in the mobile card list.
function dialCompanyAndLocation(d) {
  const loc = dialLocation(d);
  return [d.company_name || "", loc === "—" ? "" : loc].filter(Boolean).join(", ");
}
function emptyDial() {
  return {
    first_name: "", last_name: "", city: "", state: "", email: "",
    mobile_phone: "", company_phone: "", linkedin: "", company_name: "",
    website: "", industry: "", summary: "", call_notes: "",
  };
}

// One row of a phone number with its "(Mobile)"/"(Company)" label + instant
// contact icons — used inside the "Phone numbers" display block below.
function phoneNumberRow(number, kind) {
  return `
    <div class="rf-value-row" style="margin-bottom: 8px;">
      <div class="rf-value">${escapeHtml(number)} <span class="help-text" style="display:inline;">(${kind})</span></div>
      ${contactActionIcons({ phone: number })}
    </div>`;
}

// Display-mode "Phone numbers" section: shows whichever of mobile/company
// are present, each with its own instant-contact icons.
function buildPhoneNumbersHTML(dial) {
  const rows = [];
  if (dial.mobile_phone) rows.push(phoneNumberRow(dial.mobile_phone, "Mobile"));
  if (dial.company_phone) rows.push(phoneNumberRow(dial.company_phone, "Company"));
  return `
    <div class="readonly-field">
      <div class="rf-label">Phone numbers</div>
      ${rows.length ? rows.join("") : `<div class="rf-value empty">Not provided</div>`}
    </div>`;
}

// Call notes are only ever shown in display mode, where they're directly
// editable (autosaves on blur — see wireCallNotesAutosave).
function buildCallNotesLiveHTML(dial) {
  return `
    <div class="readonly-field">
      <div class="rf-label">Call notes</div>
      <textarea id="d_call_notes_live" class="call-notes-live">${escapeHtml(dial.call_notes || "")}</textarea>
      <div class="help-text call-notes-saved hidden" id="callNotesSavedMsg">Saved</div>
    </div>`;
}

function wireCallNotesAutosave() {
  const notesEl = document.getElementById("d_call_notes_live");
  if (!notesEl || !currentDial) return;
  notesEl.addEventListener("blur", async () => {
    const val = notesEl.value.trim() || null;
    if (val === (currentDial.call_notes || null)) return;
    const { error } = await supabase.from("dials").update({ call_notes: val }).eq("id", currentDial.id);
    if (error) return showError(els.dialModalError, error);
    currentDial.call_notes = val;
    const idx = dials.findIndex((d) => d.id === currentDial.id);
    if (idx !== -1) dials[idx].call_notes = val;
    const msg = document.getElementById("callNotesSavedMsg");
    if (msg) {
      msg.classList.remove("hidden");
      setTimeout(() => msg.classList.add("hidden"), 1500);
    }
  });
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

els.addTabBtn.addEventListener("click", () => {
  els.newListError.classList.add("hidden");
  els.newListNameInput.value = "";
  els.newListModal.classList.remove("hidden");
  els.newListNameInput.focus();
});

els.newListCancelBtn.addEventListener("click", () => els.newListModal.classList.add("hidden"));

async function createNewList() {
  const name = els.newListNameInput.value.trim();
  if (!name) {
    els.newListError.textContent = "Please enter a name for the list.";
    els.newListError.classList.remove("hidden");
    return;
  }
  const sortOrder = filteredLists().length;
  const { data, error } = await supabase
    .from("dial_lists")
    .insert({ name, dial_type: currentType, status: currentStatus, sort_order: sortOrder })
    .select()
    .single();
  if (error) {
    els.newListError.textContent = error.message;
    els.newListError.classList.remove("hidden");
    return;
  }
  currentListId = data.id;
  els.newListModal.classList.add("hidden");
  await loadLists();
}

els.newListCreateBtn.addEventListener("click", createNewList);
els.newListNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") createNewList();
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

// Buyer support is hidden for now — everything is Sellers only. The switch
// and its click-handling code above stay intact for when this is re-enabled.
els.typeSwitch.classList.toggle("hidden", !BUYERS_ENABLED);

// "Generate new list" is an intentional no-op placeholder for now, and is
// hidden (not removed) until it does something.
els.generateListBtn.classList.add("hidden");

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
            <td data-label="Name">${escapeHtml(dialDisplayName(d))}</td>
            ${showCompany ? `<td class="muted" data-label="Company">${escapeHtml(d.company_name || "—")}</td>` : ""}
            <td class="muted" data-label="Location">${escapeHtml(dialLocation(d))}</td>
            <td class="muted" data-label="Phone">${escapeHtml(d.mobile_phone || "—")}</td>
            <td class="muted" data-label="Email">${escapeHtml(d.email || "—")}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>

    <!-- Mobile-only simplified card list — no column labels, just name on
         top, company + location smaller underneath, and instant-contact
         icons using the mobile number only (never the company number). -->
    <div class="mobile-list">
      ${dials
        .map(
          (d, i) => `
        <div class="mobile-card clickable-row" data-index="${i}">
          <div class="mc-main">
            <div class="mc-name">${escapeHtml(dialDisplayName(d))}</div>
            <div class="mc-sub">${escapeHtml(dialCompanyAndLocation(d))}</div>
          </div>
          ${contactActionIcons({ phone: d.mobile_phone, email: d.email })}
        </div>`
        )
        .join("")}
    </div>
  `;
  els.dialsTableWrap.querySelectorAll("[data-index]").forEach((row) => {
    row.addEventListener("click", () => openDialModal(Number(row.dataset.index)));
  });
  stopContactActionPropagation(els.dialsTableWrap);
}

// ---------------------------------------------------------------------------
// Dial detail / create popup
// ---------------------------------------------------------------------------

function buildDialViewHTML(dial) {
  const isSeller = currentType === "seller";
  return `
    ${rfContact("Email", dial.email, "email")}
    ${buildPhoneNumbersHTML(dial)}
    ${rf("LinkedIn", dial.linkedin)}
    ${isSeller ? rfWebsite("Website", dial.website) : ""}
    ${rf("Industry sector", dial.industry)}
    ${rf("Summary", dial.summary)}
    ${buildCallNotesLiveHTML(dial)}
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
    <div class="form-row">
      <div><label for="d_mobile_phone">Mobile number</label><input id="d_mobile_phone" type="tel" value="${escapeHtml(dial.mobile_phone)}" /></div>
      <div><label for="d_company_phone">Company number</label><input id="d_company_phone" type="tel" value="${escapeHtml(dial.company_phone)}" /></div>
    </div>
    <label for="d_linkedin">LinkedIn</label>
    <input id="d_linkedin" value="${escapeHtml(dial.linkedin)}" />
    ${isSeller ? `<label for="d_website">Website</label><input id="d_website" value="${escapeHtml(dial.website)}" />` : ""}
    <label for="d_industry">Industry sector</label>
    <input id="d_industry" value="${escapeHtml(dial.industry)}" />
    <label for="d_summary">Summary</label>
    <textarea id="d_summary">${escapeHtml(dial.summary || "")}</textarea>
  `;
}

function collectDialFormData() {
  // Note: call_notes is intentionally NOT collected here — it's edited
  // directly in display mode (autosaves on blur, see wireCallNotesAutosave)
  // and is not part of the edit form, so leaving it out of this object means
  // saving other fields never touches/overwrites it.
  const data = {
    first_name: document.getElementById("d_first_name").value.trim() || null,
    last_name: document.getElementById("d_last_name").value.trim() || null,
    city: document.getElementById("d_city").value.trim() || null,
    state: document.getElementById("d_state").value || null,
    email: document.getElementById("d_email").value.trim() || null,
    mobile_phone: document.getElementById("d_mobile_phone").value.trim() || null,
    company_phone: document.getElementById("d_company_phone").value.trim() || null,
    linkedin: document.getElementById("d_linkedin").value.trim() || null,
    industry: document.getElementById("d_industry").value.trim() || null,
    summary: document.getElementById("d_summary").value.trim() || null,
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
  const isViewingExisting = !isCreate && dialMode === "view";

  const subtitle = isCreate ? "" : dialCompanyAndLocation(currentDial);

  // Header (title/subtitle/Create-client/close) and the edit-button row
  // below it are fully rebuilt every render — they depend on which dial and
  // mode is active — then re-wired, same pattern as the body/actions below.
  els.dialModalHeader.innerHTML = `
    <div class="dial-modal-header">
      <div class="dial-modal-header-main">
        <h2>${escapeHtml(isCreate ? "New dial" : dialDisplayName(currentDial))}</h2>
        ${subtitle ? `<div class="dial-modal-subtitle">${escapeHtml(subtitle)}</div>` : ""}
      </div>
      <div class="dial-modal-header-actions">
        ${isViewingExisting ? `<button type="button" class="btn secondary small" id="createClientFromDialBtn">Create client</button>` : ""}
        <button type="button" class="fs-close" id="dialModalClose">&times;</button>
      </div>
    </div>
    <div class="dial-modal-editrow">
      ${isViewingExisting ? `<button type="button" class="edit-icon-btn" id="dialEditBtn" title="Edit">&#9998;</button>` : ""}
    </div>
  `;
  document.getElementById("dialModalClose").addEventListener("click", closeDialModal);
  if (isViewingExisting) {
    document.getElementById("createClientFromDialBtn").addEventListener("click", () => openCreateClientFromDial(currentDial));
    document.getElementById("dialEditBtn").addEventListener("click", () => {
      dialMode = "edit";
      renderDialModal();
    });
  }

  els.dialModalError.classList.add("hidden");
  els.dialModalError.textContent = "";

  const fieldsHTML = dialMode === "edit" || isCreate ? buildDialEditHTML(dial) : buildDialViewHTML(dial);
  els.dialModalBody.innerHTML = fieldsHTML;
  stopContactActionPropagation(els.dialModalBody);

  if (dialMode === "edit" || isCreate) {
    els.dialModalActions.innerHTML = `
      <button type="button" class="btn" id="dialSaveBtn">Save</button>
      <button type="button" class="btn secondary" id="dialCancelBtn">Cancel</button>
      ${!isCreate ? `<button type="button" class="btn danger" id="dialDeleteBtn" style="margin-left:auto;">Delete</button>` : ""}
    `;
  } else {
    els.dialModalActions.innerHTML = "";
  }

  // Prev/Next now render inside the modal box itself, at the bottom (only
  // relevant in display mode).
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
    wireCallNotesAutosave();
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

function handleDeleteDial() {
  openConfirmDelete(async () => {
    const { error } = await supabase.from("dials").delete().eq("id", currentDial.id);
    if (error) return showError(els.dialModalError, error);
    closeDialModal();
    await loadDials();
  });
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
    els.errorBox.textContent = "Create a list first using the + next to the tabs.";
    els.errorBox.classList.remove("hidden");
    return;
  }
  els.errorBox.classList.add("hidden");
  dialMode = "create";
  currentDial = null;
  currentDialIndex = -1;
  els.dialModalBackdrop.classList.remove("hidden");
  renderDialModal();
});
// Note: the close (x) button is inside #dialModalHeader, which is rebuilt on
// every renderDialModal() call, so its click listener is wired there instead
// of once here (see renderDialModal).

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
    // Only the mobile number transfers to a new client — never the company
    // number.
    phone: dial.mobile_phone || "",
    linkedin: dial.linkedin || "",
    company_name: currentType === "seller" ? dial.company_name || "" : "",
  });
  els.clientModalTitle.textContent = "New client";
  els.clientModalBody.innerHTML = `
    <div id="clientModalError" class="error-msg hidden"></div>
    ${buildEditableSections(prefill)}
    <div class="form-actions">
      <button type="button" class="btn" id="saveNewClientBtn">Save</button>
      <button type="button" class="btn secondary" id="scheduleIntroCallNewClientBtn">Schedule intro call</button>
      <button type="button" class="btn secondary" id="cancelNewClientBtn">Cancel</button>
    </div>
  `;
  wireEditableFormEvents(els.clientModalBody);
  document.getElementById("saveNewClientBtn").addEventListener("click", () => handleSaveNewClientFromDial());
  document.getElementById("scheduleIntroCallNewClientBtn").addEventListener("click", handleSaveAndScheduleFromDial);
  document.getElementById("cancelNewClientBtn").addEventListener("click", closeClientModal);
  els.clientModal.classList.remove("hidden");
}

function closeClientModal() {
  els.clientModal.classList.add("hidden");
}

// Validates the New Client form (shared with the Clients page) and, if
// valid, inserts the row. Returns the inserted client row, or null if
// validation failed or the insert errored (errors are already surfaced to
// the user in both cases).
async function validateAndInsertClientFromDial() {
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
    return null;
  }
  data.assigned_to = profile.id;
  const { data: inserted, error } = await supabase.from("clients").insert(data).select().single();
  if (error) {
    showError(document.getElementById("clientModalError"), error);
    return null;
  }
  return inserted;
}

async function handleSaveNewClientFromDial() {
  const inserted = await validateAndInsertClientFromDial();
  if (!inserted) return;
  closeClientModal();
}

// "Schedule intro call" from the Dials "Create client" flow: saves the
// client first (same validation/insert as Save), then immediately opens the
// Intro Call scheduling popup for the client that was just created.
async function handleSaveAndScheduleFromDial() {
  const inserted = await validateAndInsertClientFromDial();
  if (!inserted) return;
  closeClientModal();

  els.introCallPopupBody.innerHTML = buildIntroCallFormHTML();
  els.introCallPopup.classList.remove("hidden");
  wireIntroCallForm(els.introCallPopupBody, {
    client: inserted,
    internEmail,
    onScheduled: async ({ date, time, timezone }) => {
      const eventDate = new Date(`${date}T${time}:00`);
      await supabase.from("client_events").insert({
        client_id: inserted.id,
        event_type: "intro_call",
        event_date: eventDate.toISOString(),
        details: { timezone },
        created_by: profile.id,
      });
      setTimeout(() => els.introCallPopup.classList.add("hidden"), 1200);
    },
  });
}

els.clientModalClose.addEventListener("click", closeClientModal);
els.requiredPopupOk.addEventListener("click", () => els.requiredPopup.classList.add("hidden"));

await loadLists();
