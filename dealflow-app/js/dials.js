import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";
import { STATES, escapeHtml, defaultClient } from "./clientForm.js";
import { buildIntroCallFormHTML, wireIntroCallForm } from "./introCall.js";
import { rfContact, contactActionIcons, stopContactActionPropagation, locationPinLink, buildPhoneNumbersHTML } from "./contactIcons.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus as closePageHeaderMenu } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { getDealSide, wireDealSideToggle } from "./dealSide.js";
import { getVisibleAccountIds, wireAccountsVisiblePopup, initDefaultToSelf } from "./accountsVisible.js";
import { createNotification, wireNotificationsToggle } from "./notifications.js";
import { cacheGet, cacheSet, isNetworkError, showOfflineNotice, hideOfflineNotice } from "./offlineCache.js";
import { timeOptionsHTML, timezoneOptionsHTML, defaultTimezone, zonedTimeToUtcIso } from "./eventTime.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;
const isAdmin = profile?.role === "admin";
// Team leads get the settings gear (Sellers/Buyers + Accounts visible) like
// admins do, but Accounts visible only ever lists their own teammates (see
// getAllAccounts near the bottom of this file). CSV import is also available
// to team leads; Transfer stays admin-only (isAdmin alone gates it) — a team
// lead is otherwise treated like an intern.
const isTeamLead = profile?.role === "team_lead";
// First-ever use of the shared Accounts visible setting defaults to "just
// me" instead of "Select all" — a no-op every subsequent load (see
// js/accountsVisible.js).
initDefaultToSelf(profile.id);

let allLists = []; // every dial_lists row (all types/statuses)
let dials = []; // dials belonging to the currently selected tab
// Buyer support was removed from the UI (the app was sellers-only for a
// while) but the `dial_lists.dial_type` column never went away — it's now
// re-exposed via the admin-only Sellers/Buyers settings toggle (see
// js/dealSide.js). Starts at whatever getDealSide() currently resolves to
// (always "seller" for non-admins) and gets reassigned when an admin flips
// the toggle — see the wireDealSideToggle call further down.
let currentType = getDealSide();
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
  { value: "intro_call_scheduled", label: "Accepted intro call", bg: "var(--status-scheduled-bg)", border: "var(--status-scheduled-border)", dot: "var(--status-scheduled-dot)" },
];
function statusInfo(value) {
  return CONTACT_STATUSES.find((s) => s.value === value) || CONTACT_STATUSES[0];
}

// Which statuses are currently hidden from every list/tab (toggled via the
// palette filter button).
const hiddenStatuses = new Set();

// ---------------------------------------------------------------------------
// Select mode (bulk-select dials for mass email/text/move/delete) — see
// enterSelectMode/exitSelectMode, renderDialsTable's selectMode branch, and
// the select-mode-bar wiring below. `selectedDialIds` only ever holds ids
// belonging to whatever tab was active when select mode was entered — select
// mode is exited (clearing the set) as soon as the user switches tabs for any
// reason other than completing a Move (see the document click listener and
// wireTabInteractions' click handler).
// ---------------------------------------------------------------------------
let selectMode = false;
let moveMode = false;
let selectedDialIds = new Set();

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
  settingsMenu: document.getElementById("settingsMenu"),
  dealSideToggleBtn: document.getElementById("dealSideToggleBtn"),
  dealSideLabel: document.getElementById("dealSideLabel"),
  menuAddNewBtn: document.getElementById("menuAddNewBtn"),
  menuImportBtn: document.getElementById("menuImportBtn"),
  menuSelectBtn: document.getElementById("menuSelectBtn"),
  menuStatusBtn: document.getElementById("menuStatusBtn"),
  menuCategoriesBtn: document.getElementById("menuCategoriesBtn"),
  categoriesSubmenu: document.getElementById("categoriesSubmenu"),
  menuAccountsVisibleBtn: document.getElementById("menuAccountsVisibleBtn"),
  accountsVisiblePopup: document.getElementById("accountsVisiblePopup"),
  accountsVisibleBody: document.getElementById("accountsVisibleBody"),
  accountsVisibleClose: document.getElementById("accountsVisibleClose"),
  menuNotificationsBtn: document.getElementById("menuNotificationsBtn"),
  notificationsLabel: document.getElementById("notificationsLabel"),
  dialsProspectCount: document.getElementById("dialsProspectCount"),
  dialTabs: document.getElementById("dialTabs"),
  dialTabArchiveMenu: document.getElementById("dialTabArchiveMenu"),
  dialTabRenameBtn: document.getElementById("dialTabRenameBtn"),
  dialTabArchiveBtn: document.getElementById("dialTabArchiveBtn"),
  dialTabTransferBtn: document.getElementById("dialTabTransferBtn"),
  dialTabTransferMenu: document.getElementById("dialTabTransferMenu"),
  dialTabTransferBackBtn: document.getElementById("dialTabTransferBackBtn"),
  dialTabTransferList: document.getElementById("dialTabTransferList"),
  dialTabClientBtn: document.getElementById("dialTabClientBtn"),
  dialTabClientMenu: document.getElementById("dialTabClientMenu"),
  dialTabClientBackBtn: document.getElementById("dialTabClientBackBtn"),
  dialTabClientList: document.getElementById("dialTabClientList"),
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
  newListBuyerSelect: document.getElementById("newListBuyerSelect"),
  newListCreateBtn: document.getElementById("newListCreateBtn"),
  newListCancelBtn: document.getElementById("newListCancelBtn"),
  confirmDeleteModal: document.getElementById("confirmDeleteModal"),
  emailReplyConfirmModal: document.getElementById("emailReplyConfirmModal"),
  introCallPopup: document.getElementById("introCallPopup"),
  introCallPopupBody: document.getElementById("introCallPopupBody"),
  introCallPopupClose: document.getElementById("introCallPopupClose"),
  introCallTimeModal: document.getElementById("introCallTimeModal"),
  introCallTimeDateInput: document.getElementById("introCallTimeDateInput"),
  introCallTimeSelect: document.getElementById("introCallTimeSelect"),
  introCallTimeZoneSelect: document.getElementById("introCallTimeZoneSelect"),
  introCallTimeError: document.getElementById("introCallTimeError"),
  introCallTimeConfirmBtn: document.getElementById("introCallTimeConfirmBtn"),
  importDialsModal: document.getElementById("importDialsModal"),
  importDialsError: document.getElementById("importDialsError"),
  importDialsDropzone: document.getElementById("importDialsDropzone"),
  importDialsFileInput: document.getElementById("importDialsFileInput"),
  importDialsChooseBtn: document.getElementById("importDialsChooseBtn"),
  importDialsFileName: document.getElementById("importDialsFileName"),
  importDialsBuyerSelect: document.getElementById("importDialsBuyerSelect"),
  importDialsImportBtn: document.getElementById("importDialsImportBtn"),
  importDialsCancelBtn: document.getElementById("importDialsCancelBtn"),
  selectModeBar: document.getElementById("selectModeBar"),
  selectBackBtn: document.getElementById("selectBackBtn"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  selectMassEmailBtn: document.getElementById("selectMassEmailBtn"),
  selectMassTextBtn: document.getElementById("selectMassTextBtn"),
  selectMoveBtn: document.getElementById("selectMoveBtn"),
  selectDeleteBtn: document.getElementById("selectDeleteBtn"),
  selectMoveHint: document.getElementById("selectMoveHint"),
  confirmBulkDeleteModal: document.getElementById("confirmBulkDeleteModal"),
  confirmBulkDeleteTitle: document.getElementById("confirmBulkDeleteTitle"),
  massContactWarningModal: document.getElementById("massContactWarningModal"),
  massContactWarningTitle: document.getElementById("massContactWarningTitle"),
  massContactWarningText: document.getElementById("massContactWarningText"),
  massContactWarningContinueBtn: document.getElementById("massContactWarningContinueBtn"),
  massContactWarningCancelBtn: document.getElementById("massContactWarningCancelBtn"),
};

// CSV import and Transfer are both available to team leads too now (see
// transfer_dial_list() in supabase/schema.sql, which enforces a team lead
// can only transfer their own or their team's tabs, and only to an admin or
// an intern on their own team — openTransferMenu below applies that same
// scoping to the target-account list it shows).
if (isAdmin || isTeamLead) els.menuImportBtn.classList.remove("hidden");
if (isAdmin || isTeamLead) els.dialTabTransferBtn.classList.remove("hidden");
if (isAdmin || isTeamLead) els.dialTabClientBtn.classList.remove("hidden");
if (isAdmin || isTeamLead) els.menuAccountsVisibleBtn.classList.remove("hidden");
// Manual "+ new tab" creation — same admin/team-lead-only scope as CSV
// import above (interns can't create tabs at all; enforced server-side too,
// see the dial_lists_insert_own RLS policy).
if (isAdmin || isTeamLead) els.addTabBtn.classList.remove("hidden");
// Notifications on/off — everyone gets this (see js/notifications.js),
// unlike Import/Transfer/Accounts visible above which stay admin/team-lead
// only.
wireNotificationsToggle(els.menuNotificationsBtn, els.notificationsLabel, profile);

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
// menu (via updateArchiveMenuVisibility()) the instant Delete was confirmed —
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
  return d.full_name || "Unnamed dial";
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
    full_name: "", city: "", state: "", email: "",
    mobile_phone: "", company_phone: "", linkedin: "", company_name: "",
    website: "", industry: "", summary: "", call_notes: "", contact_status: "uncontacted",
    contacted_mobile_date: null, contacted_company_date: null, contacted_email_date: null,
  };
}

// ---------------------------------------------------------------------------
// CSV import (admin/team-lead, "Import" menu item — see els.menuImportBtn below).
// Parses the file entirely client-side (no server round-trip needed for
// something this small), matches column headers to dial fields by name, and
// bulk-inserts one dials row per data row into a brand-new tab named after
// the file.
// ---------------------------------------------------------------------------

