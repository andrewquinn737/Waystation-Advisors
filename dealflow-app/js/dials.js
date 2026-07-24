import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";
import { STATES, escapeHtml, defaultClient } from "./clientForm.js";
import { buildIntroCallFormHTML, wireIntroCallForm } from "./introCall.js";
import { rfContact, contactActionIcons, stopContactActionPropagation, locationPinLink, buildPhoneNumbersHTML } from "./contactIcons.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus as closePageHeaderMenu } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { getDealSide, wireDealSideToggle } from "./dealSide.js";
import { getVisibleAccountIds, wireAccountsVisiblePopup, initDefaultToSelf } from "./accountsVisible.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile, user } = session;
const internEmail = user?.email || "";
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
  { value: "intro_call_scheduled", label: "Intro call scheduled", bg: "var(--status-scheduled-bg)", border: "var(--status-scheduled-border)", dot: "var(--status-scheduled-dot)" },
];
function statusInfo(value) {
  return CONTACT_STATUSES.find((s) => s.value === value) || CONTACT_STATUSES[0];
}

// "Called today" only makes sense for statuses that still represent an
// active, in-progress prospect — white (uncontacted), orange (no response,
// try again), and yellow (callback, interested). It's hidden for green
// (intro call scheduled), red (not interested), and gray (unable to
// contact), where logging "called today" doesn't add anything.
const SHOW_CALLED_TODAY_STATUSES = new Set(["uncontacted", "no_response", "callback_interested"]);

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
  dialsProspectCount: document.getElementById("dialsProspectCount"),
  dialTabs: document.getElementById("dialTabs"),
  dialTabArchiveMenu: document.getElementById("dialTabArchiveMenu"),
  dialTabRenameBtn: document.getElementById("dialTabRenameBtn"),
  dialTabArchiveBtn: document.getElementById("dialTabArchiveBtn"),
  dialTabTransferBtn: document.getElementById("dialTabTransferBtn"),
  dialTabTransferMenu: document.getElementById("dialTabTransferMenu"),
  dialTabTransferList: document.getElementById("dialTabTransferList"),
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
  importDialsModal: document.getElementById("importDialsModal"),
  importDialsError: document.getElementById("importDialsError"),
  importDialsFileInput: document.getElementById("importDialsFileInput"),
  importDialsChooseBtn: document.getElementById("importDialsChooseBtn"),
  importDialsFileName: document.getElementById("importDialsFileName"),
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

// Transfer stays strictly admin-only. CSV import is now also available to
// team leads (see isTeamLead comment above) — only Transfer remains gated to
// isAdmin alone.
if (isAdmin || isTeamLead) els.menuImportBtn.classList.remove("hidden");
if (isAdmin) els.dialTabTransferBtn.classList.remove("hidden");
if (isAdmin || isTeamLead) els.menuAccountsVisibleBtn.classList.remove("hidden");

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
            // grouped under "Intro call scheduled" rather than falling all
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

// Same, one calendar day ahead — used only to set status_hide_effective_date
// on a category change into a hide-Called-today status (see
// updateDialStatus/isCalledTodayVisible below), so the button doesn't
// actually disappear until the NEXT local day rather than the instant you
// pick one of those 3 categories.
function tomorrowDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Whether the "Called today" button should currently show for this dial —
// always true for the 3 "active prospect" statuses (SHOW_CALLED_TODAY_STATUSES),
// and ALSO true for the other 3 ("Not interested", "Unable to contact",
// "Intro call scheduled") until status_hide_effective_date (set by
// updateDialStatus whenever you switch INTO one of those 3) actually
// arrives — so switching categories throughout the day never hides it
// mid-day; it only hides starting the next day for whichever of those 3
// categories the dial is still sitting in at that point. A dial with no
// recorded date at all was already sitting in a hide category before this
// column existed, so that's treated the same as "already effective"
// (hidden) rather than suddenly reappearing for old data.
function isCalledTodayVisible(dial) {
  const status = dial.contact_status || "uncontacted";
  if (SHOW_CALLED_TODAY_STATUSES.has(status)) return true;
  if (!dial.status_hide_effective_date) return false;
  return dial.status_hide_effective_date > todayDateStr();
}

