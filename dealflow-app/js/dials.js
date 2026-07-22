import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";
import { STATES, escapeHtml, defaultClient } from "./clientForm.js";
import { buildIntroCallFormHTML, wireIntroCallForm } from "./introCall.js";
import { rfContact, contactActionIcons, stopContactActionPropagation, locationPinLink } from "./contactIcons.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus as closePageHeaderMenu } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile, user } = session;
const internEmail = user?.email || "";

let allLists = []; // every dial_lists row (all types/statuses)
let dials = []; // dials belonging to the currently selected tab
// Buyer support has been removed entirely — the app is sellers-only. The
// `dial_lists.dial_type` column still exists in the database, so this stays
// hardcoded to "seller" rather than ripping out that column.
const currentType = "seller";
let currentStatus = "current"; // 'current' | 'archived'
let currentListId = null;
let currentDialIndex = -1;
let currentDial = null;
let dialMode = "view"; // 'view' | 'edit' | 'create'
// Snapshot of whichever dials were actually on screen (after the Categories
// filter) at the moment the popup was opened — prev/next/swipe/arrow-key
// navigation moves through THIS list, not the full `dials` array, so if
// only one category is displayed you only ever swipe between those, not
// every dial in the tab (see openDialModal/goToDial).
let currentDialSet = [];

// Quick call-outcome status, set from a dropdown in the dial popup (not part
// of the edit form). Colors are light/mild tints matching the app's existing
// palette (see the .pill.* rules in css/style.css for the same family of
// colors). "dot" is the more saturated swatch used in the dropdown/filter.
// Colors reference CSS custom properties (see :root / the dark-mode
// override in css/style.css) instead of hardcoded hex, so they switch to
// dark-mode-appropriate shades automatically when the device's color scheme
// is dark, and back to the light-mode pastels when it isn't — matching
// var(--accent)/var(--success)/etc. elsewhere in the app rather than staying
// pinned to one theme's colors regardless of which is active.
const CONTACT_STATUSES = [
  { value: "uncontacted", label: "Uncontacted", bg: "var(--status-uncontacted-bg)", border: "var(--status-uncontacted-border)", dot: "var(--status-uncontacted-dot)" },
  { value: "unable_to_contact", label: "Unable to contact", bg: "var(--status-unable-bg)", border: "var(--status-unable-border)", dot: "var(--status-unable-dot)" },
  { value: "not_interested", label: "Not interested", bg: "var(--status-not-interested-bg)", border: "var(--status-not-interested-border)", dot: "var(--status-not-interested-dot)" },
  { value: "no_response", label: "No response, try again", bg: "var(--status-no-response-bg)", border: "var(--status-no-response-border)", dot: "var(--status-no-response-dot)" },
  { value: "callback_interested", label: "Callback, interested", bg: "var(--status-callback-bg)", border: "var(--status-callback-border)", dot: "var(--status-callback-dot)" },
  { value: "intro_call_scheduled", label: "Intro call scheduled", bg: "var(--status-scheduled-bg)", border: "var(--status-scheduled-border)", dot: "var(--status-scheduled-dot)" },
];
function statusInfo(value) {
  return CONTACT_STATUSES.find((s) => s.value === value) || CONTACT_STATUSES[0];
}

// Which statuses are currently hidden from every list/tab (toggled via the
// palette filter button).
const hiddenStatuses = new Set();

// ---------------------------------------------------------------------------
// Persisted Dials view state (selected tab + Categories filter) — saved to
// localStorage so navigating away to Profile/Clients (a full page load, so
// every module-level variable here resets) or closing the app entirely and
// coming back still shows the same tab and category filter instead of
// silently resetting to defaults.
// ---------------------------------------------------------------------------
const DIALS_STORAGE_KEYS = {
  listId: "waystation_dials_list_id",
  status: "waystation_dials_status",
  hiddenStatuses: "waystation_dials_hidden_statuses",
};

function loadPersistedDialsState() {
  try {
    const savedListId = localStorage.getItem(DIALS_STORAGE_KEYS.listId);
    if (savedListId) currentListId = savedListId;
    const savedStatus = localStorage.getItem(DIALS_STORAGE_KEYS.status);
    if (savedStatus === "current" || savedStatus === "archived") currentStatus = savedStatus;
    const savedHidden = localStorage.getItem(DIALS_STORAGE_KEYS.hiddenStatuses);
    if (savedHidden) {
      const arr = JSON.parse(savedHidden);
      if (Array.isArray(arr)) arr.forEach((v) => hiddenStatuses.add(v));
    }
  } catch {
    // Storage may be unavailable (private browsing, etc.) or contain
    // malformed data — just fall back to defaults rather than throwing.
  }
}
function persistCurrentListId() {
  try {
    if (currentListId) localStorage.setItem(DIALS_STORAGE_KEYS.listId, currentListId);
  } catch {
    // ignore
  }
}
function persistStatus() {
  try {
    localStorage.setItem(DIALS_STORAGE_KEYS.status, currentStatus);
  } catch {
    // ignore
  }
}
function persistHiddenStatuses() {
  try {
    localStorage.setItem(DIALS_STORAGE_KEYS.hiddenStatuses, JSON.stringify([...hiddenStatuses]));
  } catch {
    // ignore
  }
}
loadPersistedDialsState();