// Minimal RFC4180-ish CSV parser: handles quoted fields (including embedded
// commas/newlines) and "" as an escaped quote inside a quoted field. Good
// enough for CSVs exported from Excel/Google Sheets/Numbers, which is the
// only realistic source here.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// column header (any reasonable spelling/casing) -> dial field name. Each
// dial field only ever gets matched to the FIRST header that matches one of
// its aliases, so a CSV with both "Phone" and "Mobile" columns doesn't have
// the second one silently overwrite the first. "contact_status" is special —
// its raw cell values aren't dial field text, they're CSV export statuses
// that need translating through CSV_STATUS_VALUE_MAP (see rowsToDials).
const DIAL_FIELD_ALIASES = {
  // A single "Full Name" column maps straight to the dial's own full_name
  // column; separate "First Name"/"Last Name" columns (still real, still
  // seen in some sheets) get joined into one at the end of the row-building
  // loop instead — see the special-casing in rowsToDials below, same
  // pattern as contact_status's own translation step.
  full_name: ["full name", "fullname", "name", "client name", "contact name"],
  first_name: ["first name", "firstname", "first"],
  last_name: ["last name", "lastname", "last"],
  company_name: ["company name", "company", "business name", "business"],
  email: ["email", "email address", "e mail"],
  // "Phone - Mobile" (some CRM exports' own naming for the personal cell
  // number, distinct from "Phone - Website" below) normalizes to "phone
  // mobile". "Mobie number" is a real, observed header typo (missing the
  // "l" in "Mobile") from an actual imported sheet — kept as its own
  // literal alias since it's a genuine header text some spreadsheet out
  // there uses, not something a smarter normalizer would catch.
  mobile_phone: ["mobile phone", "mobile", "cell phone", "cell", "phone", "phone number", "phone mobile", "mobile number", "mobie number"],
  // "Phone - Website" is that same export's naming for the general/company
  // line (associated with the business's own website/HQ, not a person's
  // cell) — normalizes to "phone website". "Company number" is another
  // real observed header for this same field.
  company_phone: ["company phone", "office phone", "business phone", "work phone", "phone website", "company number"],
  linkedin: ["linkedin", "linkedin url", "linkedin profile"],
  city: ["city"],
  state: ["state"],
  website: ["website", "url", "web site", "web address", "business url"],
  // "Mandate" alone (no "- Industry sector" suffix) is the real header seen
  // on the Austin Price sheet — the same field, just named more tersely.
  industry: ["industry", "industry sector", "sector", "mandate industry sector", "mandate"],
  summary: ["summary", "notes", "description"],
  // Exact-match only (see headerMatchesField below), so this never collides
  // with summary's own bare "notes" alias above — a "Call notes" column
  // saves into the dial's Call notes box (call_notes), completely separate
  // from the Summary field.
  call_notes: ["call notes", "callnotes", "call note"],
  contact_status: ["status"],
};

// A "Status" column's cell values (as seen in real CSV exports) -> this
// app's internal contact_status enum (see CONTACT_STATUSES above). Keys are
// normalized the same way as everything else (trimmed, lowercased) but
// punctuation like "/" and "-" is kept since it's part of the label itself —
// see normalizeStatusValue. An empty cell maps to "uncontacted" explicitly
// (rather than just being skipped), matching "Empty box = Uncontacted".
// Any value with no match here is simply left alone (falls back to whatever
// the dials table's own default is, currently also "uncontacted").
const CSV_STATUS_VALUE_MAP = {
  "": "uncontacted",
  "passed/dead": "not_interested",
  "scheduling intro": "intro_call_scheduled",
  "call unanswered": "no_response",
  "not a fit": "not_interested",
  "completed outreach": "unable_to_contact",
  "follow-up": "no_response",
  "follow up": "no_response",
};

function normalizeStatusValue(v) {
  return String(v || "").trim().toLowerCase();
}

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// contact_status is matched more loosely than every other field: real CSV
// exports/spreadsheets label this column all sorts of things ("Status",
// "Call Status", "Contact Status", "Lead Status", "Current Status", ...), so
// requiring an exact match against a fixed alias list (like every other
// field below) kept missing real headers that simply weren't the bare word
// "status" — which meant NO column ever got mapped to contact_status for
// that CSV, every imported row was built with contact_status left
// completely unset, and the insert failed with "null value in column
// contact_status violates not-null constraint" (see rowsToDials's own
// baseline default for the second, belt-and-suspenders layer of this fix).
// "contains" is safe here specifically because it only runs for the one
// field where we WANT breadth — every other field still requires an exact
// alias match, so e.g. a "Sub status" or "Status notes" column won't get
// misrouted into some unrelated field.
function headerMatchesField(field, aliases, norm) {
  if (field === "contact_status") return norm.includes("status");
  return aliases.some((a) => normalizeHeader(a) === norm);
}

// Maps each column index in the header row to a dial field key, wherever a
// match is found — unmatched columns are simply ignored on import.
function buildHeaderFieldMap(headerRow) {
  const map = {};
  const usedFields = new Set();
  headerRow.forEach((rawHeader, colIndex) => {
    const norm = normalizeHeader(rawHeader);
    if (!norm) return;
    for (const [field, aliases] of Object.entries(DIAL_FIELD_ALIASES)) {
      if (usedFields.has(field)) continue;
      if (headerMatchesField(field, aliases, norm)) {
        map[colIndex] = field;
        usedFields.add(field);
        break;
      }
    }
  });
  return map;
}

// Turns parsed CSV rows (including the header row at index 0) into an array
// of dials-table-ready insert objects for `listId`. Blank rows (every cell
// empty) are skipped.
function rowsToDials(rows, listId) {
  if (rows.length < 2) return [];
  const fieldMap = buildHeaderFieldMap(rows[0]);
  return rows
    .slice(1)
    .filter((r) => r.some((cell) => (cell || "").trim() !== ""))
    .map((r) => {
      // contact_status always starts with a valid fallback value baked in —
      // even if this CSV has no recognizable Status column at all (see
      // headerMatchesField above), every row built here still has SOME
      // explicit, valid value for it. Gets overwritten below if a Status
      // column was actually found and mapped.
      const d = { list_id: listId, contact_status: "uncontacted" };
      Object.entries(fieldMap).forEach(([colIndex, field]) => {
        const v = (r[Number(colIndex)] || "").trim();
        // A "Status" column's cell isn't plain text to copy over — it's a CSV
        // export label that needs translating through CSV_STATUS_VALUE_MAP
        // into this app's own contact_status enum (see the map's comment
        // above). Whenever a Status column is present at all, EVERY row must
        // come out with some valid contact_status value (never just left
        // unset) — falling back to "uncontacted" for anything not in the map
        // (per spec: "if the box does not match anything in the list, mark
        // it as uncontacted"). This also happens to be required for
        // correctness, not just intent: supabase-js's bulk insert() sends one
        // shared column list for the whole batch, so a handful of rows in the
        // same import quietly having NO contact_status key (while others do)
        // gets those rows' contact_status sent as an explicit NULL rather
        // than falling back to the column's DEFAULT — which is exactly what
        // was tripping the "null value in column contact_status violates
        // not-null constraint" error.
        if (field === "contact_status") {
          const norm = normalizeStatusValue(v);
          if (CSV_STATUS_VALUE_MAP[norm]) {
            d.contact_status = CSV_STATUS_VALUE_MAP[norm];
          } else if (norm.includes("nda") || norm.includes("loi")) {
            // NDA/LOI-stage statuses (e.g. "NDA Signed", "LOI Signed" — real
            // deal-stage values seen in actual CSV exports that aren't in
            // CSV_STATUS_VALUE_MAP above, since they're specific to certain
            // sheets rather than universal) count as real, live engagement —
            // grouped under "Accepted intro call" rather than falling all
            // the way back to "Uncontacted" like every other unrecognized
            // value.
            d.contact_status = "intro_call_scheduled";
          } else {
            d.contact_status = "uncontacted";
          }
          return;
        }
        if (v) d[field] = v;
      });
      // dials no longer has separate first_name/last_name columns (see the
      // full_name migration) — a CSV with those (instead of, or alongside, a
      // "Full Name" column) gets them joined into one full_name value here.
      // An explicit Full Name column (set directly above, same as any other
      // field) always wins if this same CSV happened to have both; first_name/
      // last_name are just temporary holders, deleted below either way.
      if (!d.full_name) {
        const combined = `${d.first_name || ""} ${d.last_name || ""}`.trim();
        if (combined) d.full_name = combined;
      }
      delete d.first_name;
      delete d.last_name;
      return d;
    });
}

// Local calendar date (not UTC) as YYYY-MM-DD — used for the "Did call
// today" toggle, which just compares against this rather than needing a
// scheduled job to reset at midnight.
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The real UTC instants a LOCAL calendar date (as produced by todayDateStr)
// starts and ends at — for filtering call_status_changes.changed_at
// (timestamptz) by "today" in commitContactCheck/syncTodaysCallLogSnapshot.
// `new Date(\`${dateStr}T00:00:00\`)` (no offset suffix) parses as LOCAL
// midnight per the JS Date spec, same fix as formatDateOnly in
// js/reports.js; .toISOString() then carries the correct UTC offset.
// Confirmed as a REAL bug in production: the old code built the window as
// bare `${today}T00:00:00`/`${today}T23:59:59.999` strings with no offset,
// which PostgREST parses as UTC — for anyone in a negative UTC-offset
// timezone, an evening check/uncheck (after ~5-6pm US time, once UTC has
// already rolled to the next calendar day) landed OUTSIDE that UTC-today
// window entirely. Unchecking still cleared the dial's own checked flag
// correctly (a plain string compare, no timestamp math involved), so the
// circle visibly went white/unchecked — but the delete silently matched
// nothing, leaving the call_status_changes row (and its contact count)
// permanently stuck, with no way to tell from the UI that it hadn't
// actually been removed.
function localDayBoundsIso(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// Which `dials` date column tracks "checked today" for each contact
// method's white circle (see contactCheckCircleHTML/toggleContactCheck
// below) — one independent daily toggle per method, replacing the old
// single "Called today" button/called_today_date. Each resets the same way
// called_today_date used to: it's just a date, compared against
// todayDateStr(), so a stale non-today value naturally reads as unchecked
// with no cron job needed.
const CONTACT_METHOD_DATE_COLUMNS = {
  mobile: "contacted_mobile_date",
  company: "contacted_company_date",
  email: "contacted_email_date",
};

// How many of the 3 circles are checked today — drives the "Contacted today
// x0"/"x1"/"x2"/"x3" display (white at 0, green otherwise). See
// buildContactedTodayDisplayHTML.
function contactedTodayCount(dial) {
  const today = todayDateStr();
  return Object.values(CONTACT_METHOD_DATE_COLUMNS).filter((col) => dial[col] === today).length;
}

// Keeps today's already-logged call_status_changes row(s) in sync with the
// dial's own info as it gets filled in during/after the same call —
// toggleContactCheck() only snapshots once, at the exact moment a circle is
// checked, which in practice is often BEFORE the outcome is known (status is
// set and notes are typed once the call has actually happened). Confirmed as
// a real bug in production: freshly-logged calls were coming through with
// null website/city/state/industry/call_notes even though the dial itself
// had all of it, because those fields hadn't been filled in yet at the
// instant a circle was checked. Only ever UPDATEs row(s) that already exist
// for today (there can be up to 3 now, one per checked circle) — never
// inserts one (that stays toggleContactCheck's job alone), and never touches
// a PAST day's already-frozen snapshot.
async function syncTodaysCallLogSnapshot(fields) {
  if (!currentDial || contactedTodayCount(currentDial) === 0) return;
  const { startIso, endIso } = localDayBoundsIso(todayDateStr());
  await supabase
    .from("call_status_changes")
    .update(fields)
    .eq("dial_id", currentDial.id)
    .eq("user_id", profile.id)
    .gte("changed_at", startIso)
    .lt("changed_at", endIso);
}

// ---------------------------------------------------------------------------
// Per-contact-method "contacted today" check circles — one next to each
// listed contact method's instant-action icons (mobile/company phone,
// email), white/unchecked by default, green with a checkmark once checked.
// Same size and spacing as the instant-call/text/email icons they sit next
// to (see .dial-contact-check reusing .contact-action-btn's sizing/gap in
// css/style.css) since they're rendered as one more item inside that same
// .contact-actions row — see contactIcons.js's `extra` param.
// ---------------------------------------------------------------------------
const CONTACT_CHECK_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

function contactCheckCircleHTML(method, dial) {
  const checked = dial[CONTACT_METHOD_DATE_COLUMNS[method]] === todayDateStr();
  return `<button type="button" class="contact-action-btn dial-contact-check ${checked ? "checked" : ""}" data-method="${method}" title="Mark contacted">${checked ? CONTACT_CHECK_SVG : ""}</button>`;
}

// Wires every .dial-contact-check circle currently in the dial modal body —
// called once per render, right after els.dialModalBody.innerHTML is set
// (same pattern as stopContactActionPropagation next to it).
function wireContactCheckCircles() {
  els.dialModalBody.querySelectorAll(".dial-contact-check[data-method]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleContactCheck(btn.dataset.method);
    });
  });
}