// One row of a phone number with its "(Mobile)"/"(Company)" label + instant
// buildPhoneNumbersHTML (the "Phone numbers" Mobile/Company display block)
// now lives in contactIcons.js, shared with clients.js.

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
  updateArchiveMenuPosition();
  loadDials();
}

// The Archive/Unarchive popup lives outside .dials-tabbar (see dials.html)
// and is positioned via JS as position:fixed, right under whichever tab is
// currently active — see the big comment above wireTabInteractions() for why
// it can't just be absolutely-positioned inside the tab itself. Available on
// both mobile (tap the already-active tab) and desktop (click it) — see the
// tab click handler in wireTabInteractions(), which no longer gates this
// behind isMobileViewport() now that admin-only Transfer needs it on desktop
// too.
function updateArchiveMenuPosition() {
  if (!archiveMenuTabId || archiveMenuTabId !== currentListId) {
    els.dialTabArchiveMenu.classList.add("hidden");
    els.dialTabTransferMenu.classList.add("hidden");
    return;
  }
  const activeBtn = els.dialTabs.querySelector(".dial-tab.active");
  if (!activeBtn) {
    els.dialTabArchiveMenu.classList.add("hidden");
    els.dialTabTransferMenu.classList.add("hidden");
    return;
  }
  const rect = activeBtn.getBoundingClientRect();
  els.dialTabArchiveBtn.textContent = currentStatus === "current" ? "Archive" : "Unarchive";
  // Recomputed fresh from the tab's CURRENT on-screen position every time
  // this runs (getBoundingClientRect(), not a cached value) — so it's
  // always directly below whichever tab is active right now, including
  // after the horizontally-scrollable tab bar has been scrolled (see the
  // scroll listener below, which re-runs this while the menu is open).
  // Clamped horizontally so the popup always stays fully on screen even
  // when its tab is scrolled partway out of view at either edge of
  // .dials-tabbar — once the tab scrolls fully back into view, the clamp
  // is a no-op and it lands exactly below the tab as usual.
  const menuWidth = els.dialTabArchiveMenu.offsetWidth || 160;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - menuWidth - 8);
  els.dialTabArchiveMenu.style.left = `${left}px`;
  els.dialTabArchiveMenu.style.top = `${rect.bottom + 6}px`;
  els.dialTabArchiveMenu.classList.remove("hidden");
}

function closeArchiveMenu() {
  if (!archiveMenuTabId) return;
  archiveMenuTabId = null;
  els.dialTabTransferMenu.classList.add("hidden");
  updateArchiveMenuPosition();
}

// The mobile tab bar (.dials-tabbar) scrolls horizontally on its own — if
// the Archive/Rename/Delete popup is open and the bar gets scrolled (its
// active tab sliding to a new on-screen position), re-run the same
// position logic so the popup keeps tracking the tab's real position
// instead of staying wherever it was when it first opened.
els.dialTabs.parentElement.addEventListener(
  "scroll",
  () => {
    if (!archiveMenuTabId) return;
    updateArchiveMenuPosition();
    if (!els.dialTabTransferMenu.classList.contains("hidden")) positionTransferMenu();
  },
  { passive: true }
);

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
// Admin-only "Transfer" — hands off one of the current admin's own tabs (and
// every dial in it) to a different account, by reassigning created_by on both
// dial_lists and dials (see the widened RLS update policies for both tables
// in supabase/schema.sql). The tab then disappears from the transferring
// admin's Dials page and starts appearing on the new owner's instead, since
// both tables' select policies scope visibility to created_by = auth.uid().
// ---------------------------------------------------------------------------

// Positioned to the right of the archive/delete popup (same escape-the-clip
// fixed-position pattern as everything else here), flipping to the left side
// if it would run off the right edge of the screen.
function positionTransferMenu() {
  const rect = els.dialTabArchiveMenu.getBoundingClientRect();
  const menuWidth = els.dialTabTransferMenu.offsetWidth || 190;
  let left = rect.right + 8;
  if (left + menuWidth > window.innerWidth) {
    left = rect.left - menuWidth - 8;
  }
  els.dialTabTransferMenu.style.left = `${Math.max(8, left)}px`;
  els.dialTabTransferMenu.style.top = `${rect.top}px`;
}