const els = {
  errorBox: document.getElementById("errorBox"),
  pageMenuToggle: document.getElementById("pageMenuToggle"),
  pageHeaderMenu: document.getElementById("pageHeaderMenu"),
  pageSettingsBtn: document.getElementById("pageSettingsBtn"),
  menuAddNewBtn: document.getElementById("menuAddNewBtn"),
  menuSelectBtn: document.getElementById("menuSelectBtn"),
  menuStatusBtn: document.getElementById("menuStatusBtn"),
  menuCategoriesBtn: document.getElementById("menuCategoriesBtn"),
  categoriesSubmenu: document.getElementById("categoriesSubmenu"),
  dialsProspectCount: document.getElementById("dialsProspectCount"),
  dialTabs: document.getElementById("dialTabs"),
  dialTabArchiveMenu: document.getElementById("dialTabArchiveMenu"),
  dialTabArchiveBtn: document.getElementById("dialTabArchiveBtn"),
  dialTabDeleteBtn: document.getElementById("dialTabDeleteBtn"),
  confirmDeleteTabModal: document.getElementById("confirmDeleteTabModal"),
  addTabBtn: document.getElementById("addTabBtn"),
  dialsTableWrap: document.getElementById("dialsTableWrap"),
  dialModalBackdrop: document.getElementById("dialModalBackdrop"),
  dialModalHeader: document.getElementById("dialModalHeader"),
  dialModalError: document.getElementById("dialModalError"),
  dialModalBody: document.getElementById("dialModalBody"),
  dialModalActions: document.getElementById("dialModalActions"),
  dialNavRow: document.getElementById("dialNavRow"),
  dialPrevBtn: document.getElementById("dialPrevBtn"),
  dialNextBtn: document.getElementById("dialNextBtn"),
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
  openConfirmModal(els.confirmDeleteModal, "confirmDeleteYesBtn", "confirmDeleteNoBtn", onConfirm);
}