// Non-interactive "Contacted today xN" display — white at 0, green
// otherwise. Replaces the old clickable "Called today" button; the circles
// above are the only way to change this now (see toggleContactCheck).
function buildContactedTodayDisplayHTML(dial) {
  const count = contactedTodayCount(dial);
  return `<div class="dial-contacted-today-display ${count > 0 ? "active" : ""}">Contacted today x${count}</div>`;
}

// Checking/unchecking one of the 3 per-contact-method circles — the same
// underlying mechanic as the old single "Called today" toggle (a date column
// compared against todayDateStr(), naturally resetting each day), just split
// three ways so up to 3 can be checked independently the same day instead of
// only 1. Each checked circle logs its own call_status_changes row, tagged
// with which method it was (contact_method) so unchecking that ONE circle
// later the same day can delete exactly that row instead of guessing among
// however many others are also logged today for this dial.
//
// Email is the one exception: checking it (mobile/company check instantly)
// first asks "Have they replied to an email?" via els.emailReplyConfirmModal
// — only a "Yes" there actually checks the circle and logs the contact.
// Unchecking an already-checked email circle is instant either way, same as
// mobile/company.
let contactCheckToggleInFlight = false;
async function toggleContactCheck(method) {
  if (contactCheckToggleInFlight) return;
  const col = CONTACT_METHOD_DATE_COLUMNS[method];
  const today = todayDateStr();
  const isChecked = currentDial[col] === today;

  if (!isChecked && method === "email") {
    openConfirmModal(els.emailReplyConfirmModal, "emailReplyConfirmYesBtn", "emailReplyConfirmNoBtn", () => commitContactCheck(method, true));
    return;
  }
  await commitContactCheck(method, !isChecked);
}

// Network blips during this write were previously surfacing the raw fetch
// error text ("TypeError: Load failed" etc.) straight into the modal via
// showError — every other read/write path in the app already routes a
// connectivity failure through isNetworkError() for a friendly message
// instead (see loadLists() above for the pattern this mirrors).
function showContactCheckError(err) {
  if (isNetworkError(err)) return showError(els.dialModalError, { message: "No internet connection — try again." });
  showError(els.dialModalError, err);
}

async function commitContactCheck(method, checking) {
  if (contactCheckToggleInFlight) return;
  contactCheckToggleInFlight = true;
  try {
    // Same reasoning as updateDialStatus — flush any pending notes edit
    // before this re-renders the popup.
    await flushCallNotes();
    const col = CONTACT_METHOD_DATE_COLUMNS[method];
    const today = todayDateStr();
    const newValue = checking ? today : null;

    // currentDial/dials are only mutated once, at the very end, after BOTH
    // writes below are confirmed to have succeeded — previously the first
    // write's success alone drove an immediate in-memory mutation, so a
    // failure of the SECOND write (which went entirely unchecked) could
    // leave currentDial silently out of sync with what the circle still
    // displayed on screen.
    const { error } = await supabase.from("dials").update({ [col]: newValue }).eq("id", currentDial.id);
    if (error) return showContactCheckError(error);

    if (!checking) {
      const { startIso, endIso } = localDayBoundsIso(today);
      const { error: logError } = await supabase
        .from("call_status_changes")
        .delete()
        .eq("dial_id", currentDial.id)
        .eq("user_id", profile.id)
        .eq("contact_method", method)
        .gte("changed_at", startIso)
        .lt("changed_at", endIso);
      if (logError) return showContactCheckError(logError);
    } else {
      // Permanent, FK-less snapshot for the Reports feature (see
      // js/reports.js) — dial_lists rows are hard-deleted (cascading to
      // their dials) when a tab is removed, so this is the only place these
      // facts survive that deletion. contact_method tags which circle logged
      // this row so a later uncheck of that SAME circle can find and delete
      // only this one row, even if other circles also logged rows today.
      const currentListForBuyer = allLists.find((l) => l.id === currentDial.list_id);
      const { error: logError } = await supabase.from("call_status_changes").insert({
        user_id: profile.id,
        dial_id: currentDial.id,
        dial_type: currentType,
        list_id: currentDial.list_id,
        contact_status_at_call: currentDial.contact_status,
        contact_method: method,
        buyer_id: currentListForBuyer?.buyer_id || null,
        company_name: currentDial.company_name || null,
        contact_name: currentDial.full_name || null,
        website: currentDial.website || null,
        city: currentDial.city || null,
        state: currentDial.state || null,
        industry: currentDial.industry || null,
        call_notes: currentDial.call_notes || null,
      });
      if (logError) return showContactCheckError(logError);
    }

    currentDial[col] = newValue;
    const idx = dials.findIndex((d) => d.id === currentDial.id);
    if (idx !== -1) dials[idx][col] = newValue;
    renderDialModal();
  } catch (err) {
    showContactCheckError(err);
  } finally {
    contactCheckToggleInFlight = false;
  }
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
// the category, toggling a contact-method check circle, opening edit mode,
// and closing the popup — so notes are never silently dropped if one of
// those happens before blur would have fired on its own, and so a
// status-button click can no longer race a still-in-flight notes save into
// overwriting the just-typed text with stale data on the next render (see
// goToDial/updateDialStatus/commitContactCheck, all of which now `await`
// this before doing anything else).
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
  await syncTodaysCallLogSnapshot({ call_notes: val });
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
  if (error) {
    if (!isNetworkError(error)) return showError(els.errorBox, error);
    const cached = cacheGet("dial_lists");
    if (!cached) return showOfflineNotice(false);
    allLists = cached;
    showOfflineNotice(true);
    renderTabs();
    return;
  }
  hideOfflineNotice();
  allLists = data || [];
  cacheSet("dial_lists", allLists);
  renderTabs();
}

function filteredLists() {
  const visibleAccountIds = getVisibleAccountIds();
  return allLists
    .filter(
      (l) =>
        l.dial_type === currentType &&
        l.status === currentStatus &&
        // Admin-only "Accounts visible" filter — applied before the tab list
        // is even built, same layering as Clients' renderTable (see
        // js/accountsVisible.js). null means no account filter is active
        // (every account's tabs pass through).
        (!visibleAccountIds || visibleAccountIds.has(l.created_by))
    )
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
  // Re-appended (moved, not cloned — same node, so its click listener from
  // module init stays bound) as the last child of #dialTabs itself rather
  // than staying a separate sibling in .dials-tabbar. That makes it one more
  // item in the SAME wrapping flex row as the tab chips (see .dials-tabs in
  // css/style.css), so on desktop it naturally sits right after the last tab
  // when there's room and only drops to its own line below the tabs when
  // there isn't — instead of always floating to the right of the whole
  // (possibly multi-line) tab block.
  els.dialTabs.appendChild(els.addTabBtn);
  updateArchiveMenuVisibility();
  loadDials();
}

// The tab options menu (#dialTabArchiveMenu, plus its Transfer/Client
// drill-downs) reuses .page-header-menu's own in-flow styling and DOM slot
// (between .dials-tabbar and #dialsTableWrap in dials.html) rather than
// floating as a popup anchored to the tapped tab — so showing/hiding it is
// just a class toggle, no position math needed. Available on both mobile
// (tap the already-active tab) and desktop (click it) — see the tab click
// handler in wireTabInteractions().
function updateArchiveMenuVisibility() {
  const shows = archiveMenuTabId && archiveMenuTabId === currentListId && els.dialTabs.querySelector(".dial-tab.active");
  if (!shows) {
    els.dialTabArchiveMenu.classList.add("hidden");
    els.dialTabTransferMenu.classList.add("hidden");
    els.dialTabClientMenu.classList.add("hidden");
    return;
  }
  els.dialTabArchiveBtn.textContent = currentStatus === "current" ? "Archive" : "Unarchive";
  els.dialTabArchiveMenu.classList.remove("hidden");
}

function closeArchiveMenu() {
  if (!archiveMenuTabId) return;
  archiveMenuTabId = null;
  els.dialTabTransferMenu.classList.add("hidden");
  els.dialTabClientMenu.classList.add("hidden");
  updateArchiveMenuVisibility();
}

// Closes the Archive/Delete popup as soon as anything ELSE is interacted
// with — a dial row, the settings icon, the page-header triangle, the
// Categories button, etc. Only three things are deliberately exempted:
//  - clicks inside the popup itself (its own Archive/Unarchive and Delete
//    buttons handle themselves, via setListArchived()/the confirm-delete flow)
//  - clicks inside the admin-only "Transfer to..." popup (its own option
//    buttons handle themselves, via completeTransfer())
//  - clicks on any dial tab button, since that's the element whose own click
//    handler (see wireTabInteractions) already opens/toggles this same popup
//    for the active tab — closing it here first would fight that logic.
document.addEventListener("click", (e) => {
  if (!archiveMenuTabId) return;
  if (els.dialTabArchiveMenu.contains(e.target)) return;
  if (els.dialTabTransferMenu.contains(e.target)) return;
  if (els.dialTabClientMenu.contains(e.target)) return;
  if (e.target.closest(".dial-tab")) return;
  closeArchiveMenu();
});