async function openTransferMenu() {
  els.dialTabTransferList.innerHTML = `<div class="dial-tab-transfer-empty">Loading…</div>`;
  els.dialTabTransferMenu.classList.remove("hidden");
  positionTransferMenu();

  // Normally every OTHER account in the company — never the admin doing the
  // transferring, since a tab can't be "transferred" to its own owner. BUT
  // if the tab being transferred belongs to someone else (the admin is
  // viewing another account's tab via Accounts visible), the admin's own
  // name IS included, so they have the option to transfer it back to
  // themselves rather than only ever being able to hand it off sideways to
  // a third account.
  const list = filteredLists().find((l) => l.id === archiveMenuTabId);
  const isOwnTab = !list || list.created_by === profile.id;
  let query = supabase.from("profiles").select("id, full_name").order("full_name", { ascending: true });
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
    els.dialTabTransferList.innerHTML = targets
      .map(
        (p) =>
          `<button type="button" class="dial-tab-transfer-option" data-id="${p.id}">${escapeHtml(p.full_name)}${p.id === profile.id ? " (you)" : ""}</button>`
      )
      .join("");
    els.dialTabTransferList.querySelectorAll(".dial-tab-transfer-option").forEach((btn) => {
      btn.addEventListener("click", () => completeTransfer(btn.dataset.id));
    });
  }
  positionTransferMenu(); // re-measure now that real content has replaced "Loading…"
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

  archiveMenuTabId = null;
  currentListId = null;
  await loadLists();
}