// Generic "are you sure" confirm popup wiring, reused for both deleting a
// dial (above) and deleting a whole tab/list (see dialTabDeleteBtn below).
// onClose (optional) only runs when the popup is dismissed via "No/Cancel" —
// used by the tab-delete flow to restore the archive/delete menu's visibility
// after a Cancel. It deliberately does NOT run on "Yes": that callback used to
// fire unconditionally in cleanup(), which re-displayed the archive/delete
// menu (via updateArchiveMenuPosition()) the instant Delete was confirmed —
// synchronously, before the async delete request even resolved — making it
// look like clicking Delete did nothing (the tab really was being deleted,
// just behind a popup that had incorrectly reappeared).
function openConfirmModal(modalEl, yesId, noId, onConfirm, onClose) {
  modalEl.classList.remove("hidden");
  const yesBtn = document.getElementById(yesId);
  const noBtn = document.getElementById(noId);
  const cleanup = () => {
    modalEl.classList.add("hidden");
    yesBtn.removeEventListener("click", onYes);
    noBtn.removeEventListener("click", onNo);
  };
  const onYes = () => {
    cleanup();
    onConfirm();
  };
  const onNo = () => {
    cleanup();
    if (onClose) onClose();
  };
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
// "Company name, City, State" — used in the mobile card list's subtitle
// line (plain text, no styling needed there).
function dialCompanyAndLocation(d) {
  const loc = dialLocation(d);
  return [d.company_name || "", loc === "—" ? "" : loc].filter(Boolean).join(", ");
}
// Detail popup header subtitle: company name (slightly more prominent gray)
// and location (muted gray) as separate spans with no comma between them —
// just a space (see .subtitle-company/.subtitle-location in css/style.css) —
// plus the map pin right after the location. Either piece is optional.
function dialSubtitleHTML(d) {
  const company = d.company_name || "";
  const loc = dialLocation(d);
  const hasLoc = loc !== "—";
  const parts = [];
  if (company) parts.push(`<span class="subtitle-company">${escapeHtml(company)}</span>`);
  if (hasLoc) parts.push(`<span class="subtitle-location">${escapeHtml(loc)}</span>`);
  if (!parts.length) return "";
  return parts.join("") + (hasLoc ? locationPinLink(d.city, d.state) : "");
}
function emptyDial() {
  return {
    first_name: "", last_name: "", city: "", state: "", email: "",
    mobile_phone: "", company_phone: "", linkedin: "", company_name: "",
    website: "", industry: "", summary: "", call_notes: "", contact_status: "uncontacted",
    called_today_date: null,
  };
}

// Local calendar date (not UTC) as YYYY-MM-DD — used for the "Did call
// today" toggle, which just compares against this rather than needing a
// scheduled job to reset at midnight.
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

// Saves whatever is currently typed in the call-notes textarea (if it's
// present, i.e. we're on the view screen, and if it actually changed) right
// now, rather than waiting for a "blur" event to get around to firing.
// Called from every place that can take the user away from the notes field —
// blur itself, swiping/prev/next/arrow-keying to a different dial, changing
// the category, toggling "Did call today", opening edit mode, and closing the
// popup — so notes are never silently dropped if one of those happens before
// blur would have fired on its own, and so a status-button click can no
// longer race a still-in-flight notes save into overwriting the just-typed
// text with stale data on the next render (see goToDial/updateDialStatus/
// toggleDidCallToday, all of which now `await` this before doing anything
// else).
async function flushCallNotes() {
  const notesEl = document.getElementById("d_call_notes_live");
  if (!notesEl || !currentDial) return;
  const val = notesEl.value.trim() || null;
  if (val === (currentDial.call_notes || null)) return;
  const { error } = await supabase.from("dials").update({ call_notes: val }).eq("id", currentDial.id);
  if (error) {
    showError(els.dialModalError, error);
    return;
  }
  currentDial.call_notes = val;
  const idx = dials.findIndex((d) => d.id === currentDial.id);
  if (idx !== -1) dials[idx].call_notes = val;
}

function wireCallNotesAutosave() {
  const notesEl = document.getElementById("d_call_notes_live");
  if (!notesEl || !currentDial) return;
  notesEl.addEventListener("blur", async () => {
    await flushCallNotes();
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
  // Persisted here (rather than at every individual call site that can
  // change currentListId — tab clicks, new-list creation, tab deletion's
  // fallback, the initial restore-from-storage on load) so every path that
  // lands on a valid tab id ends up saved to localStorage automatically.
  persistCurrentListId();
  if (archiveMenuTabId && !filtered.some((l) => l.id === archiveMenuTabId)) {
    archiveMenuTabId = null;
  }

  if (filtered.length === 0) {
    els.dialTabs.innerHTML = `<span class="help-text">No lists yet — tap + to create one.</span>`;
  } else {
    els.dialTabs.innerHTML = filtered
      .map((l) => {
        const isActive = l.id === currentListId;
        return `
        <div class="dial-tab-wrap">
          <button type="button" class="dial-tab ${isActive ? "active" : ""}" data-id="${l.id}">${escapeHtml(l.name)}</button>
        </div>`;
      })
      .join("");
    wireTabInteractions();
  }
  updateArchiveMenuPosition();
  loadDials();
}

// The Archive/Unarchive popup lives outside .dials-tabbar (see dials.html)
// and is positioned via JS as position:fixed, right under whichever tab is
// currently active — see the big comment above wireTabInteractions() for why
// it can't just be absolutely-positioned inside the tab itself.
function updateArchiveMenuPosition() {
  if (!isMobileViewport() || !archiveMenuTabId || archiveMenuTabId !== currentListId) {
    els.dialTabArchiveMenu.classList.add("hidden");
    return;
  }
  const activeBtn = els.dialTabs.querySelector(".dial-tab.active");
  if (!activeBtn) {
    els.dialTabArchiveMenu.classList.add("hidden");
    return;
  }
  const rect = activeBtn.getBoundingClientRect();
  els.dialTabArchiveBtn.textContent = currentStatus === "current" ? "Archive" : "Unarchive";
  els.dialTabArchiveMenu.style.left = `${rect.left}px`;
  els.dialTabArchiveMenu.style.top = `${rect.bottom + 6}px`;
  els.dialTabArchiveMenu.classList.remove("hidden");
}

function closeArchiveMenu() {
  if (!archiveMenuTabId) return;
  archiveMenuTabId = null;
  updateArchiveMenuPosition();
}

// Closes the Archive/Delete popup as soon as anything ELSE is interacted
// with — a dial row, the settings icon, the page-header triangle, the
// Categories button, etc. Only two things are deliberately exempted:
//  - clicks inside the popup itself (its own Archive/Unarchive and Delete
//    buttons handle themselves, via setListArchived()/the confirm-delete flow)
//  - clicks on any dial tab button, since that's the element whose own click
//    handler (see wireTabInteractions) already opens/toggles this same popup
//    for the active tab — closing it here first would fight that logic.
document.addEventListener("click", (e) => {
  if (!archiveMenuTabId) return;
  if (els.dialTabArchiveMenu.contains(e.target)) return;
  if (e.target.closest(".dial-tab")) return;
  closeArchiveMenu();
});

els.dialTabArchiveBtn.addEventListener("click", () => {
  if (!archiveMenuTabId) return;
  setListArchived(archiveMenuTabId, currentStatus === "current");
});

els.dialTabDeleteBtn.addEventListener("click", () => {
  if (!archiveMenuTabId) return;
  const tabId = archiveMenuTabId;
  // Hide the Archive/Delete popup while the "are you sure" confirmation is
  // up, so they're never both visible at once.
  els.dialTabArchiveMenu.classList.add("hidden");
  openConfirmModal(
    els.confirmDeleteTabModal,
    "confirmDeleteTabYesBtn",
    "confirmDeleteTabNoBtn",
    async () => {
      // dials.list_id is "on delete cascade" (see supabase/schema.sql), so
      // deleting the list also deletes every dial inside it.
      const { error } = await supabase.from("dial_lists").delete().eq("id", tabId);
      if (error) return showError(els.errorBox, error);
      archiveMenuTabId = null;
      currentListId = null;
      await loadLists();
    },
    () => updateArchiveMenuPosition()
  );
});

// ---------------------------------------------------------------------------
// Tab interactions:
//  - Tap the already-selected tab (mobile only) -> reveal an Archive/Unarchive
//    option below it.
//  - Mobile: long-press (hold, not tap) the already-selected tab -> drag it
//    left/right to reorder among the other tabs. Has to be the already-active
//    tab so a hold can never be confused with the tap-to-archive gesture
//    above (can never end up right of the "+" button, since that button
//    lives outside the #dialTabs list being reordered).
//  - Desktop: click-and-drag ANY tab with the mouse to reorder it — there's
//    no tap-to-archive gesture on desktop to disambiguate from, so no
//    pre-selection or hold delay is needed; crossing a small movement
//    threshold starts the drag immediately, same as dragging browser tabs.
// A plain tap/click never starts a drag on its own.
// ---------------------------------------------------------------------------

// Device-type check (not viewport width — see js/deviceDetect logic inlined
// in dials.html <head>, and the big comment in css/style.css above the
// "RESPONSIVE / MOBILE LAYOUT" section). This keeps tap-to-archive/long-press
// reorder tied to actually being on a phone/tablet, not to window width.
function isMobileViewport() {
  return document.documentElement.classList.contains("is-mobile-device");
}

let archiveMenuTabId = null;
const LONG_PRESS_MS = 300;
const DRAG_CANCEL_PX = 10;

const tabDragState = {
  active: false,
  tabId: null,
  startX: 0,
  suppressClick: false,
  timer: null,
  mode: null, // "touch" | "mouse"
};

function cancelLongPressTimer() {
  if (tabDragState.timer) {
    clearTimeout(tabDragState.timer);
    tabDragState.timer = null;
  }
}

// Moves `wrap` to whatever slot in #dialTabs its dragged tab should currently
// occupy, based on the pointer's raw clientX against every OTHER tab's
// midpoint — recomputed fresh from each sibling's real (untransformed)
// position on every call. This is deliberately stateless: it never depends on
// a running delta/anchor that has to stay in sync across events, so a single
// fast drag lands in the correct slot even if it skips past several tabs
// between pointermove events, and the tab always ends up exactly where the
// pointer is released. (An earlier version tracked a relative delta from a
// reset anchor and only checked one neighboring tab per event, which could
// advance at most one slot per pointermove — on a quick drag that covers
// multiple tabs' worth of distance between event callbacks, that meant the
// reorder fell behind the finger and the tab didn't end up where it was
// dropped.)
function reorderTabToPointer(wrap, clientX) {
  const others = [...els.dialTabs.querySelectorAll(".dial-tab-wrap")].filter((w) => w !== wrap);
  let target = null;
  for (const sib of others) {
    const r = sib.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) {
      target = sib;
      break;
    }
  }
  if (target) {
    if (wrap.nextElementSibling !== target) els.dialTabs.insertBefore(wrap, target);
  } else if (els.dialTabs.lastElementChild !== wrap) {
    els.dialTabs.appendChild(wrap);
  }
}

function wireTabInteractions() {
  els.dialTabs.querySelectorAll(".dial-tab").forEach((btn) => {
    const id = btn.dataset.id;

    btn.addEventListener("click", () => {
      if (tabDragState.suppressClick) {
        tabDragState.suppressClick = false;
        return;
      }
      if (isMobileViewport() && id === currentListId) {
        archiveMenuTabId = archiveMenuTabId === id ? null : id;
        renderTabs();
        return;
      }
      currentListId = id;
      archiveMenuTabId = null;
      renderTabs();
    });

    btn.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRenameTab(btn, filteredLists().find((l) => l.id === id));
    });

    btn.addEventListener("pointerdown", (e) => {
      const isMouse = e.pointerType === "mouse";
      // Touch: only the already-active tab can be picked up (see the big
      // comment above this section for why). Mouse: any tab can be grabbed
      // directly.
      if (!isMouse && (!isMobileViewport() || id !== currentListId)) return;

      tabDragState.tabId = id;
      tabDragState.startX = e.clientX;
      tabDragState.active = false;
      tabDragState.mode = isMouse ? "mouse" : "touch";
      cancelLongPressTimer();

      if (isMouse) return; // starts on movement threshold instead — see pointermove

      // Mobile: immediate subtle feedback that a hold is being registered,
      // so the long-press doesn't feel like nothing is happening until it
      // suddenly starts dragging.
      btn.classList.add("pressing");
      tabDragState.timer = setTimeout(() => {
        tabDragState.active = true;
        archiveMenuTabId = null;
        btn.classList.remove("pressing");
        btn.classList.add("dragging");
        try {
          btn.setPointerCapture(e.pointerId);
        } catch {
          // ignore — pointer capture is a nice-to-have, not required
        }
      }, LONG_PRESS_MS);
    });

    btn.addEventListener("pointermove", (e) => {
      if (tabDragState.tabId !== id) return;
      const dx = e.clientX - tabDragState.startX;

      if (!tabDragState.active) {
        if (Math.abs(dx) <= DRAG_CANCEL_PX) return;
        if (tabDragState.mode === "mouse") {
          // Desktop: crossing the threshold starts the drag immediately —
          // no hold delay needed since there's no competing tap gesture.
          tabDragState.active = true;
          btn.classList.add("dragging");
          try {
            btn.setPointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        } else {
          // Mobile: moving too far before the long-press timer fires cancels
          // the hold — this was likely just scrolling the tab bar, not an
          // attempt to drag.
          cancelLongPressTimer();
          btn.classList.remove("pressing");
          return;
        }
      }

      e.preventDefault();
      reorderTabToPointer(btn.closest(".dial-tab-wrap"), e.clientX);
    });

    const endDrag = async () => {
      cancelLongPressTimer();
      btn.classList.remove("pressing");
      if (tabDragState.tabId !== id) return;
      if (tabDragState.active) {
        btn.classList.remove("dragging");
        tabDragState.suppressClick = true;
        await persistTabOrder();
      }
      tabDragState.active = false;
      tabDragState.tabId = null;
      tabDragState.mode = null;
    };
    btn.addEventListener("pointerup", endDrag);
    btn.addEventListener("pointercancel", endDrag);
  });
}

async function persistTabOrder() {
  const ids = [...els.dialTabs.querySelectorAll(".dial-tab")].map((b) => b.dataset.id);
  await Promise.all(ids.map((id, i) => supabase.from("dial_lists").update({ sort_order: i }).eq("id", id)));
  await loadLists();
}

async function setListArchived(listId, archived) {
  const { error } = await supabase.from("dial_lists").update({ status: archived ? "archived" : "current" }).eq("id", listId);
  if (error) return showError(els.errorBox, error);
  archiveMenuTabId = null;
  currentListId = null;
  await loadLists();
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

// Toggles between showing Current / Archived lists. Used to be a desktop
// segmented switch + a separate mobile toggle button — now it's a single
// text menu item ("Current" / "Archived") under the page-header triangle,
// same on both platforms.
function setStatus(status) {
  currentStatus = status;
  els.menuStatusBtn.textContent = status === "current" ? "Current" : "Archived";
  els.menuStatusBtn.dataset.status = status;
  currentListId = null;
  persistStatus();
  renderTabs();
}

// Reflect whatever status was restored from localStorage (see
// loadPersistedDialsState()) in the menu button's label right away, without
// going through setStatus() itself — that also nulls out currentListId,
// which would throw away the just-restored tab selection.
els.menuStatusBtn.textContent = currentStatus === "current" ? "Current" : "Archived";
els.menuStatusBtn.dataset.status = currentStatus;

els.menuStatusBtn.addEventListener("click", () => {
  setStatus(currentStatus === "current" ? "archived" : "current");
});

// ---------------------------------------------------------------------------
// Page-header triangle menu (Profile/Clients/Dials all share this pattern —
// see js/pageHeaderMenu.js). Replaces the old gold vertical rule: tapping the
// triangle flips it to point down and reveals this page's options.
// ---------------------------------------------------------------------------
wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu, extraCloseEl: els.categoriesSubmenu });