// Rename, reusing the same double-click-to-rename flow (startRenameTab)
// that already exists on the tab button itself — this is just a second,
// more discoverable entry point into that same rename UI, reached through
// the Archive/Delete popup instead of requiring a double-click.
els.dialTabRenameBtn.addEventListener("click", () => {
  if (!archiveMenuTabId) return;
  const list = filteredLists().find((l) => l.id === archiveMenuTabId);
  const btn = els.dialTabs.querySelector(".dial-tab.active");
  if (!list || !btn) return;
  closeArchiveMenu();
  startRenameTab(btn, list);
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
  els.dialTabTransferMenu.classList.add("hidden");
  els.dialTabClientMenu.classList.add("hidden");
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
    () => updateArchiveMenuVisibility()
  );
});

// ---------------------------------------------------------------------------
// Admin-only "Transfer" — hands off one of the current admin's own tabs (and
// every dial in it) to a different account, by reassigning created_by on both
// dial_lists and dials (see the widened RLS update policies for both tables
// in supabase/schema.sql). The tab then disappears from the transferring
// admin's Dials page and starts appearing on the new owner's instead, since
// both tables' select policies scope visibility to created_by = auth.uid().
// ---------------------------------------------------------------------------

// Drills down from #dialTabArchiveMenu into the same in-flow slot (see
// dials.html) rather than opening a separate floating popup beside it —
// #dialTabTransferBackBtn (wired below) returns to it.
async function openTransferMenu() {
  els.dialTabTransferList.innerHTML = `<div class="dial-tab-transfer-empty">Loading…</div>`;
  els.dialTabArchiveMenu.classList.add("hidden");
  els.dialTabTransferMenu.classList.remove("hidden");

  // Normally every OTHER account in the company (or, for a team lead, every
  // admin plus every intern on their own team — see transfer_dial_list() in
  // supabase/schema.sql, which enforces this same scoping server-side) —
  // never the account doing the transferring, since a tab can't be
  // "transferred" to its own owner. BUT if the tab being transferred belongs
  // to someone else (viewing another account's tab via Accounts visible),
  // the caller's own name IS included, so they have the option to transfer
  // it back to themselves rather than only ever being able to hand it off
  // sideways to a third account.
  const list = filteredLists().find((l) => l.id === archiveMenuTabId);
  const isOwnTab = !list || list.created_by === profile.id;
  let query = supabase.from("profiles").select("id, full_name").order("full_name", { ascending: true });
  if (isTeamLead) {
    query = query.or(`role.eq.admin,and(role.eq.intern,team_id.eq.${profile.team_id}),id.eq.${profile.id}`);
  }
  if (isOwnTab) query = query.neq("id", profile.id);
  const { data, error } = await query;

  if (error) {
    els.dialTabTransferList.innerHTML = `<div class="dial-tab-transfer-empty">Couldn't load accounts.</div>`;
    return;
  }
  const targets = data || [];
  if (!targets.length) {
    els.dialTabTransferList.innerHTML = `<div class="dial-tab-transfer-empty">No other accounts yet.</div>`;
  } else {
    // Only reachable when isOwnTab is false (viewing someone else's tab via
    // Accounts visible) — that's the one case where the list isn't filtered
    // down to exclude anyone, so the tab's CURRENT owner can be among
    // `targets`. Pulled out and shown as its own non-clickable row above a
    // divider, at the top, instead of sitting inline among the real
    // (clickable) options — tapping "transfer it to the person who already
    // has it" isn't a real action. A plain <div> (not <button>), and a
    // separate class from .dial-tab-transfer-option, so it's naturally
    // excluded from the click-wiring querySelectorAll below.
    const ownerTarget = targets.find((p) => p.id === list?.created_by);
    const otherTargets = targets.filter((p) => p.id !== list?.created_by);
    const ownerHTML = ownerTarget
      ? `<div class="dial-tab-transfer-owner">${escapeHtml(ownerTarget.full_name)} (tab owner)</div><div class="dial-tab-transfer-divider"></div>`
      : "";
    const optionsHTML = otherTargets.length
      ? otherTargets
          .map((p) => `<button type="button" class="dial-tab-transfer-option" data-id="${p.id}">${escapeHtml(p.full_name)}${p.id === profile.id ? " (you)" : ""}</button>`)
          .join("")
      : `<div class="dial-tab-transfer-empty">No other accounts yet.</div>`;
    els.dialTabTransferList.innerHTML = ownerHTML + optionsHTML;
    els.dialTabTransferList.querySelectorAll(".dial-tab-transfer-option").forEach((btn) => {
      btn.addEventListener("click", () => completeTransfer(btn.dataset.id));
    });
  }
}

async function completeTransfer(targetId) {
  const tabId = archiveMenuTabId;
  if (!tabId) return;
  els.dialTabTransferMenu.classList.add("hidden");
  els.dialTabArchiveMenu.classList.add("hidden");

  // Reassigns created_by on both dial_lists and every dial under it in one
  // trusted, `security definer` operation (see transfer_dial_list in
  // supabase/schema.sql) instead of two direct .update() calls — those used
  // to rely on dial_lists_update_own/dials_update_own being widened to allow
  // any admin to edit any row, which (as a side effect) also let every admin
  // SEE every account's tabs all the time. Now that visibility is back to
  // strictly created_by = auth.uid() for everyone, the reassignment itself
  // has to go through this function instead, so a tab transferred away from
  // the admin who's transferring it correctly disappears from their own
  // Dials page right after.
  const { error } = await supabase.rpc("transfer_dial_list", { p_list_id: tabId, p_new_owner: targetId });
  if (error) return showError(els.errorBox, error);

  // Let the recipient know a tab of dials just landed in their account — see
  // js/notifications.js. Best-effort: a failure here shouldn't block or
  // error out the transfer itself, which already succeeded above.
  if (targetId !== profile.id) {
    createNotification(targetId, `${profile.full_name} sent you a list of people to contact.`, "dial_transfer");
  }

  archiveMenuTabId = null;
  currentListId = null;
  await loadLists();
}

els.dialTabTransferBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!archiveMenuTabId) return;
  openTransferMenu();
});

// Returns to #dialTabArchiveMenu without closing the whole options menu or
// forgetting which tab it's for (archiveMenuTabId is untouched).
els.dialTabTransferBackBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  els.dialTabTransferMenu.classList.add("hidden");
  updateArchiveMenuVisibility();
});

// ---------------------------------------------------------------------------
// Admin/team-lead "Client" — reassigns which buyer an EXISTING tab (and every
// dial in it, since attribution flows entirely through dial_lists.buyer_id)
// is attached to. The tab-creation picker (see loadContractSignedBuyers()/
// populateBuyerSelect() above) only ever gets one shot at this; this is the
// "fix it later" path, reusing that exact same eligible-buyer pool.
// ---------------------------------------------------------------------------

// Same drill-down pattern as openTransferMenu() above.
async function openClientMenu() {
  els.dialTabClientList.innerHTML = `<div class="dial-tab-transfer-empty">Loading…</div>`;
  els.dialTabArchiveMenu.classList.add("hidden");
  els.dialTabClientMenu.classList.remove("hidden");

  const list = filteredLists().find((l) => l.id === archiveMenuTabId);
  const buyers = await loadContractSignedBuyers();
  const options = [{ id: "", full_name: "Not assigned to buyer" }, ...buyers];

  els.dialTabClientList.innerHTML = options
    .map(
      (b) =>
        `<button type="button" class="dial-tab-transfer-option" data-id="${b.id}">${escapeHtml(b.full_name)}${(list?.buyer_id || "") === b.id ? " (current)" : ""}</button>`
    )
    .join("");
  els.dialTabClientList.querySelectorAll(".dial-tab-transfer-option").forEach((btn) => {
    btn.addEventListener("click", () => completeClientAssign(btn.dataset.id || null));
  });
}

async function completeClientAssign(buyerId) {
  const tabId = archiveMenuTabId;
  if (!tabId) return;
  els.dialTabClientMenu.classList.add("hidden");
  els.dialTabArchiveMenu.classList.add("hidden");

  // security definer — dial_lists_update_own RLS would otherwise block a
  // team lead reassigning a tab owned by one of their own interns (same
  // reasoning as transfer_dial_list above); also re-validates server-side
  // that a non-admin's chosen buyer is actually one their team owns with a
  // confirmed Contract signed, mirroring loadContractSignedBuyers()'s own
  // client-side filter so the check can't be bypassed by calling the RPC
  // directly. See reassign_dial_list_buyer in supabase/schema.sql.
  const { error } = await supabase.rpc("reassign_dial_list_buyer", { p_list_id: tabId, p_buyer_id: buyerId });
  if (error) return showError(els.errorBox, error);

  archiveMenuTabId = null;
  await loadLists();
}

els.dialTabClientBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!archiveMenuTabId) return;
  openClientMenu();
});

els.dialTabClientBackBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  els.dialTabClientMenu.classList.add("hidden");
  updateArchiveMenuVisibility();
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
  // Dragged past every other tab (target === null) means "last" — insert
  // right before the "+" button rather than appendChild, since #addTabBtn
  // now lives inside #dialTabs too (see renderTabs) and is always its last
  // child; a plain appendChild would land wrap AFTER the button instead of
  // before it, visibly reordering the button on every drag-to-end.
  const insertBeforeEl = target || els.addTabBtn;
  if (wrap.nextElementSibling !== insertBeforeEl) els.dialTabs.insertBefore(wrap, insertBeforeEl);
}