els.dialTabTransferBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!archiveMenuTabId) return;
  openTransferMenu();
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
      // Select mode's "Move" button puts us in moveMode, waiting for the
      // user to tap whichever tab they want the selected dials moved into —
      // intercept that tap here instead of doing a normal tab switch.
      if (selectMode && moveMode) {
        completeMoveToList(id);
        return;
      }
      // Tap/click the already-active tab -> reveal the Archive/Unarchive
      // (+ admin-only Transfer) / Delete popup below it. Used to be
      // mobile-only (isMobileViewport()) since desktop had no use for it, but
      // admin-only Transfer needs to be reachable on desktop too now.
      if (id === currentListId) {
        archiveMenuTabId = archiveMenuTabId === id ? null : id;
        renderTabs();
        // If the page-header triangle/settings dropdown was open, this same
        // click also closes it (see pageHeaderMenu.js's outside-click
        // handler) — but that dropdown lives in normal document flow (see
        // .page-header-menu in style.css, no position:absolute/fixed), so
        // closing it shifts the tab bar upward. renderTabs() just positioned
        // this popup based on the tab's pre-shift location, so re-run once
        // more on the next frame, after that reflow has actually happened,
        // to avoid it landing well below the tab instead of right under it.
        requestAnimationFrame(updateArchiveMenuPosition);
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

// Settings gear popover — admin-only Sellers/Buyers toggle (see
// js/dealSide.js). Hidden entirely for interns (it used to just be inert
// but still visible/clickable, which was pointless since it has nothing
// for them — now it's not even shown).
if (!isAdmin && !isTeamLead) els.pageSettingsBtn.classList.add("hidden");
if (isAdmin || isTeamLead) {
  wirePageHeaderMenu({ toggleBtn: els.pageSettingsBtn, menuEl: els.settingsMenu });
  els.pageSettingsBtn.addEventListener("click", closeArchiveMenu); // see comment above
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
// the top of this file).
// ---------------------------------------------------------------------------
let selectedImportFile = null;

function openImportDialsModal() {
  els.importDialsError.classList.add("hidden");
  els.importDialsFileName.textContent = "";
  els.importDialsImportBtn.disabled = true;
  els.importDialsFileInput.value = "";
  selectedImportFile = null;
  els.importDialsModal.classList.remove("hidden");
}

els.menuImportBtn.addEventListener("click", () => {
  closePageHeaderMenu();
  openImportDialsModal();
});
els.importDialsCancelBtn.addEventListener("click", () => els.importDialsModal.classList.add("hidden"));
// The visible "Choose CSV" button just proxies to the real (hidden) file
// input — clicking a styled button instead of the native input directly
// gives a consistent look on both desktop (Finder) and mobile (Files/Photos
// picker), both of which open from input[type=file] the same way.
els.importDialsChooseBtn.addEventListener("click", () => els.importDialsFileInput.click());
els.importDialsFileInput.addEventListener("change", () => {
  const file = els.importDialsFileInput.files?.[0] || null;
  selectedImportFile = file;
  els.importDialsFileName.textContent = file ? file.name : "";
  els.importDialsImportBtn.disabled = !file;
});

els.importDialsImportBtn.addEventListener("click", async () => {
  if (!selectedImportFile) return;
  els.importDialsError.classList.add("hidden");
  els.importDialsImportBtn.disabled = true;
  try {
    const text = await selectedImportFile.text();
    const rows = parseCSV(text).filter((r) => r.some((c) => (c || "").trim() !== ""));
    if (rows.length < 2) {
      throw new Error("That CSV doesn't have any data rows to import.");
    }
    // The new tab's name is the CSV's filename (minus the .csv extension),
    // always created under Current — regardless of whether Current or
    // Archived happens to be selected right now — per spec.
    const tabName = selectedImportFile.name.replace(/\.csv$/i, "").trim() || "Imported";
    const sortOrder = allLists.filter((l) => l.dial_type === currentType && l.status === "current").length;
    const { data: newList, error: listErr } = await supabase
      .from("dial_lists")
      .insert({ name: tabName, dial_type: currentType, status: "current", sort_order: sortOrder })
      .select()
      .single();
    if (listErr) throw listErr;

    const dialRows = rowsToDials(rows, newList.id);
    if (!dialRows.length) {
      throw new Error("No data rows found in that CSV.");
    }
    const { error: insertErr } = await supabase.from("dials").insert(dialRows);
    if (insertErr) throw insertErr;

    // Land the user on the tab that was just created, switching to Current
    // first if Archived was selected so the new tab is actually visible.
    if (currentStatus !== "current") {
      currentStatus = "current";
      els.menuStatusBtn.querySelector(".menu-item-label").textContent = "Current";
      els.menuStatusBtn.dataset.status = "current";
      persistStatus();
    }
    currentListId = newList.id;
    persistCurrentListId();
    els.importDialsModal.classList.add("hidden");
    await loadLists();
  } catch (err) {
    els.importDialsError.textContent = err.message || "Could not import that CSV.";
    els.importDialsError.classList.remove("hidden");
  } finally {
    els.importDialsImportBtn.disabled = false;
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
          ${selectMode ? selectCircleHTML(d) : contactActionIcons({ phone: d.mobile_phone, email: d.email })}
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
    ${rfContact("Email", dial.email, "email")}
    ${buildPhoneNumbersHTML(dial)}
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
    <div class="form-row">
      <div><label for="d_first_name">First name</label><input id="d_first_name" value="${escapeHtml(dial.first_name)}" /></div>
      <div><label for="d_last_name">Last name</label><input id="d_last_name" value="${escapeHtml(dial.last_name)}" /></div>
    </div>
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
    first_name: document.getElementById("d_first_name").value.trim() || null,
    last_name: document.getElementById("d_last_name").value.trim() || null,
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
            ${
              isCalledTodayVisible(dial)
                ? `<button type="button" class="dial-did-call-btn ${calledToday ? "active" : ""}" id="dialDidCallBtn">Called today</button>`
                : ""
            }
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
    const didCallBtn = document.getElementById("dialDidCallBtn");
    // Disabling synchronously on click (in addition to the didCallToggleInFlight
    // guard inside toggleDidCallToday itself) gives an immediate visual cue
    // that the press registered, so there's no moment where an impatient
    // second click feels necessary — see toggleDidCallToday's comment for the
    // duplicate-call bug this combination fixes.
    if (didCallBtn) didCallBtn.addEventListener("click", () => { didCallBtn.disabled = true; toggleDidCallToday(); });
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
  const data = {
    contact_status: newStatus,
    // See isCalledTodayVisible's comment — switching TO one of the 3 hide
    // categories only takes effect starting tomorrow (stays visible for the
    // rest of today no matter how many times you flip between categories),
    // while switching TO one of the 3 show categories un-hides it right
    // away, so this clears the field immediately in that case.
    status_hide_effective_date: SHOW_CALLED_TODAY_STATUSES.has(newStatus) ? null : tomorrowDateStr(),
  };
  const { error } = await supabase.from("dials").update(data).eq("id", currentDial.id);
  if (error) return showError(els.dialModalError, error);
  Object.assign(currentDial, data);
  const idx = dials.findIndex((d) => d.id === currentDial.id);
  if (idx !== -1) Object.assign(dials[idx], data);

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
//
// Guards against a real bug that duplicated calls: this function is async
// and its very first read (isCalledToday) happens BEFORE any await settles.
// If the button didn't visibly flip green right away (flushCallNotes/the
// update can take a moment) and someone impatiently clicked it again, the
// second call's isCalledToday read the same stale "not called yet" state as
// the first — both took the "else" branch and both inserted a
// call_status_changes row for one press, inflating the week's/today's count.
// didCallToggleInFlight makes every click after the first a no-op until the
// in-flight one fully finishes and re-renders.
let didCallToggleInFlight = false;
async function toggleDidCallToday() {
  if (didCallToggleInFlight) return;
  didCallToggleInFlight = true;
  try {
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
  } finally {
    didCallToggleInFlight = false;
  }
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

  let nameMissing = false;
  if (!dial.first_name) { missing.push("first_name"); nameMissing = true; }
  if (!dial.last_name) { missing.push("last_name"); nameMissing = true; }
  if (nameMissing) labels.push("Name");

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
    userId: profile.id,
    createClient: async () => {
      // client_type must match whichever side (Sellers/Buyers toggle) this
      // dial actually belongs to — defaultClient()'s own default is
      // "seller", which used to apply even from a buyer dial since nothing
      // here ever overrode it. Company name / Industry never transfer for a
      // buyer dial since they're never collected on one in the first place
      // (see buildDialEditHTML/getMissingDialClientFields above) — clean,
      // since clientForm.js's buyer branch has no company fields at all.
      const isBuyer = currentType === "buyer";
      const data = defaultClient(profile, {
        client_type: currentType,
        first_name: dial.first_name || "",
        last_name: dial.last_name || "",
        city: dial.city || "",
        state: dial.state || "",
        email: dial.email || "",
        // Both numbers transfer over as their own fields now (mobile stays
        // the one used for instant call/text everywhere else in the app).
        mobile_phone: dial.mobile_phone || "",
        company_phone: dial.company_phone || "",
        linkedin: dial.linkedin || "",
        ...(isBuyer ? {} : { company_name: dial.company_name || "", industry: dial.industry || "" }),
        // Call notes from the dial transfer straight into the new client's
        // Other notes field.
        other_notes: dial.call_notes || "",
      });
      data.assigned_to = profile.id;

      const { data: inserted, error } = await supabase.from("clients").insert(data).select().single();
      if (error) throw error;
      return inserted;
    },
    // Scheduling from Dials no longer logs a client_events row (and so no
    // longer appears in the new client's Timeline on its own) — Timeline is
    // now strictly manual-only, populated exclusively by clicking "+" there
    // and choosing "Intro call" yourself (see wireTimelineTab/
    // openTimelineIntroCall in js/clients.js). The "intro calls scheduled"
    // count on the Profile page still goes up, though — that's logged inside
    // wireIntroCallForm itself (js/introCall.js) via the `userId` opt above.
    onScheduled: async () => {
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
      // Admins see everyone; a team lead only ever sees their own teammates
      // (same team_id) — never every account. Requires
      // dial_lists_select_own/dials_select_own to also allow
      // is_team_lead_of() (see supabase/schema.sql), otherwise a team lead's
      // session could never fetch a teammate's tabs/dials in the first
      // place, filter or no filter.
      if (isAdmin) {
        const { data, error } = await supabase.from("profiles").select("id, full_name").order("full_name", { ascending: true });
        return error ? [] : data || [];
      }
      if (!profile.team_id) return [];
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("team_id", profile.team_id)
        .order("full_name", { ascending: true });
      return error ? [] : data || [];
    },
    onChange: renderTabs,
    escapeHtml,
  });
}

await loadLists();