els.menuAddNewBtn.addEventListener("click", () => {
  closePageHeaderMenu();
  openCreateDialModal();
});

// "Select" is a placeholder for a future bulk-selection mode — added now per
// request, not wired up to anything yet.
els.menuSelectBtn.addEventListener("click", () => {
  closePageHeaderMenu();
});

// ---------------------------------------------------------------------------
// Dials list (spreadsheet-like table)
// ---------------------------------------------------------------------------

async function loadDials() {
  if (!currentListId) {
    dials = [];
    renderDialsTable();
    return;
  }
  const { data, error } = await supabase.from("dials").select("*").eq("list_id", currentListId);
  if (error) return showError(els.errorBox, error);
  // Alphabetical A-Z by first name (case/locale-insensitive) rather than
  // import/creation order.
  dials = (data || []).slice().sort((a, b) => (a.first_name || "").localeCompare(b.first_name || "", undefined, { sensitivity: "base" }));
  renderDialsTable();
}

// Whichever dials in the current tab pass the Categories filter — i.e.
// exactly what's actually on screen right now. Used both to render the list
// AND (see openDialModal/goToDial) to scope prev/next/swipe/arrow-key
// navigation to only those dials, instead of every dial in the tab.
function visibleDials() {
  return dials.filter((d) => !hiddenStatuses.has(d.contact_status || "uncontacted"));
}