function wireTabInteractions() {
  els.dialTabs.querySelectorAll(".dial-tab").forEach((btn) => {
    const id = btn.dataset.id;

    btn.addEventListener("click", () => {
      if (tabDragState.suppressClick) {
        tabDragState.suppressClick = false;
        return;
      }
      // Select mode's "Move" button puts us in moveMode, waiting for the
      // user to tap whichever tab they want the selected dials moved into —
      // intercept that tap here instead of doing a normal tab switch.
      if (selectMode && moveMode) {
        completeMoveToList(id);
        return;
      }
      // Tap/click the already-active tab -> reveal the Rename/Archive-
      // Unarchive (+ admin-only Transfer/Client) / Delete options menu,
      // in-flow between the tab bar and the dials list (see
      // updateArchiveMenuVisibility()). Used to be mobile-only
      // (isMobileViewport()) since desktop had no use for it, but
      // admin-only Transfer/Client need to be reachable on desktop too now.
      if (id === currentListId) {
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

// Every seller-side tab is sourced on behalf of a specific buyer (or
// explicitly "Not assigned to buyer") — see the "Buyer" picker required on
// both New list and Import dials. Only buyers with a CONFIRMED
// "Contract signed" Timeline event (client_events.event_type='contract_signed',
// confirmed=true) are offered, scoped the same way every other
// admin/team-lead account pool is scoped in this app: admins see every
// buyer, team leads only see buyers owned by themselves or an intern on
// their own team.
async function loadContractSignedBuyers() {
  let ownerIds = null;
  if (!isAdmin) {
    if (profile.team_id) {
      const { data: teamProfiles } = await supabase
        .from("profiles")
        .select("id")
        .eq("team_id", profile.team_id)
        .or(`role.eq.intern,id.eq.${profile.id}`);
      ownerIds = (teamProfiles || []).map((p) => p.id);
    } else {
      ownerIds = [profile.id];
    }
  }

  let query = supabase.from("clients").select("id, full_name").eq("client_type", "buyer").order("full_name", { ascending: true });
  if (ownerIds) query = query.in("created_by", ownerIds);
  const { data: buyers, error } = await query;
  if (error || !buyers?.length) return [];

  const { data: events } = await supabase
    .from("client_events")
    .select("client_id")
    .eq("event_type", "contract_signed")
    .eq("confirmed", true)
    .in("client_id", buyers.map((b) => b.id));
  const signedIds = new Set((events || []).map((e) => e.client_id));
  return buyers.filter((b) => signedIds.has(b.id));
}

async function populateBuyerSelect(selectEl) {
  selectEl.innerHTML = `<option value="">Not assigned to buyer</option>`;
  const buyers = await loadContractSignedBuyers();
  for (const b of buyers) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.full_name;
    selectEl.appendChild(opt);
  }
}

els.addTabBtn.addEventListener("click", () => {
  els.newListError.classList.add("hidden");
  els.newListNameInput.value = "";
  els.newListModal.classList.remove("hidden");
  els.newListNameInput.focus();
  populateBuyerSelect(els.newListBuyerSelect);
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
    .insert({ name, dial_type: currentType, status: currentStatus, sort_order: sortOrder, buyer_id: els.newListBuyerSelect.value || null })
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
  els.menuStatusBtn.querySelector(".menu-item-label").textContent = status === "current" ? "Current" : "Archived";
  els.menuStatusBtn.dataset.status = status;
  currentListId = null;
  persistStatus();
  renderTabs();
}

// Reflect whatever status was restored from localStorage (see
// loadPersistedDialsState()) in the menu button's label right away, without
// going through setStatus() itself — that also nulls out currentListId,
// which would throw away the just-restored tab selection. Only the label
// span's text is set (not the whole button), so the icon markup next to it
// (see dials.html) survives.
els.menuStatusBtn.querySelector(".menu-item-label").textContent = currentStatus === "current" ? "Current" : "Archived";
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
// wirePageHeaderMenu's own toggle-button click handler calls
// e.stopPropagation() (see js/pageHeaderMenu.js) so its dropdown doesn't
// immediately re-close itself via document's outside-click listener — but
// that stopPropagation also silently prevented the Archive/Rename/Delete
// popup's own document click listener (above) from ever seeing this click,
// leaving that popup open and stuck in its old position instead of closing
// like every other "click elsewhere" case. A second, direct listener on the
// same button (stopPropagation only blocks bubbling to document, not other
// listeners on this same element) closes it explicitly.
els.pageMenuToggle.addEventListener("click", closeArchiveMenu);

// Settings gear popover — used to be hidden entirely for interns since it
// only ever held the admin/team-lead-only Sellers/Buyers + Accounts visible
// controls. Now it also holds the Notifications on/off toggle (see
// wireNotificationsToggle above), which every role gets — so the gear
// button and its menu are always shown/wired; only the Sellers/Buyers and
// Accounts visible items inside it stay individually gated to admin/team
// lead.
wirePageHeaderMenu({ toggleBtn: els.pageSettingsBtn, menuEl: els.settingsMenu });
els.pageSettingsBtn.addEventListener("click", closeArchiveMenu); // see comment above
if (isAdmin || isTeamLead) {
  els.dealSideToggleBtn.classList.remove("hidden");
  wireDealSideToggle(els.dealSideToggleBtn, els.dealSideLabel, async () => {
    currentType = getDealSide();
    els.settingsMenu.classList.add("hidden");
    els.pageSettingsBtn.classList.remove("open");
    // Force renderTabs() to pick a fresh default tab for the new side
    // instead of trying to keep whatever tab id was active before (which
    // almost certainly doesn't belong to this side at all).
    currentListId = null;
    await loadLists();
  });
}

els.menuAddNewBtn.addEventListener("click", () => {
  closePageHeaderMenu();
  openCreateDialModal();
});

// ---------------------------------------------------------------------------
// Import dials from CSV (admin/team-lead — els.menuImportBtn is only
// unhidden for those roles, see the `if (isAdmin || isTeamLead)` line near
// the top of this file). Up to MAX_IMPORT_FILES CSVs at once, each becoming
// its own new tab — picked either via the native file input (multiple) or
// dragged in from the Finder/desktop onto #importDialsDropzone.
// ---------------------------------------------------------------------------
const MAX_IMPORT_FILES = 10;
let selectedImportFiles = [];

function openImportDialsModal() {
  els.importDialsError.classList.add("hidden");
  els.importDialsFileName.textContent = "";
  els.importDialsImportBtn.disabled = true;
  els.importDialsFileInput.value = "";
  selectedImportFiles = [];
  els.importDialsModal.classList.remove("hidden");
  populateBuyerSelect(els.importDialsBuyerSelect);
}

els.menuImportBtn.addEventListener("click", () => {
  closePageHeaderMenu();
  openImportDialsModal();
});
els.importDialsCancelBtn.addEventListener("click", () => els.importDialsModal.classList.add("hidden"));
// The visible "Choose CSV files" button just proxies to the real (hidden)
// file input — clicking a styled button instead of the native input
// directly gives a consistent look on both desktop (Finder) and mobile
// (Files/Photos picker), both of which open from input[type=file] the same
// way. Shared by both that input's change event AND a drag-and-drop onto
// #importDialsDropzone (see wireImportDropzone below) — either path ends up
// here with a plain array of File objects.
function setSelectedImportFiles(files) {
  const csvFiles = files.filter((f) => /\.csv$/i.test(f.name) || f.type === "text/csv");
  if (csvFiles.length > MAX_IMPORT_FILES) {
    selectedImportFiles = [];
    els.importDialsFileName.textContent = "";
    els.importDialsImportBtn.disabled = true;
    els.importDialsError.textContent = `Select ${MAX_IMPORT_FILES} CSV files or fewer at a time (${csvFiles.length} selected).`;
    els.importDialsError.classList.remove("hidden");
    return;
  }
  els.importDialsError.classList.add("hidden");
  selectedImportFiles = csvFiles;
  els.importDialsFileName.textContent = csvFiles.length
    ? `${csvFiles.length} file${csvFiles.length === 1 ? "" : "s"} selected: ${csvFiles.map((f) => f.name).join(", ")}`
    : "";
  els.importDialsImportBtn.disabled = !csvFiles.length;
}
els.importDialsChooseBtn.addEventListener("click", () => els.importDialsFileInput.click());
els.importDialsFileInput.addEventListener("change", () => {
  setSelectedImportFiles([...(els.importDialsFileInput.files || [])]);
});

// Drag-and-drop onto the dropzone — wired unconditionally (harmless on
// touch devices, which never fire drag events at all; the drop-hint text
// itself is what's actually hidden on mobile, see css/style.css). dragover
// must call preventDefault() or the browser refuses the drop entirely.
function wireImportDropzone() {
  const zone = els.importDialsDropzone;
  ["dragenter", "dragover"].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add("dragover");
    })
  );
  ["dragleave", "dragend"].forEach((evt) => zone.addEventListener(evt, () => zone.classList.remove("dragover")));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    setSelectedImportFiles([...(e.dataTransfer?.files || [])]);
  });
}
wireImportDropzone();

els.importDialsImportBtn.addEventListener("click", async () => {
  if (!selectedImportFiles.length) return;
  els.importDialsError.classList.add("hidden");
  els.importDialsImportBtn.disabled = true;

  // sort_order is computed once up front and incremented locally (rather
  // than re-reading allLists.length each iteration, which stays stale until
  // the final loadLists() below) so multiple new tabs land in file order
  // instead of every one of them competing for the same slot.
  let sortOrder = allLists.filter((l) => l.dial_type === currentType && l.status === "current").length;
  let lastNewListId = null;
  const failures = [];
  const totalAttempted = selectedImportFiles.length;

  for (const file of selectedImportFiles) {
    try {
      const text = await file.text();
      const rows = parseCSV(text).filter((r) => r.some((c) => (c || "").trim() !== ""));
      if (rows.length < 2) {
        throw new Error("no data rows to import");
      }
      // Each file's tab name is its own filename (minus .csv), always
      // created under Current — regardless of whether Current or Archived
      // happens to be selected right now — per spec.
      const tabName = file.name.replace(/\.csv$/i, "").trim() || "Imported";
      const { data: newList, error: listErr } = await supabase
        .from("dial_lists")
        .insert({ name: tabName, dial_type: currentType, status: "current", sort_order: sortOrder, buyer_id: els.importDialsBuyerSelect.value || null })
        .select()
        .single();
      if (listErr) throw listErr;
      sortOrder++;

      const dialRows = rowsToDials(rows, newList.id);
      if (!dialRows.length) {
        throw new Error("no data rows found");
      }
      const { error: insertErr } = await supabase.from("dials").insert(dialRows);
      if (insertErr) throw insertErr;

      lastNewListId = newList.id;
    } catch (err) {
      failures.push(`${file.name} (${err.message || "could not import"})`);
    }
  }

  // Land the user on the LAST tab that was actually created, switching to
  // Current first if Archived was selected so it's actually visible — even
  // a partial run (some files failed) still lands on whatever did succeed
  // rather than leaving the view on wherever it happened to be before.
  if (lastNewListId) {
    if (currentStatus !== "current") {
      currentStatus = "current";
      els.menuStatusBtn.querySelector(".menu-item-label").textContent = "Current";
      els.menuStatusBtn.dataset.status = "current";
      persistStatus();
    }
    currentListId = lastNewListId;
    persistCurrentListId();
    await loadLists();
  }

  // The selection is always cleared after an attempt, success or not —
  // re-clicking Import with the same file list would re-import whatever
  // already succeeded a second time, creating duplicate tabs.
  selectedImportFiles = [];
  els.importDialsFileInput.value = "";
  els.importDialsFileName.textContent = "";
  els.importDialsImportBtn.disabled = true;

  if (failures.length) {
    els.importDialsError.textContent = `${failures.length} of ${totalAttempted} file(s) failed — ${failures.join("; ")}. Re-select just those to try again.`;
    els.importDialsError.classList.remove("hidden");
    els.importDialsImportBtn.disabled = false;
  } else {
    els.importDialsModal.classList.add("hidden");
  }
});

// ---------------------------------------------------------------------------
// Select mode — bulk-select dials in the current tab for mass email/text,
// moving to another tab, or deleting. See the module-level selectMode/
// moveMode/selectedDialIds declared near the top of this file, and the
// selectMode branch inside renderDialsTable() for the selection-circle UI.
// ---------------------------------------------------------------------------

function enterSelectMode() {
  selectMode = true;
  moveMode = false;
  selectedDialIds = new Set();
  els.selectModeBar.classList.remove("hidden");
  els.selectMoveHint.classList.add("hidden");
  els.selectMoveBtn.classList.remove("active");
  renderDialsTable();
}

function exitSelectMode() {
  selectMode = false;
  moveMode = false;
  selectedDialIds = new Set();
  els.selectModeBar.classList.add("hidden");
  els.selectMoveHint.classList.add("hidden");
  els.selectMoveBtn.classList.remove("active");
  renderDialsTable();
}

function toggleDialSelection(id) {
  if (selectedDialIds.has(id)) selectedDialIds.delete(id);
  else selectedDialIds.add(id);
  renderDialsTable();
}

els.menuSelectBtn.addEventListener("click", (e) => {
  // Without this, the very same click bubbles up to the document-level
  // "tap outside exits select mode" listener below (added the instant
  // enterSelectMode() runs) and immediately exits the mode it just entered.
  e.stopPropagation();
  closePageHeaderMenu();
  enterSelectMode();
});

els.selectBackBtn.addEventListener("click", (e) => {
  // Without this, the very same click bubbles up to the document-level
  // "tap outside exits page header menu" listener (added the instant the
  // synthetic pageMenuToggle.click() below opens it) and immediately closes
  // it again — same pitfall as menuSelectBtn's own handler above.
  e.stopPropagation();
  // Mid-move, "Back" just backs out of moveMode and returns to the regular
  // select-mode toolbar (selections are kept) — otherwise it exits select
  // mode entirely AND reopens the triangle dropdown (Add new/Select/etc.)
  // right where it left off, instead of leaving the header with nothing open.
  if (moveMode) {
    moveMode = false;
    els.selectMoveHint.classList.add("hidden");
    els.selectMoveBtn.classList.remove("active");
    return;
  }
  exitSelectMode();
  els.pageMenuToggle.click();
});

els.selectAllBtn.addEventListener("click", () => {
  const visible = visibleDials();
  if (!visible.length) return;
  const allSelected = visible.every((d) => selectedDialIds.has(d.id));
  if (allSelected) {
    visible.forEach((d) => selectedDialIds.delete(d.id));
  } else {
    visible.forEach((d) => selectedDialIds.add(d.id));
  }
  renderDialsTable();
});

// Shared by Mass email / Mass text — kind is "email" or "phone". Warns first
// if any selected dial is missing that contact method, then (if continuing)
// only includes the dials that actually have it.
function handleMassContact(kind) {
  const selected = dials.filter((d) => selectedDialIds.has(d.id));
  if (!selected.length) return;
  const withInfo = selected.filter((d) => (kind === "email" ? !!d.email : !!d.mobile_phone));
  const missingCount = selected.length - withInfo.length;

  const proceed = () => {
    if (!withInfo.length) return;
    if (kind === "email") {
      window.location.href = `mailto:${withInfo.map((d) => d.email).join(",")}`;
    } else {
      const numbers = withInfo.map((d) => d.mobile_phone).join(",");
      window.location.href = `sms:${numbers}`;
    }
  };

  if (missingCount > 0) {
    const noun = kind === "email" ? "an email" : "a mobile number";
    els.massContactWarningTitle.textContent = `Some dials are missing ${noun}`;
    els.massContactWarningText.textContent = `${missingCount} of the ${selected.length} selected dial${selected.length === 1 ? "" : "s"} ${
      missingCount === 1 ? "doesn't" : "don't"
    } have ${noun} on file. Continuing will only ${kind === "email" ? "email" : "text"} the ${withInfo.length} that ${withInfo.length === 1 ? "does" : "do"}.`;
    els.massContactWarningModal.classList.remove("hidden");
    const cleanup = () => {
      els.massContactWarningModal.classList.add("hidden");
      els.massContactWarningContinueBtn.removeEventListener("click", onContinue);
      els.massContactWarningCancelBtn.removeEventListener("click", onCancel);
    };
    const onContinue = () => {
      cleanup();
      proceed();
    };
    const onCancel = () => cleanup();
    els.massContactWarningContinueBtn.addEventListener("click", onContinue);
    els.massContactWarningCancelBtn.addEventListener("click", onCancel);
  } else {
    proceed();
  }
}

els.selectMassEmailBtn.addEventListener("click", () => handleMassContact("email"));
els.selectMassTextBtn.addEventListener("click", () => handleMassContact("phone"));

els.selectMoveBtn.addEventListener("click", () => {
  if (!selectedDialIds.size) return;
  moveMode = true;
  els.selectMoveBtn.classList.add("active");
  els.selectMoveHint.classList.remove("hidden");
});

// Called from wireTabInteractions' tab click handler once moveMode is active
// and the user taps the destination tab.
async function completeMoveToList(listId) {
  const ids = [...selectedDialIds];
  if (!ids.length) {
    exitSelectMode();
    return;
  }
  const { error } = await supabase.from("dials").update({ list_id: listId }).in("id", ids);
  if (error) {
    showError(els.errorBox, error);
    return;
  }
  exitSelectMode();
  currentListId = listId;
  persistCurrentListId();
  await loadLists();
}

els.selectDeleteBtn.addEventListener("click", () => {
  const count = selectedDialIds.size;
  if (!count) return;
  els.confirmBulkDeleteTitle.textContent = `Delete ${count} dial${count === 1 ? "" : "s"}?`;
  openConfirmModal(els.confirmBulkDeleteModal, "confirmBulkDeleteYesBtn", "confirmBulkDeleteNoBtn", async () => {
    const ids = [...selectedDialIds];
    const { error } = await supabase.from("dials").delete().in("id", ids);
    if (error) return showError(els.errorBox, error);
    exitSelectMode();
    await loadDials();
  });
});

// Tapping anywhere outside the select-mode-bar and outside the dials list
// itself exits select mode (per spec). Clicks inside any modal (the bulk
// delete confirm, the mass-contact warning, or any other popup) are exempt —
// those manage their own dismissal and shouldn't also tear down select mode
// underneath them. A tab tap while moveMode is active is also exempt — that's
// handled by wireTabInteractions' click handler (completeMoveToList), which
// itself calls exitSelectMode() when it's done.
document.addEventListener("click", (e) => {
  if (!selectMode) return;
  if (e.target.closest(".modal-backdrop")) return;
  if (els.selectModeBar.contains(e.target)) return;
  if (els.dialsTableWrap.contains(e.target)) return;
  if (moveMode && e.target.closest(".dial-tab")) return;
  exitSelectMode();
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
  const cacheKey = "dials_" + currentListId;
  const { data, error } = await supabase.from("dials").select("*").eq("list_id", currentListId);
  if (error) {
    if (!isNetworkError(error)) return showError(els.errorBox, error);
    const cached = cacheGet(cacheKey);
    if (!cached) return showOfflineNotice(false);
    dials = cached;
    showOfflineNotice(true);
    renderDialsTable();
    return;
  }
  hideOfflineNotice();
  // Alphabetical A-Z by name (case/locale-insensitive) rather than
  // import/creation order.
  dials = (data || []).slice().sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", undefined, { sensitivity: "base" }));
  cacheSet(cacheKey, dials);
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

  // While select mode is active, instant-contact icons are replaced by a
  // plain selection circle (highlighted when that dial is selected), and a
  // matching empty header cell is added to the desktop table so the columns
  // still line up.
  const selectCircleHTML = (d) => `<div class="select-circle ${selectedDialIds.has(d.id) ? "selected" : ""}"></div>`;

  els.dialsTableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          ${selectMode ? "<th></th>" : ""}
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
            ${selectMode ? `<td>${selectCircleHTML(d)}</td>` : ""}
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
         icons using the mobile number only (never the company number) — or,
         in select mode, a selection circle in their place. -->
    <div class="mobile-list">
      ${visible
        .map(
          (d, i) => `
        <div class="mobile-card clickable-row" data-index="${i}" style="background:${statusInfo(d.contact_status).bg}; border-color:${statusInfo(d.contact_status).border};">
          <div class="mc-main">
            <div class="mc-name">${escapeHtml(dialDisplayName(d))}</div>
            <div class="mc-sub">${escapeHtml(dialCompanyAndLocation(d))}</div>
          </div>
          ${selectMode ? selectCircleHTML(d) : contactActionIcons({ phone: d.mobile_phone || d.company_phone, email: d.email, linkedin: d.linkedin })}
        </div>`
        )
        .join("")}
    </div>
  `;
  els.dialsTableWrap.querySelectorAll("[data-index]").forEach((row) => {
    const idx = Number(row.dataset.index);
    const d = visible[idx];
    row.addEventListener("click", (e) => {
      if (selectMode) {
        // toggleDialSelection() re-renders the whole list, which detaches
        // this row/its children from the document — if this click were
        // allowed to keep bubbling after that, the document-level "tap
        // outside exits select mode" listener would see e.target as no
        // longer inside els.dialsTableWrap (it's now an orphaned node) and
        // incorrectly exit select mode on every single selection tap.
        e.stopPropagation();
        toggleDialSelection(d.id);
        return;
      }
      openDialModal(idx);
    });
  });
  if (!selectMode) stopContactActionPropagation(els.dialsTableWrap);

  if (selectMode) {
    els.selectAllBtn.classList.toggle("active", visible.every((d) => selectedDialIds.has(d.id)));
  }
}

// ---------------------------------------------------------------------------
// Dial detail / create popup
// ---------------------------------------------------------------------------

// Company name / Industry sector / Website are seller-only fields on a dial
// (currentType — the active Sellers/Buyers toggle, see js/dealSide.js) — for
// buyer dials, hiding these boxes entirely (view, edit form, and validation
// below) means a client created from a buyer dial never picks up stray
// company data that doesn't apply to buyers (see clientForm.js's buyer
// branch, which has no company fields at all).
function buildDialViewHTML(dial) {
  const isBuyer = currentType === "buyer";
  return `
    ${rfContact("Email", dial.email, "email", contactCheckCircleHTML("email", dial))}
    ${buildPhoneNumbersHTML(dial, (kind) => contactCheckCircleHTML(kind, dial))}
    ${rfWebsite("LinkedIn", dial.linkedin)}
    ${isBuyer ? "" : rfWebsite("Website", dial.website)}
    ${isBuyer ? "" : rf("Industry sector", dial.industry)}
    ${rf("Summary", dial.summary)}
    ${buildCallNotesLiveHTML(dial)}
  `;
}

function buildDialEditHTML(dial) {
  const isBuyer = currentType === "buyer";
  return `
    <label for="d_full_name">Full name</label>
    <input id="d_full_name" value="${escapeHtml(dial.full_name)}" />
    ${isBuyer ? "" : `<label for="d_company_name">Company name</label><input id="d_company_name" value="${escapeHtml(dial.company_name)}" />`}
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
    ${isBuyer ? "" : `<label for="d_website">Website</label><input id="d_website" value="${escapeHtml(dial.website)}" />`}
    ${isBuyer ? "" : `<label for="d_industry">Industry sector</label><input id="d_industry" value="${escapeHtml(dial.industry)}" />`}
    <label for="d_summary">Summary</label>
    <textarea id="d_summary">${escapeHtml(dial.summary || "")}</textarea>
  `;
}

function collectDialFormData() {
  // Note: call_notes is intentionally NOT collected here — it's edited
  // directly in display mode (autosaves on blur, see wireCallNotesAutosave)
  // and is not part of the edit form, so leaving it out of this object means
  // saving other fields never touches/overwrites it.
  const isBuyer = currentType === "buyer";
  const data = {
    full_name: document.getElementById("d_full_name").value.trim() || null,
    city: document.getElementById("d_city").value.trim() || null,
    state: document.getElementById("d_state").value || null,
    email: document.getElementById("d_email").value.trim() || null,
    mobile_phone: document.getElementById("d_mobile_phone").value.trim() || null,
    company_phone: document.getElementById("d_company_phone").value.trim() || null,
    linkedin: document.getElementById("d_linkedin").value.trim() || null,
    summary: document.getElementById("d_summary").value.trim() || null,
    // Company name / Industry / Website boxes don't exist in the edit form
    // at all for buyer dials (see buildDialEditHTML) — explicitly null them
    // out rather than reading nonexistent DOM elements.
    industry: isBuyer ? null : document.getElementById("d_industry").value.trim() || null,
    company_name: isBuyer ? null : document.getElementById("d_company_name").value.trim() || null,
    website: isBuyer ? null : document.getElementById("d_website").value.trim() || null,
  };
  return data;
}

function renderDialModal() {
  const isCreate = dialMode === "create";
  const dial = isCreate ? emptyDial() : currentDial;
  const isViewingExisting = !isCreate && dialMode === "view";

  const subtitleHTML = isCreate ? "" : dialSubtitleHTML(currentDial);

  // Header (title/subtitle/status/close) and the edit-button row below it
  // are fully rebuilt every render — they depend on which dial and mode is
  // active — then re-wired, same pattern as the body/actions below. Both
  // rows are nested inside a shared right-aligned column
  // (.dial-modal-header-right) rather than being independent flex rows
  // stacked by plain document flow — that's what keeps the gap between them
  // small and constant (set by the column's own `gap`) instead of being
  // dictated by whatever height the (often two-line, wrapping) name/subtitle
  // block on the left happens to need.
  //
  // Top row: the status/"Categories" dropdown, then the close (x). Row
  // below: normally the "Contacted today xN" display (see
  // buildContactedTodayDisplayHTML) next to Edit; when the category is
  // "Accepted intro call" (intro_call_scheduled), "Schedule intro call"
  // takes that slot instead and the Contacted-today display renders
  // directly underneath IT (see .dial-schedule-intro-col in css/style.css)
  // rather than under the row as a whole — so its right edge lines up with
  // Schedule-intro-call's right edge specifically, not Edit's.
  const isIntroScheduled = dial.contact_status === "intro_call_scheduled";
  // Hidden again once used for THIS arrival at the category — see
  // openIntroCallTimeConfirmModal's success path, which sets
  // dial._scheduleIntroCallUsed, and updateDialStatus, which resets it back
  // to false only on a genuine fresh switch INTO "Accepted intro call" (so
  // switching to a different category and back re-shows the button).
  // Ephemeral/in-memory only — resets on page reload, same as
  // hiddenStatuses elsewhere in this file.
  const showScheduleIntroBtn = isIntroScheduled && !dial._scheduleIntroCallUsed;
  els.dialModalHeader.innerHTML = `
    <div class="dial-modal-header">
      <div class="dial-modal-header-main">
        <h2>${escapeHtml(isCreate ? "New dial" : dialDisplayName(currentDial))}</h2>
        ${subtitleHTML ? `<div class="dial-modal-subtitle">${subtitleHTML}</div>` : ""}
      </div>
      <div class="dial-modal-header-right">
        <div class="dial-modal-header-actions">
          ${
            isViewingExisting
              ? `
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
          `
              : ""
          }
          <button type="button" class="fs-close" id="dialModalClose">&times;</button>
        </div>
        ${
          isViewingExisting
            ? `
        <div class="dial-modal-editrow">
          ${
            showScheduleIntroBtn
              ? `
          <div class="dial-schedule-intro-col">
            <button type="button" class="dial-schedule-intro-btn" id="scheduleIntroCallFromDialBtn">Schedule intro call</button>
            ${buildContactedTodayDisplayHTML(dial)}
          </div>
          `
              : buildContactedTodayDisplayHTML(dial)
          }
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
    if (showScheduleIntroBtn) {
      document.getElementById("scheduleIntroCallFromDialBtn").addEventListener("click", () => handleScheduleIntroCallFromDial(currentDial));
    }
    document.getElementById("dialEditBtn").addEventListener("click", async () => {
      // Flush any just-typed call notes before the view-mode notes textarea
      // gets torn down for the edit form — otherwise a race between this
      // render and an in-flight blur save could show/save stale notes (see
      // flushCallNotes).
      await flushCallNotes();
      dialMode = "edit";
      renderDialModal();
    });
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
  if (isViewingExisting) wireContactCheckCircles();

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
  // See syncTodaysCallLogSnapshot's comment — these are the same snapshot
  // fields commitContactCheck() captures, kept in sync if they're corrected
  // through the edit form later the same day a call was already logged.
  await syncTodaysCallLogSnapshot({
    company_name: data.company_name,
    contact_name: data.full_name,
    website: data.website,
    city: data.city,
    state: data.state,
    industry: data.industry,
  });
  dialMode = "view";
  renderDialModal();
  await loadDials();
}

// Sets the dial's quick call-outcome status. Not part of the edit form —
// this is a standalone dropdown in the popup's header row that autosaves
// immediately, same pattern as the Call notes autosave. Changing this no
// longer affects the weekly call count — that's the separate per-contact-
// method check circles (see toggleContactCheck).
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
  // A fresh arrival at "Accepted intro call" (switching in from some other
  // category — not just re-saving while already sitting in it) re-shows the
  // "Schedule intro call" button if a previous use had hidden it — see
  // renderDialModal's showScheduleIntroBtn and the success path in
  // openIntroCallTimeConfirmModal, which is what sets this flag true.
  const wasAlreadyIntroScheduled = currentDial.contact_status === "intro_call_scheduled";
  const data = { contact_status: newStatus };
  const { error } = await supabase.from("dials").update(data).eq("id", currentDial.id);
  if (error) return showError(els.dialModalError, error);
  Object.assign(currentDial, data);
  if (newStatus === "intro_call_scheduled" && !wasAlreadyIntroScheduled) {
    currentDial._scheduleIntroCallUsed = false;
  }
  const idx = dials.findIndex((d) => d.id === currentDial.id);
  if (idx !== -1) Object.assign(dials[idx], data);
  await syncTodaysCallLogSnapshot({ contact_status_at_call: newStatus });

  renderDialModal();
  renderDialsTable();
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
  // Block swipe/prev/next/arrow-keys entirely while the Call notes textarea
  // is actively focused — previously this just auto-flushed (saved) whatever
  // was typed and navigated straight through, which felt like it swallowed
  // edits out from under you mid-thought. Now you have to actually finish
  // editing (blur/click away) before navigation works again; flushCallNotes
  // below still exists for the moment right after that blur, in case a save
  // is still in flight when a swipe/arrow-key follows immediately after.
  const notesEl = document.getElementById("d_call_notes_live");
  if (notesEl && document.activeElement === notesEl) return;
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
// such field. Company name / Industry sector are seller-only boxes (see
// buildDialEditHTML) — never required for a buyer dial, since they're never
// even shown/collected for one.
function getMissingDialClientFields(dial) {
  const missing = [];
  const labels = [];
  const isBuyer = currentType === "buyer";

  if (!dial.full_name) { missing.push("full_name"); labels.push("Name"); }

  if (!isBuyer && !dial.company_name) { missing.push("company_name"); labels.push("Company name"); }

  if (!dial.email && !dial.mobile_phone && !dial.company_phone) {
    missing.push("contact");
    labels.push("Phone number and/or email");
  }

  let locMissing = false;
  if (!dial.city) { missing.push("city"); locMissing = true; }
  if (!dial.state) { missing.push("state"); locMissing = true; }
  if (locMissing) labels.push("Location");

  if (!isBuyer && !dial.industry) { missing.push("industry"); labels.push("Industry sector"); }

  return { missing, labels };
}

// Clicking "Schedule Intro Call" only validates the dial has enough info and
// opens the Calendly form — it does NOT create the client yet, and neither
// does opening Calendly or booking a time in it. The client record is only
// actually inserted once the date/time/timezone confirmation step right
// after Calendly closes is itself confirmed (see createClientFromDial/
// openIntroCallTimeConfirmModal below), bundled together with logging that
// new client's very first Timeline entry — so nothing about the client
// exists in the database until that one step finishes, and backing out
// anywhere before it never leaves behind an orphaned client with no intro
// call attached. Calendly itself is pre-filled straight from the dial's own
// name/email (see the `prefill` opt) rather than from a client row that
// doesn't exist yet.
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
    profile,
    prefill: { full_name: dial.full_name || "", email: dial.email || "", client_type: currentType },
    onCalendlyClosed: async () => {
      els.introCallPopup.classList.add("hidden");
      openIntroCallTimeConfirmModal(dial);
    },
  });
}

// Builds the new client record from a dial's info — split out of
// handleScheduleIntroCallFromDial above so openIntroCallTimeConfirmModal can
// call it itself once the real scheduled date/time/timezone is known,
// instead of this running the moment Calendly opens (see that function's own
// top comment for why the client is deliberately created this late).
async function createClientFromDial(dial) {
  // Idempotency guard: openIntroCallTimeConfirmModal's own createdClient
  // variable only protects against a double-click within ONE still-open
  // modal — it resets on a page reload, or on simply reopening "Schedule
  // intro call" again after an earlier attempt got a client created but
  // then failed on the follow-up Timeline event insert (a real, confirmed
  // gap: nothing in the database itself prevented a second client for the
  // same dial). source_dial_id (see clients table) is the durable version
  // of that same check — if a client already exists for this dial, reuse
  // it instead of creating another.
  const { data: existing } = await supabase.from("clients").select().eq("source_dial_id", dial.id).maybeSingle();
  if (existing) return existing;

  // client_type must match whichever side (Sellers/Buyers toggle) this
  // dial actually belongs to — defaultClient()'s own default is "seller",
  // which used to apply even from a buyer dial since nothing here ever
  // overrode it. Company name / Industry never transfer for a buyer dial
  // since they're never collected on one in the first place (see
  // buildDialEditHTML/getMissingDialClientFields above) — clean, since
  // clientForm.js's buyer branch has no company fields at all.
  const isBuyer = currentType === "buyer";
  const data = defaultClient(profile, {
    client_type: currentType,
    full_name: dial.full_name || "",
    city: dial.city || "",
    state: dial.state || "",
    email: dial.email || "",
    // Both numbers transfer over as their own fields now (mobile stays the
    // one used for instant call/text everywhere else in the app).
    mobile_phone: dial.mobile_phone || "",
    company_phone: dial.company_phone || "",
    linkedin: dial.linkedin || "",
    ...(isBuyer ? {} : { company_name: dial.company_name || "", industry: dial.industry || "" }),
    // Call notes from the dial transfer straight into the new client's
    // Other notes field.
    other_notes: dial.call_notes || "",
  });
  data.assigned_to = profile.id;
  // Which dial list this seller client was sourced from — a permanent,
  // FK-less snapshot (see the matching comment in commitContactCheck())
  // so it survives the tab later being deleted. Prospective-only: this
  // is the one and only place a client's origin gets captured, so
  // clients created before this existed have no way to backfill it.
  // Lets "Intro calls completed" be attributed to the buyer the tab was
  // assigned to (dial_lists.buyer_id), not just to whoever's account
  // owns the resulting client.
  data.source_list_id = dial.list_id || null;
  // Explicit at creation time rather than relying solely on the
  // source_list_id -> dial_lists.buyer_id fallback every reporting RPC
  // uses (coalesce(c.intended_buyer_id, dl.buyer_id)) — that fallback
  // silently breaks if the tab is later deleted or reassigned, and (real
  // bug found in production) some clients never even got source_list_id
  // populated in the first place (bulk-created outside this flow), so
  // they never resolved to any buyer at all. Setting it here makes the
  // attribution permanent and independent of the tab's own fate.
  data.intended_buyer_id = (isBuyer ? null : allLists.find((l) => l.id === dial.list_id)?.buyer_id) || null;
  // Sellers have no website field of their own to fall back on
  // otherwise — captured here for the same "buyer-centric business-
  // owner tables" reason as source_list_id above (see js/reports.js).
  data.website = dial.website || null;
  data.source_dial_id = dial.id;

  const { data: inserted, error } = await supabase.from("clients").insert(data).select().single();
  if (error) {
    // 23505 = unique_violation on clients_source_dial_id_unique — lost a
    // race against another concurrent attempt for this same dial (the
    // `existing` check above already covers the common sequential case;
    // this covers two attempts landing at nearly the same instant). Either
    // way, someone already created it — use that one instead of failing.
    if (error.code === "23505") {
      const { data: raceWinner } = await supabase.from("clients").select().eq("source_dial_id", dial.id).maybeSingle();
      if (raceWinner) return raceWinner;
    }
    throw error;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Shown right after the Calendly popup auto-closes on a confirmed booking
// (see handleScheduleIntroCallFromDial's onCalendlyClosed above). Calendly's
// own postMessage never exposes the actual chosen start time (a platform
// limitation — see the comment at the top of js/introCall.js), so this asks
// for it directly instead of guessing "now" — and this is also where the new
// client record itself finally gets created (see createClientFromDial),
// bundled together with logging that client's very first Timeline entry, in
// one step. Nothing about this client exists in the database until this
// modal is actually confirmed. No cancel option — the booking is already
// made in Calendly regardless, so backing out here (there's nothing to
// "undo") just means reopening this dial's "Schedule intro call" again later
// to finish recording it.
function openIntroCallTimeConfirmModal(dial) {
  const modal = els.introCallTimeModal;
  const dateInput = els.introCallTimeDateInput;
  const timeSelect = els.introCallTimeSelect;
  const tzSelect = els.introCallTimeZoneSelect;
  const errEl = els.introCallTimeError;
  const confirmBtn = els.introCallTimeConfirmBtn;

  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  dateInput.value = today.toISOString().slice(0, 10);
  timeSelect.innerHTML = timeOptionsHTML("", { includeNoTime: false });
  tzSelect.innerHTML = timezoneOptionsHTML(defaultTimezone());
  errEl.classList.add("hidden");

  modal.classList.remove("hidden");

  // Set once the client is actually created below — kept outside
  // onConfirmClick's own scope (rather than a local const inside it) so
  // that if the client_events insert fails after a successful client
  // creation, clicking Save again to retry doesn't create a SECOND client
  // for the same dial.
  let createdClient = null;

  const onConfirmClick = async () => {
    const val = dateInput.value;
    const time = timeSelect.value;
    const timezone = tzSelect.value;
    if (!val || !time) {
      errEl.textContent = "Please enter both a date and time.";
      errEl.classList.remove("hidden");
      return;
    }
    confirmBtn.disabled = true;
    errEl.classList.add("hidden");
    try {
      if (!createdClient) {
        createdClient = await createClientFromDial(dial);
      }
      const eventDate = zonedTimeToUtcIso(val, time, timezone);
      const { error } = await supabase.from("client_events").insert({
        client_id: createdClient.id,
        event_type: "intro_call",
        event_date: eventDate,
        details: { via: "calendly", time, timezone },
        created_by: profile.id,
      });
      if (error) throw error;
    } catch (err) {
      errEl.textContent = err.message || String(err);
      errEl.classList.remove("hidden");
      confirmBtn.disabled = false;
      return;
    }
    confirmBtn.disabled = false;
    // Hides "Schedule intro call" on this dial again now that it's been
    // used — see renderDialModal's showScheduleIntroBtn, which reads this
    // same flag. Only a fresh arrival at "Accepted intro call" (see
    // updateDialStatus) resets it back to false, so switching to a
    // different category and back re-shows the button.
    dial._scheduleIntroCallUsed = true;
    renderDialModal();
    cleanup();
  };
  const cleanup = () => {
    modal.classList.add("hidden");
    confirmBtn.removeEventListener("click", onConfirmClick);
  };
  confirmBtn.addEventListener("click", onConfirmClick);
}

els.requiredPopupOk.addEventListener("click", () => els.requiredPopup.classList.add("hidden"));

// ---------------------------------------------------------------------------
// "Categories" (formerly the palette/dot filter button) — hides/shows dials
// by status across every list/tab. In-memory only (hiddenStatuses), so it
// resets on reload. Now a submenu of colored rectangles + labels, opened
// from the page-header triangle menu's "Categories" item.
// ---------------------------------------------------------------------------

// Small standalone checkmark icon for the "Select all" row below — matching
// the same checkmark used by Clients' analogous Categories submenu (see
// CHECK_SVG in js/clients.js), just kept local here since dials.js doesn't
// otherwise need one.
const SELECT_ALL_CHECK_SVG = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

function renderCategoriesSubmenu() {
  // "Select all" sits above the individual categories as a master toggle —
  // same select-all/deselect-all-on-second-press pattern as the Accounts
  // visible popup's own Select all row (see js/accountsVisible.js). "All
  // selected" here means nothing is currently hidden.
  const allCategoriesSelected = hiddenStatuses.size === 0;
  const selectAllHTML = `
      <button type="button" class="category-rect-option select-all-option ${allCategoriesSelected ? "is-selected" : ""}" data-select-all="1">
        <span class="category-rect-swatch progress-check-swatch">${allCategoriesSelected ? SELECT_ALL_CHECK_SVG : ""}</span>Select all
      </button>`;
  els.categoriesSubmenu.innerHTML =
    selectAllHTML +
    CONTACT_STATUSES.map(
      (s) => `
      <button type="button" class="category-rect-option ${hiddenStatuses.has(s.value) ? "is-hidden" : ""}" data-value="${s.value}">
        <span class="category-rect-swatch" style="background:${s.dot}; border-color:${s.border};"></span>${escapeHtml(s.label)}
      </button>`
    ).join("");
  els.categoriesSubmenu.querySelector("[data-select-all]").addEventListener("click", (e) => {
    e.stopPropagation();
    // Pressing it again once everything is selected hides every category
    // instead of being a no-op; otherwise (partial or none selected) it
    // shows everything, same select-all/deselect-all-on-second-press pattern
    // as Accounts visible's own Select all row.
    if (hiddenStatuses.size === 0) {
      CONTACT_STATUSES.forEach((s) => hiddenStatuses.add(s.value));
    } else {
      hiddenStatuses.clear();
    }
    persistHiddenStatuses();
    renderCategoriesSubmenu();
    renderDialsTable();
  });
  els.categoriesSubmenu.querySelectorAll(".category-rect-option[data-value]").forEach((btn) => {
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

// ---------------------------------------------------------------------------
// Admin-only "Accounts visible" filter — shared module (js/accountsVisible.js)
// with the Clients/Profile pages. Lets an admin narrow the Dials tab bar down
// to only tabs created by whichever accounts they've selected, on top of the
// existing Sellers/Buyers + Current/Archived + Categories filtering.
// Requires dial_lists_select_own/dials_select_own to also allow is_admin()
// (see supabase/schema.sql) — otherwise the admin's own session could never
// fetch other accounts' tabs in the first place, filter or no filter.
// ---------------------------------------------------------------------------

if (isAdmin || isTeamLead) {
  wireAccountsVisiblePopup({
    menuBtn: els.menuAccountsVisibleBtn,
    popupEl: els.accountsVisiblePopup,
    bodyEl: els.accountsVisibleBody,
    closeBtn: els.accountsVisibleClose,
    closePageHeaderMenu: closePageHeaderMenu,
    myProfileId: profile.id,
    getAllAccounts: async () => {
      // Admins see everyone. A team lead only ever sees themselves plus the
      // interns on their own team (same team_id, role = intern) — never an
      // admin or another team lead who happens to share that team_id, and
      // never every account. Requires dial_lists_select_own/dials_select_own
      // to also allow is_team_lead_of() (now intern-only, see
      // supabase/schema.sql), otherwise a team lead's session could never
      // fetch a teammate's tabs/dials in the first place, filter or no filter.
      if (isAdmin) {
        const { data, error } = await supabase.from("profiles").select("id, full_name, role, team_id").order("full_name", { ascending: true });
        return error ? [] : data || [];
      }
      if (!profile.team_id) return [profile];
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("team_id", profile.team_id)
        .or(`role.eq.intern,id.eq.${profile.id}`)
        .order("full_name", { ascending: true });
      return error ? [] : data || [];
    },
    // Admin-only — groups the popup's account list under team section
    // labels (same real teams shown in the Teams popup) so an admin with
    // many accounts can tell them apart at a glance, rather than one long
    // alphabetical list. Team leads' own pool is already just themselves +
    // their interns, so grouping isn't offered there.
    getTeams: isAdmin
      ? async () => {
          const { data, error } = await supabase.from("teams").select("id, name").order("sort_order", { ascending: true });
          return error ? [] : data || [];
        }
      : undefined,
    onChange: renderTabs,
    escapeHtml,
  });
}

await loadLists();