// Updates the small "X prospects displayed" text next to the Dials heading —
// always reflects however many dials are actually visible right now in the
// selected tab, after the Categories filter (hiddenStatuses) is applied.
function updateProspectCount(count) {
  if (!els.dialsProspectCount) return;
  els.dialsProspectCount.textContent = `${count} prospect${count === 1 ? "" : "s"} displayed`;
}

function renderDialsTable() {
  if (!currentListId) {
    els.dialsTableWrap.innerHTML = `<div class="empty-state">No lists yet for this category — tap + next to the tabs to create one.</div>`;
    updateProspectCount(0);
    return;
  }
  if (dials.length === 0) {
    els.dialsTableWrap.innerHTML = `<div class="empty-state">No dials in this list yet — use the arrow next to "Dials" and tap "Add new".</div>`;
    updateProspectCount(0);
    return;
  }
  // data-index here is the dial's position within this filtered `visible`
  // list itself (not its position in the full `dials` array) — openDialModal
  // takes that same index and snapshots this same filtered list as
  // currentDialSet, so prev/next/swipe/arrow-key navigation only ever moves
  // between whatever's actually displayed here.
  const visible = visibleDials();
  updateProspectCount(visible.length);

  if (visible.length === 0) {
    els.dialsTableWrap.innerHTML = `<div class="empty-state">Every dial in this list is hidden by the status filter above.</div>`;
    return;
  }

  els.dialsTableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Company</th>
          <th>Location</th>
          <th>Phone</th>
          <th>Email</th>
        </tr>
      </thead>
      <tbody>
        ${visible
          .map(
            (d, i) => `
          <tr class="clickable-row" data-index="${i}" style="background:${statusInfo(d.contact_status).bg};">
            <td data-label="Name">${escapeHtml(dialDisplayName(d))}</td>
            <td class="muted" data-label="Company">${escapeHtml(d.company_name || "—")}</td>
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
      ${visible
        .map(
          (d, i) => `
        <div class="mobile-card clickable-row" data-index="${i}" style="background:${statusInfo(d.contact_status).bg}; border-color:${statusInfo(d.contact_status).border};">
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
  return `
    ${rfContact("Email", dial.email, "email")}
    ${buildPhoneNumbersHTML(dial)}
    ${rf("LinkedIn", dial.linkedin)}
    ${rfWebsite("Website", dial.website)}
    ${rf("Industry sector", dial.industry)}
    ${rf("Summary", dial.summary)}
    ${buildCallNotesLiveHTML(dial)}
  `;
}

function buildDialEditHTML(dial) {
  return `
    <div class="form-row">
      <div><label for="d_first_name">First name</label><input id="d_first_name" value="${escapeHtml(dial.first_name)}" /></div>
      <div><label for="d_last_name">Last name</label><input id="d_last_name" value="${escapeHtml(dial.last_name)}" /></div>
    </div>
    <label for="d_company_name">Company name</label><input id="d_company_name" value="${escapeHtml(dial.company_name)}" />
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
    <label for="d_website">Website</label><input id="d_website" value="${escapeHtml(dial.website)}" />
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
    company_name: document.getElementById("d_company_name").value.trim() || null,
    website: document.getElementById("d_website").value.trim() || null,
  };
  return data;
}

function renderDialModal() {
  const isCreate = dialMode === "create";
  const dial = isCreate ? emptyDial() : currentDial;
  const isViewingExisting = !isCreate && dialMode === "view";

  const subtitleHTML = isCreate ? "" : dialSubtitleHTML(currentDial);

  // Header (title/subtitle/Create-client/close) and the edit-button row
  // below it are fully rebuilt every render — they depend on which dial and
  // mode is active — then re-wired, same pattern as the body/actions below.
  // The actions row and the status/edit row are both nested inside a shared
  // right-aligned column (.dial-modal-header-right) rather than being two
  // independent flex rows stacked by plain document flow — that's what keeps
  // the gap between them small and constant (set by the column's own `gap`)
  // instead of being dictated by whatever height the (often two-line,
  // wrapping) name/subtitle block on the left happens to need. It also means
  // "Schedule intro call" (top) / the status dropdown ("Categories" -
  // Uncontacted/Not interested/etc) / "Did call today" all end up with their
  // right edges lined up automatically, since they share the same
  // right-aligned column and the status dropdown + Did-call-today stretch to
  // match each other's width (see .dial-status-col).
  const calledToday = dial.called_today_date === todayDateStr();
  els.dialModalHeader.innerHTML = `
    <div class="dial-modal-header">
      <div class="dial-modal-header-main">
        <h2>${escapeHtml(isCreate ? "New dial" : dialDisplayName(currentDial))}</h2>
        ${subtitleHTML ? `<div class="dial-modal-subtitle">${subtitleHTML}</div>` : ""}
      </div>
      <div class="dial-modal-header-right">
        <div class="dial-modal-header-actions">
          ${isViewingExisting ? `<button type="button" class="dial-schedule-intro-btn" id="scheduleIntroCallFromDialBtn">Schedule intro call</button>` : ""}
          <button type="button" class="fs-close" id="dialModalClose">&times;</button>
        </div>
        ${
          isViewingExisting
            ? `
        <div class="dial-modal-editrow">
          <div class="dial-status-col">
            <div class="dial-status-dropdown">
              <button type="button" class="dial-status-btn" id="dialStatusBtn"
                style="background:${statusInfo(dial.contact_status).bg}; border-color:${statusInfo(dial.contact_status).border};">${escapeHtml(statusInfo(dial.contact_status).label)}</button>
              <div class="dial-status-menu hidden" id="dialStatusMenu">
                ${CONTACT_STATUSES.map(
                  (s) => `
                  <button type="button" class="dial-status-option" data-value="${s.value}">
                    <span class="dial-status-dot" style="background:${s.dot}; border-color:${s.border};"></span>${escapeHtml(s.label)}
                  </button>`
                ).join("")}
              </div>
            </div>
            <button type="button" class="dial-did-call-btn ${calledToday ? "active" : ""}" id="dialDidCallBtn">Called today</button>
          </div>
          <button type="button" class="edit-icon-btn" id="dialEditBtn" title="Edit">&#9998;</button>
        </div>
        `
            : ""
        }
      </div>
    </div>
  `;
  document.getElementById("dialModalClose").addEventListener("click", closeDialModal);
  if (isViewingExisting) {
    document.getElementById("scheduleIntroCallFromDialBtn").addEventListener("click", () => handleScheduleIntroCallFromDial(currentDial));
    document.getElementById("dialEditBtn").addEventListener("click", async () => {
      // Flush any just-typed call notes before the view-mode notes textarea
      // gets torn down for the edit form — otherwise a race between this
      // render and an in-flight blur save could show/save stale notes (see
      // flushCallNotes).
      await flushCallNotes();
      dialMode = "edit";
      renderDialModal();
    });
    document.getElementById("dialDidCallBtn").addEventListener("click", toggleDidCallToday);
    const statusBtn = document.getElementById("dialStatusBtn");
    const statusMenu = document.getElementById("dialStatusMenu");
    statusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      statusMenu.classList.toggle("hidden");
    });
    document.addEventListener("click", () => statusMenu.classList.add("hidden"), { once: true });
    statusMenu.querySelectorAll(".dial-status-option").forEach((btn) => {
      btn.addEventListener("click", () => updateDialStatus(btn.dataset.value));
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
  // relevant in display mode). Bounds are based on currentDialSet — the
  // filtered/displayed list snapshotted when the popup opened — not the full
  // `dials` array, so these buttons (and swipe/arrow-keys, see goToDial)
  // only ever move between whatever's actually on screen.
  const showNav = !isCreate && dialMode === "view" && currentDialSet.length > 1;
  els.dialNavRow.classList.toggle("hidden", !showNav);
  els.dialPrevBtn.disabled = currentDialIndex <= 0;
  els.dialNextBtn.disabled = currentDialIndex >= currentDialSet.length - 1;

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

// Sets the dial's quick call-outcome status. Not part of the edit form —
// this is a standalone dropdown in the popup's header row that autosaves
// immediately, same pattern as the Call notes autosave. Changing this no
// longer affects the weekly call count — that's now the separate "Did call
// today" toggle below it (see toggleDidCallToday).
async function updateDialStatus(newStatus) {
  // Flush any pending call-notes edit FIRST and wait for it to finish before
  // touching contact_status or re-rendering — without this await, the notes
  // save (started on the textarea's blur when this button was clicked) and
  // this status update were two independent in-flight requests; whichever
  // one's re-render happened to land first could rebuild the notes textarea
  // from stale (pre-edit) data, visually wiping out whatever was just typed
  // even though it had actually already been saved to the database. This is
  // also what caused the occasional "type error" on first press — updating
  // dial.contact_status while currentDial briefly held stale/partial data
  // from the race.
  await flushCallNotes();
  const { error } = await supabase.from("dials").update({ contact_status: newStatus }).eq("id", currentDial.id);
  if (error) return showError(els.dialModalError, error);
  currentDial.contact_status = newStatus;
  const idx = dials.findIndex((d) => d.id === currentDial.id);
  if (idx !== -1) dials[idx].contact_status = newStatus;

  renderDialModal();
  renderDialsTable();
}

// "Did call today" — an independent toggle (not tied to contact_status) that
// adds/removes exactly one call from this week's count on Profile. Selecting
// it sets called_today_date to today and logs one call_status_changes row;
// unselecting clears the date and removes that row again. Naturally "resets"
// at the start of each day since the button's checked state is just
// (dial.called_today_date === todayDateStr()) — no cron job needed, and it
// never touches any other day's already-logged calls.
async function toggleDidCallToday() {
  // Same reasoning as updateDialStatus — flush any pending notes edit before
  // this re-renders the popup.
  await flushCallNotes();
  const today = todayDateStr();
  const isCalledToday = currentDial.called_today_date === today;

  if (isCalledToday) {
    const { error } = await supabase.from("dials").update({ called_today_date: null }).eq("id", currentDial.id);
    if (error) return showError(els.dialModalError, error);
    currentDial.called_today_date = null;
    await supabase
      .from("call_status_changes")
      .delete()
      .eq("dial_id", currentDial.id)
      .eq("user_id", profile.id)
      .gte("changed_at", `${today}T00:00:00`)
      .lt("changed_at", `${today}T23:59:59.999`);
  } else {
    const { error } = await supabase.from("dials").update({ called_today_date: today }).eq("id", currentDial.id);
    if (error) return showError(els.dialModalError, error);
    currentDial.called_today_date = today;
    await supabase.from("call_status_changes").insert({ user_id: profile.id, dial_id: currentDial.id });
  }

  const idx = dials.findIndex((d) => d.id === currentDial.id);
  if (idx !== -1) dials[idx].called_today_date = currentDial.called_today_date;
  renderDialModal();
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
  // Snapshot whatever's currently displayed (post-Categories-filter) — index
  // is this dial's position within THAT list (see renderDialsTable), and
  // prev/next/swipe/arrow-keys navigate within this same snapshot rather than
  // the full `dials` array (see goToDial).
  currentDialSet = visibleDials();
  currentDialIndex = index;
  currentDial = currentDialSet[index];
  dialMode = "view";
  els.dialModalBackdrop.classList.remove("hidden");
  lockPageScroll();
  renderDialModal();
}

async function closeDialModal() {
  // Save any notes typed but not yet blurred before the popup disappears.
  await flushCallNotes();
  els.dialModalBackdrop.classList.add("hidden");
  unlockPageScroll();
}

// Opens the "New dial" popup — used by the "Add new" item in the page-header
// triangle menu (used to be a bottom-right "+" FAB).
function openCreateDialModal() {
  if (!currentListId) {
    els.errorBox.textContent = "Create a list first using the + next to the tabs.";
    els.errorBox.classList.remove("hidden");
    return;
  }
  els.errorBox.classList.add("hidden");
  dialMode = "create";
  currentDial = null;
  currentDialIndex = -1;
  currentDialSet = [];
  els.dialModalBackdrop.classList.remove("hidden");
  lockPageScroll();
  renderDialModal();
}
// Note: the close (x) button is inside #dialModalHeader, which is rebuilt on
// every renderDialModal() call, so its click listener is wired there instead
// of once here (see renderDialModal).

// ---------------------------------------------------------------------------
// Prev/next navigation — swipe, on-screen arrows, and keyboard arrows
// ---------------------------------------------------------------------------

// How long the slide-out/slide-in halves of the transition take — must match
// the `transition` duration on .dial-modal in css/style.css, since the JS
// waits this long (via setTimeout) before swapping content partway through.
const DIAL_SWIPE_MS = 180;

async function goToDial(delta) {
  if (dialMode !== "view") return; // don't discard unsaved edits by navigating away
  // currentDialSet is the filtered/displayed list snapshotted when the popup
  // opened (see openDialModal) — bounds-checking against THIS instead of the
  // full `dials` array is what keeps swipe/prev/next/arrow-keys scoped to
  // only the dials actually on screen (e.g. just one Categories filter).
  const newIndex = currentDialIndex + delta;
  if (newIndex < 0 || newIndex >= currentDialSet.length) return;

  // Save any notes typed but not yet blurred BEFORE swapping to the next
  // dial, and wait for it to finish before rendering — otherwise the render
  // below could land while that save is still in flight and show/overwrite
  // stale data for whichever dial is being left (see flushCallNotes).
  await flushCallNotes();

  const modalBox = els.dialModalBackdrop.querySelector(".dial-modal");

  // Slide + fade the current content out in the direction being swiped away
  // from, then swap in the new dial, then slide + fade it in from the
  // opposite side — an actual swipe transition instead of an instant snap
  // (see .dial-modal's transition in css/style.css).
  if (modalBox) {
    modalBox.style.transform = delta > 0 ? "translateX(-28px)" : "translateX(28px)";
    modalBox.style.opacity = "0";
    await new Promise((resolve) => setTimeout(resolve, DIAL_SWIPE_MS));
  }

  currentDialIndex = newIndex;
  currentDial = currentDialSet[newIndex];
  renderDialModal();

  if (modalBox) {
    // Jump (no transition) to just off the opposite side, then release back
    // to centered/opaque — that release is what animates the "slide in".
    modalBox.classList.add("dial-modal-jump");
    modalBox.style.transform = delta > 0 ? "translateX(28px)" : "translateX(-28px)";
    void modalBox.offsetWidth; // force reflow so the jump above isn't itself animated
    modalBox.classList.remove("dial-modal-jump");
    modalBox.style.transform = "";
    modalBox.style.opacity = "";
  }
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
// "Schedule intro call" from a dial — replaces the old "Create client"
// button entirely. Only the info already on the dial is required (no
// preferences/looking-for step); once that's present, this creates the
// client silently (call notes carry over into Other notes) and immediately
// opens the Intro Call scheduling popup for it — no separate review form.
// ---------------------------------------------------------------------------

// Only checks fields that actually exist on a dial — "looking_for" (from the
// full client form) is intentionally not required here, since a dial has no
// such field.
function getMissingDialClientFields(dial) {
  const missing = [];
  const labels = [];

  let nameMissing = false;
  if (!dial.first_name) { missing.push("first_name"); nameMissing = true; }
  if (!dial.last_name) { missing.push("last_name"); nameMissing = true; }
  if (nameMissing) labels.push("Name");

  if (!dial.company_name) { missing.push("company_name"); labels.push("Company name"); }

  if (!dial.email && !dial.mobile_phone && !dial.company_phone) {
    missing.push("contact");
    labels.push("Phone number and/or email");
  }

  let locMissing = false;
  if (!dial.city) { missing.push("city"); locMissing = true; }
  if (!dial.state) { missing.push("state"); locMissing = true; }
  if (locMissing) labels.push("Location");

  if (!dial.industry) { missing.push("industry"); labels.push("Industry sector"); }

  return { missing, labels };
}

// Clicking "Schedule Intro Call" only validates the dial has enough info and
// opens the Calendly form — it does NOT create the client yet. The client
// record is only actually inserted once "Open Calendly" is pressed inside
// that form (see createClient below), so backing out of this popup without
// opening Calendly never leaves behind an orphaned client with no intro call
// attached.
async function handleScheduleIntroCallFromDial(dial) {
  const { missing, labels } = getMissingDialClientFields(dial);
  if (missing.length) {
    els.requiredPopupText.textContent = `Please fill out the missing information on this dial before scheduling an intro call: ${labels.join(", ")}.`;
    els.requiredPopup.classList.remove("hidden");
    return;
  }

  els.introCallPopupBody.innerHTML = buildIntroCallFormHTML();
  els.introCallPopup.classList.remove("hidden");
  wireIntroCallForm(els.introCallPopupBody, {
    internEmail,
    createClient: async () => {
      const data = defaultClient(profile, {
        first_name: dial.first_name || "",
        last_name: dial.last_name || "",
        city: dial.city || "",
        state: dial.state || "",
        email: dial.email || "",
        // Mobile number preferred; falls back to the company number if that's
        // the only one on file.
        phone: dial.mobile_phone || dial.company_phone || "",
        linkedin: dial.linkedin || "",
        company_name: dial.company_name || "",
        industry: dial.industry || "",
        // Call notes from the dial transfer straight into the new client's
        // Other notes field.
        other_notes: dial.call_notes || "",
      });
      data.assigned_to = profile.id;

      const { data: inserted, error } = await supabase.from("clients").insert(data).select().single();
      if (error) throw error;
      return inserted;
    },
    onScheduled: async (client) => {
      // We don't know the actual booked time here (Calendly handles that in
      // its own tab), so this just logs that the link was opened, timestamped
      // to now.
      await supabase.from("client_events").insert({
        client_id: client.id,
        event_type: "intro_call",
        event_date: new Date().toISOString(),
        details: { via: "calendly_link" },
        created_by: profile.id,
      });
      setTimeout(() => els.introCallPopup.classList.add("hidden"), 1200);
    },
  });
}

els.requiredPopupOk.addEventListener("click", () => els.requiredPopup.classList.add("hidden"));

// ---------------------------------------------------------------------------
// "Categories" (formerly the palette/dot filter button) — hides/shows dials
// by status across every list/tab. In-memory only (hiddenStatuses), so it
// resets on reload. Now a submenu of colored rectangles + labels, opened
// from the page-header triangle menu's "Categories" item.
// ---------------------------------------------------------------------------

function renderCategoriesSubmenu() {
  els.categoriesSubmenu.innerHTML = CONTACT_STATUSES.map(
    (s) => `
      <button type="button" class="category-rect-option ${hiddenStatuses.has(s.value) ? "is-hidden" : ""}" data-value="${s.value}">
        <span class="category-rect-swatch" style="background:${s.dot}; border-color:${s.border};"></span>${escapeHtml(s.label)}
      </button>`
  ).join("");
  els.categoriesSubmenu.querySelectorAll(".category-rect-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = btn.dataset.value;
      if (hiddenStatuses.has(v)) hiddenStatuses.delete(v);
      else hiddenStatuses.add(v);
      persistHiddenStatuses();
      renderCategoriesSubmenu();
      renderDialsTable();
    });
  });
}
renderCategoriesSubmenu();

// Position as fixed, computed from the button's rect (same escape-the-clip
// pattern as the dial-tab archive menu) — flips to the left side if it would
// run off the right edge of the screen.
function positionCategoriesSubmenu() {
  const rect = els.menuCategoriesBtn.getBoundingClientRect();
  const submenuWidth = els.categoriesSubmenu.offsetWidth || 190;
  let left = rect.right + 8;
  if (left + submenuWidth > window.innerWidth) {
    left = rect.left - submenuWidth - 8;
  }
  els.categoriesSubmenu.style.left = `${Math.max(8, left)}px`;
  els.categoriesSubmenu.style.top = `${rect.top}px`;
}

els.menuCategoriesBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = els.categoriesSubmenu.classList.contains("hidden");
  els.categoriesSubmenu.classList.toggle("hidden");
  if (opening) positionCategoriesSubmenu();
});

await loadLists();
