import { loadTeamScopeAccounts, groupsByTeam, teamIdsOf, withoutAi } from "./teamScope.js";
import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";
import { STATES, escapeHtml, defaultClient, stateOptionsHTML, stateToCode } from "./clientForm.js";
import { buildIntroCallFormHTML, wireIntroCallForm } from "./introCall.js";
import { buildSmsHref, rfContact, contactActionIcons, stopContactActionPropagation, wireQuickSendButtons, locationPinLink, buildPhoneNumbersHTML } from "./contactIcons.js";
import {
  wireAdvancedSettingsPopup,
  resolvePersonalizedEmailBody,
  resolvePersonalizedEmailSubject,
  resolvePersonalizedTextingBody,
  resolveAboutUsEmailBody,
  resolveAboutUsEmailSubject,
  resolveRecommendedEmail,
  selectedRecommendedEmailKind,
  withSignoff,
} from "./advancedSettings.js";
import { findPriorOutbound, followUpAlreadySent, stripReplyPrefix } from "./followUp.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus as closePageHeaderMenu } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { getDealSide, wireDealSideToggle } from "./dealSide.js";
import { getVisibleAccountIds, setVisibleAccountIds, wireAccountsVisiblePopup, initDefaultToSelf } from "./accountsVisible.js";
import { wireNotificationsToggle } from "./notifications.js";
import { createImportWizard } from "./importWizard.js";
import { startCall, isCallActive, primeAudio } from "./callSession.js";
import { callBlocked } from "./testCallGuard.js";
import { wireAutodialToggle, wireProfileToggle } from "./autodial.js";
import { cacheGet, cacheSet, isNetworkError, showOfflineNotice, hideOfflineNotice, withNetworkRetry } from "./offlineCache.js";
import { timeOptionsHTML, timezoneOptionsHTML, defaultTimezone, zonedTimeToUtcIso } from "./eventTime.js";
import { skeletonListHtml, skeletonSheetHtml } from "./placeholders.js";
import { openSubmissionPopup, sendLeadToSheetAndSlack, describeDelivery } from "./intakeForm.js";
import { showNotice, showToast } from "./notice.js";
import { msg as friendlyMsg } from "./copyCommon.js";
import { keepRecordingForDial, discardRecordingsForDial, signedRecordingUrl } from "./callRecordings.js";
import { initDialsHome } from "./dialsHome.js";
import { seqBadgeHTML, seqPanelHTML, wireSeqPanel, mountMandatePicker, defaultMandateForBuyer, prepareList, describePrepare, runSequenceSetupFlow } from "./copyReview.js";

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
let dialsLoadFailed = false; // the list's dials could not be loaded: show a Retry state, never "all caught up"
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
  // Between "No response" (orange) and "Callback, interested" (yellow): the owner
  // was reached but had no time to talk — it counts as having talked to the owner.
  { value: "busy_callback", label: "Busy, call back", bg: "var(--status-busy-bg)", border: "var(--status-busy-border)", dot: "var(--status-busy-dot)" },
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
// Select mode (bulk-select dials to move or delete) — see
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

// Free-text query from the "Search" triangle-menu option (see
// enterSearchMode/visibleDials below) — a cross-cutting filter like the
// Categories status filter (hiddenStatuses), not a per-tab action mode like
// Select above, so it deliberately survives switching tabs instead of
// clearing.
let dialSearchQuery = "";

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
  menuShowAllBtn: document.getElementById("menuShowAllBtn"),
  menuShowAllLabel: document.getElementById("menuShowAllLabel"),
  menuSearchBtn: document.getElementById("menuSearchBtn"),
  dialsSearchBar: document.getElementById("dialsSearchBar"),
  dialsSearchInput: document.getElementById("dialsSearchInput"),
  dialsSearchCloseBtn: document.getElementById("dialsSearchCloseBtn"),
  menuStatusBtn: document.getElementById("menuStatusBtn"),
  menuCategoriesBtn: document.getElementById("menuCategoriesBtn"),
  categoriesSubmenu: document.getElementById("categoriesSubmenu"),
  menuAccountsVisibleBtn: document.getElementById("menuAccountsVisibleBtn"),
  accountsVisiblePopup: document.getElementById("accountsVisiblePopup"),
  accountsVisibleBody: document.getElementById("accountsVisibleBody"),
  accountsVisibleClose: document.getElementById("accountsVisibleClose"),
  menuNotificationsBtn: document.getElementById("menuNotificationsBtn"),
  notificationsLabel: document.getElementById("notificationsLabel"),
  autodialRow: document.getElementById("autodialRow"),
  autodialToggle: document.getElementById("autodialToggle"),
  transcriptCallingRow: document.getElementById("transcriptCallingRow"),
  transcriptCallingToggle: document.getElementById("transcriptCallingToggle"),
  callRecordingRow: document.getElementById("callRecordingRow"),
  callRecordingToggle: document.getElementById("callRecordingToggle"),
  recordAllCallsRow: document.getElementById("recordAllCallsRow"),
  recordAllCallsToggle: document.getElementById("recordAllCallsToggle"),
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
  dialTabSeqBtn: document.getElementById("dialTabSeqBtn"),
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
  requiredPopupFill: document.getElementById("requiredPopupFill"),
  newListModal: document.getElementById("newListModal"),
  newListError: document.getElementById("newListError"),
  newListNameInput: document.getElementById("newListNameInput"),
  newListBuyerRow: document.getElementById("newListBuyerRow"),
  newListBuyerSelect: document.getElementById("newListBuyerSelect"),
  newListCreateBtn: document.getElementById("newListCreateBtn"),
  newListCancelBtn: document.getElementById("newListCancelBtn"),
  confirmDeleteModal: document.getElementById("confirmDeleteModal"),
  introCallPopup: document.getElementById("introCallPopup"),
  introCallPopupBody: document.getElementById("introCallPopupBody"),
  introCallPopupClose: document.getElementById("introCallPopupClose"),
  introCallTimeModal: document.getElementById("introCallTimeModal"),
  callbackTimeModal: document.getElementById("callbackTimeModal"),
  callbackDateInput: document.getElementById("callbackDateInput"),
  callbackTimeInput: document.getElementById("callbackTimeInput"),
  callbackTimeError: document.getElementById("callbackTimeError"),
  callbackTimeSaveBtn: document.getElementById("callbackTimeSaveBtn"),
  callbackTimeCancelBtn: document.getElementById("callbackTimeCancelBtn"),
  introCallTimeDateInput: document.getElementById("introCallTimeDateInput"),
  introCallTimeSelect: document.getElementById("introCallTimeSelect"),
  introCallTimeZoneSelect: document.getElementById("introCallTimeZoneSelect"),
  introCallTimeError: document.getElementById("introCallTimeError"),
  introCallTimeConfirmBtn: document.getElementById("introCallTimeConfirmBtn"),
  introCompletedModal: document.getElementById("introCompletedModal"),
  introCompletedDateInput: document.getElementById("introCompletedDateInput"),
  introCompletedTimeSelect: document.getElementById("introCompletedTimeSelect"),
  introCompletedTimeZoneSelect: document.getElementById("introCompletedTimeZoneSelect"),
  introCompletedReportInput: document.getElementById("introCompletedReportInput"),
  introCompletedError: document.getElementById("introCompletedError"),
  introCompletedSaveBtn: document.getElementById("introCompletedSaveBtn"),
  introCompletedCancelBtn: document.getElementById("introCompletedCancelBtn"),
  importDialsModal: document.getElementById("importDialsModal"),
  importDialsError: document.getElementById("importDialsError"),
  importDialsDropzone: document.getElementById("importDialsDropzone"),
  importDialsFileInput: document.getElementById("importDialsFileInput"),
  importDialsChooseBtn: document.getElementById("importDialsChooseBtn"),
  importDialsFileName: document.getElementById("importDialsFileName"),
  importDialsBuyerRow: document.getElementById("importDialsBuyerRow"),
  importDialsBuyerSelect: document.getElementById("importDialsBuyerSelect"),
  importDialsImportBtn: document.getElementById("importDialsImportBtn"),
  importDialsCancelBtn: document.getElementById("importDialsCancelBtn"),
  selectModeBar: document.getElementById("selectModeBar"),
  selectBackBtn: document.getElementById("selectBackBtn"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  selectMoveBtn: document.getElementById("selectMoveBtn"),
  selectDeleteBtn: document.getElementById("selectDeleteBtn"),
  selectMassEmailBtn: document.getElementById("selectMassEmailBtn"),
  massEmailModal: document.getElementById("massEmailModal"),
  massEmailTitle: document.getElementById("massEmailTitle"),
  massEmailSummary: document.getElementById("massEmailSummary"),
  massEmailList: document.getElementById("massEmailList"),
  massEmailSendingTitle: document.getElementById("massEmailSendingTitle"),
  massEmailSkipped: document.getElementById("massEmailSkipped"),
  massEmailSkippedTitle: document.getElementById("massEmailSkippedTitle"),
  massEmailSkippedList: document.getElementById("massEmailSkippedList"),
  massEmailProgress: document.getElementById("massEmailProgress"),
  massEmailPending: document.getElementById("massEmailPending"),
  massEmailPendingText: document.getElementById("massEmailPendingText"),
  massEmailCancelPendingBtn: document.getElementById("massEmailCancelPendingBtn"),
  massEmailSendBtn: document.getElementById("massEmailSendBtn"),
  massEmailCancelBtn: document.getElementById("massEmailCancelBtn"),
  selectMoveHint: document.getElementById("selectMoveHint"),
  confirmBulkDeleteModal: document.getElementById("confirmBulkDeleteModal"),
  confirmBulkDeleteTitle: document.getElementById("confirmBulkDeleteTitle"),
  menuAdvancedBtn: document.getElementById("menuAdvancedBtn"),
  advancedSettingsPopup: document.getElementById("advancedSettingsPopup"),
  advancedSettingsClose: document.getElementById("advancedSettingsClose"),
  personalizedEmailRow: document.getElementById("personalizedEmailRow"),
  personalizedEmailToggle: document.getElementById("personalizedEmailToggle"),
  recommendedFirstEmailRow: document.getElementById("recommendedFirstEmailRow"),
  recommendedFirstEmailToggle: document.getElementById("recommendedFirstEmailToggle"),
  recommendedSecondEmailRow: document.getElementById("recommendedSecondEmailRow"),
  recommendedSecondEmailToggle: document.getElementById("recommendedSecondEmailToggle"),
  personalizedEmailEditorPopup: document.getElementById("personalizedEmailEditorPopup"),
  personalizedEmailEditorToggle: document.getElementById("personalizedEmailEditorToggle"),
  personalizedEmailSubjectInput: document.getElementById("personalizedEmailSubjectInput"),
  personalizedEmailTextarea: document.getElementById("personalizedEmailTextarea"),
  personalizedEmailTokenCompany: document.getElementById("personalizedEmailTokenCompany"),
  personalizedEmailTokenSeller: document.getElementById("personalizedEmailTokenSeller"),
  personalizedEmailError: document.getElementById("personalizedEmailError"),
  personalizedEmailEditorClose: document.getElementById("personalizedEmailEditorClose"),
  aboutUsEmailRow: document.getElementById("aboutUsEmailRow"),
  aboutUsEmailToggle: document.getElementById("aboutUsEmailToggle"),
  aboutUsEmailEditorPopup: document.getElementById("aboutUsEmailEditorPopup"),
  aboutUsEmailEditorToggle: document.getElementById("aboutUsEmailEditorToggle"),
  aboutUsEmailSubjectInput: document.getElementById("aboutUsEmailSubjectInput"),
  aboutUsEmailTextarea: document.getElementById("aboutUsEmailTextarea"),
  aboutUsEmailTokenCompany: document.getElementById("aboutUsEmailTokenCompany"),
  aboutUsEmailTokenSeller: document.getElementById("aboutUsEmailTokenSeller"),
  aboutUsEmailTokenYourName: document.getElementById("aboutUsEmailTokenYourName"),
  aboutUsEmailError: document.getElementById("aboutUsEmailError"),
  aboutUsEmailEditorClose: document.getElementById("aboutUsEmailEditorClose"),
  personalizedTextingRow: document.getElementById("personalizedTextingRow"),
  personalizedTextingToggle: document.getElementById("personalizedTextingToggle"),
  personalizedTextingEditorPopup: document.getElementById("personalizedTextingEditorPopup"),
  personalizedTextingEditorToggle: document.getElementById("personalizedTextingEditorToggle"),
  personalizedTextingTextarea: document.getElementById("personalizedTextingTextarea"),
  personalizedTextingTokenCompany: document.getElementById("personalizedTextingTokenCompany"),
  personalizedTextingTokenSeller: document.getElementById("personalizedTextingTokenSeller"),
  personalizedTextingError: document.getElementById("personalizedTextingError"),
  personalizedTextingEditorClose: document.getElementById("personalizedTextingEditorClose"),
};

// CSV import and Transfer are both available to team leads too now (see
// transfer_dial_list() in supabase/schema.sql, which enforces a team lead
// can only transfer their own or their team's tabs, and only to an admin or
// an intern on their own team — openTransferMenu below applies that same
// scoping to the target-account list it shows).
if (isAdmin || isTeamLead) els.menuImportBtn.classList.remove("hidden");
if (isAdmin || isTeamLead) els.dialTabTransferBtn.classList.remove("hidden");
// Unlike Transfer above (which reassigns account ownership — applies to any
// tab type), "Client" reassigns which buyer a tab is attached to, a
// seller-tab-only concept (see #newListBuyerRow's comment in dials.html) —
// so this also depends on currentType, not just role, and needs
// re-evaluating whenever the Sellers/Buyers toggle flips (see
// wireDealSideToggle's callback further down), not just once at load.
function updateDialTabClientBtnVisibility() {
  els.dialTabClientBtn.classList.toggle("hidden", !(isAdmin || isTeamLead) || currentType !== "seller");
}
updateDialTabClientBtnVisibility();
if (isAdmin || isTeamLead) els.menuAccountsVisibleBtn.classList.remove("hidden");
// Sellers/Buyers is shown here too, as early as Accounts visible (it used to wait for the end of this file, so anything that went
// wrong in between left the Calls gear with only "Advanced"). Its click handling is wired further down.
if (isAdmin || isTeamLead) els.dealSideToggleBtn.classList.remove("hidden");
// Manual "+ new tab" creation — same admin/team-lead-only scope as CSV
// import above (interns can't create tabs at all; enforced server-side too,
// see the dial_lists_insert_own RLS policy).
if (isAdmin || isTeamLead) els.addTabBtn.classList.remove("hidden");
// Notifications on/off — everyone gets this (see js/notifications.js),
// unlike Import/Transfer/Accounts visible above which stay admin/team-lead
// only.
wireNotificationsToggle(els.menuNotificationsBtn, els.notificationsLabel, profile);
wireAutodialToggle(els.autodialRow, els.autodialToggle, profile);
wireProfileToggle(els.transcriptCallingRow, els.transcriptCallingToggle, profile, "transcript_calling_enabled", true);
// Two recording choices that exclude each other: accepted intro calls only (default) or all calls. Tapping the one that is on turns recording off.
(function wireRecordingChoice() {
  const rows = [
    { row: els.callRecordingRow, sw: els.callRecordingToggle, col: "record_accepted_calls", other: "record_all_calls", dflt: true },
    { row: els.recordAllCallsRow, sw: els.recordAllCallsToggle, col: "record_all_calls", other: "record_accepted_calls", dflt: false },
  ];
  const isOn = (c, d) => (profile[c] === undefined || profile[c] === null ? d : profile[c] === true);
  const render = () => rows.forEach((r) => { const on = isOn(r.col, r.dflt); r.sw.classList.toggle("on", on); r.sw.setAttribute("aria-checked", String(on)); });
  render();
  rows.forEach((r) => r.row?.addEventListener("click", async () => {
    const prev = { a: profile.record_accepted_calls, b: profile.record_all_calls };
    const next = !isOn(r.col, r.dflt);
    profile[r.col] = next;
    if (next) profile[r.other] = false;
    render();
    const patch = { [r.col]: next }; if (next) patch[r.other] = false;
    const { error } = await supabase.from("profiles").update(patch).eq("id", profile.id);
    if (error) { console.error("Failed to update recording setting", error); profile.record_accepted_calls = prev.a; profile.record_all_calls = prev.b; render(); }
  }));
})();

// "Advanced" settings (email templates, texting, recommended emails) — shared
// wiring, see js/advancedSettings.js for the full implementation and why
// it's factored out this way (every page wires the exact same behavior
// against its own DOM elements, same pattern as wireNotificationsToggle).
wireAdvancedSettingsPopup({ profile, els, closePageHeaderMenu });

// Set while the Calendly step of the questionnaire intro popup (see
// openQuestionnaireIntroPopup) is open, so closing it without booking brings
// that popup back instead of dropping the user on the dial.
let onIntroCallPopupClosed = null;
els.introCallPopupClose.addEventListener("click", () => {
  els.introCallPopup.classList.add("hidden");
  const back = onIntroCallPopupClosed;
  onIntroCallPopupClosed = null;
  if (back) back();
  else revertIntroStatus(); // closed the chooser without booking: the dial and its placeholder client go back like Cancel on the time step
});

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

// Only filled fields are shown (no "Not provided" rows).
function rf(label, value) {
  const v = value === null || value === undefined || value === "" ? "" : String(value);
  if (!v) return "";
  return `<div class="readonly-field"><div class="rf-label">${escapeHtml(label)}</div><div class="rf-value">${escapeHtml(v)}</div></div>`;
}

function rfWebsite(label, value) {
  const v = value ? String(value) : "";
  if (!v) return "";
  const href = !/^https?:\/\//i.test(v) ? `https://${v}` : v;
  return `
    <div class="readonly-field">
      <div class="rf-label">${escapeHtml(label)}</div>
      <div class="rf-value"><a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(v)}</a></div>
    </div>`;
}

function dialDisplayName(d) {
  return d.full_name || "Unnamed dial";
}
function dialLocation(d) {
  return [d.city, stateToCode(d.state)].filter(Boolean).join(", ") || "—";
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

// The parser, column auto-mapping and row building live in js/csvImport.js; the preview/mapping/duplicate screen
// and the chunked import in js/importWizard.js.

// Local calendar date (not UTC) as YYYY-MM-DD — used for the "Did call
// today" toggle, which just compares against this rather than needing a
// scheduled job to reset at midnight.
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The real UTC instants a LOCAL calendar date (as produced by todayDateStr)
// starts and ends at — for filtering call_status_changes.changed_at
// (timestamptz) by "today" in autoMarkContacted/syncTodaysCallLogSnapshot.
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
// method's white circle (see autoMarkContacted
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
// autoMarkContacted() only snapshots once, at the exact moment a circle is
// checked, which in practice is often BEFORE the outcome is known (status is
// set and notes are typed once the call has actually happened). Confirmed as
// a real bug in production: freshly-logged calls were coming through with
// null website/city/state/industry/call_notes even though the dial itself
// had all of it, because those fields hadn't been filled in yet at the
// instant a circle was checked. Only ever UPDATEs row(s) that already exist
// for today (there can be up to 3 now, one per checked circle) — never
// inserts one (that stays autoMarkContacted's job alone), and never touches
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

// Non-interactive "Contacted today xN" display — white at 0, green
// otherwise. Updated automatically (no manual circles anymore): starting a call
// records that number's contact (autoMarkContacted), and an email sent through the app
// records the email contact (email_messages_mark_dials trigger) — up to 3 a day
// (mobile call, company call, email).
function buildContactedTodayDisplayHTML(dial) {
  const count = contactedTodayCount(dial);
  const label = count === 0 ? "Not contacted today" : `${count} ${count === 1 ? "contact" : "contacts"} today`;
  return `<div class="dial-contacted-today-display ${count > 0 ? "active" : ""}" title="Calls and emails logged today (up to 3)">${label}</div>`;
}

// ---------------------------------------------------------------------------
// In-app calling (js/callSession.js). Tapping an owner dial's call icon places the call inside the
// app; starting it checks that number's "Contacted today" circle automatically, and a finished
// call's summary shows in the "Transcript" box right under the call notes.
// ---------------------------------------------------------------------------
async function autoMarkContacted(dial, method) {
  const col = CONTACT_METHOD_DATE_COLUMNS[method];
  const today = todayDateStr();
  if (!col) return false;
  if (dial[col] === today) return true; // already checked today
  const { error } = await supabase.from("dials").update({ [col]: today }).eq("id", dial.id);
  if (error) return false;
  const list = allLists.find((l) => l.id === dial.list_id);
  await supabase.from("call_status_changes").insert({
    user_id: profile.id, dial_id: dial.id, dial_type: currentType, list_id: dial.list_id, contact_status_at_call: dial.contact_status,
    contact_method: method, buyer_id: list?.buyer_id || null, company_name: dial.company_name || null, contact_name: dial.full_name || null,
    website: dial.website || null, city: dial.city || null, state: dial.state || null, industry: dial.industry || null, call_notes: dial.call_notes || null,
  });
  dial[col] = today;
  const idx = dials.findIndex((d) => d.id === dial.id);
  if (idx !== -1) dials[idx][col] = today;
  if (currentDial?.id === dial.id) { Object.assign(currentDial, { [col]: today }); renderDialModal(); }
  return true;
}

// Calling through the phone's own dialer (Transcript calling off, or the in-app call fell back). The phone
// asks "Call …?" first, so the contact must NOT be recorded when the button is tapped — only once the phone
// has really taken over, which shows up as this page going into the background. (Cancelling the prompt
// leaves the page in front, so nothing is recorded; a pending tap expires after 45 s.)
let pendingNative = null;
async function dialViaPhone(dial, method, phone) {
  if (await callBlocked(phone)) return;
  countCallTry(dial, phone, method);
  pendingNative = { dial, method, at: Date.now(), left: false, busy: false };
  window.location.href = `tel:${phone}`;
}
async function commitPendingNative() {
  const p = pendingNative;
  if (!p || p.busy) return;
  if (Date.now() - p.at > 45000) { pendingNative = null; return; }
  p.busy = true;
  const ok = await autoMarkContacted(p.dial, p.method);
  p.busy = false;
  if (ok && pendingNative === p) pendingNative = null;
}
document.addEventListener("visibilitychange", () => {
  if (!pendingNative) return;
  if (document.visibilityState === "hidden") { pendingNative.left = true; commitPendingNative(); }
  else if (pendingNative.left) { pendingNative.at = Date.now(); commitPendingNative(); } // back from the call: retry if the first save was cut off
});
window.addEventListener("pagehide", () => { if (pendingNative) { pendingNative.left = true; commitPendingNative(); } });

// Count tries on the same number in a row, so Autodial knows a mobile has only been rung once (see autodialTarget). Called only once a
// call is really placed (the call session's onDialed, or the phone's own dialer opened): a call the test lock refused, a blocked
// microphone or "already on a call" never counts as the first ring.
function countCallTry(dial, phone, method) {
  autoCall = autoCall?.dialId === dial.id && autoCall.method === method && autoCall.phone === phone
    ? { ...autoCall, attempt: autoCall.attempt + 1 } : { dialId: dial.id, method, phone, attempt: 1 };
}
function placeCall(dial, phone, method) {
  // "Transcript calling" off (Dials > Advanced): plain calling through the phone's own dialer, no in-app call.
  if (profile.transcript_calling_enabled === false) {
    dialViaPhone(dial, method, phone);
    return;
  }
  startCall({
    dial, phone, method, profile,
    onDialed: () => { countCallTry(dial, phone, method); return autoMarkContacted(dial, method); },
    onSummary: () => { if (currentDial?.id === dial.id) loadDialTranscript(); },
    onRecordingSaved: () => { if (currentDial?.id === dial.id) loadDialTranscript(); },
    fallbackTel: (num) => dialViaPhone(dial, method, num),
    // After hangup: one-tap outcome (the DB links it to this call) and straight on to the next company.
    // Same outcomes, labels and follow-ups as the card (callback time picker, intro booking), so there is one flow, not two.
    outcomes: OUTCOME_CHIPS,
    onOutcome: async (status) => {
      if (!(currentDial?.id === dial.id && dialMode === "view")) return false;
      if (status === "intro_call_scheduled" && dial.contact_status !== "intro_call_scheduled" && introInfoMissing(dial)) return false;
      introRevert = status === "intro_call_scheduled" && dial.contact_status !== "intro_call_scheduled" ? snapIntro(dial) : null;
      const isCallback = !!OUTCOMES.find((o) => o.status === status)?.callback;
      const target = autodialTarget(status); // decided before the save, so the right "next" company is used
      if (target) primeAudio();
      const saved = !!(await updateDialStatus(status));
      if (!saved) return false;
      if (status === "intro_call_scheduled") handleScheduleIntroCallFromDial(dial);
      else if (isCallback) openCallbackModal(dial, target ? { after: () => runAutodial(target) } : {}); // the callback time is picked first
      else if (target) setTimeout(() => runAutodial(target), 0);
      return true;
    },
    // Autodial on: a call nobody picked up is logged as "No answer" by itself, then Autodial carries on (a mobile is rung a
    // second time first). A voicemail greeting counts as answered, so those still wait for the caller to pick the outcome.
    onNoAnswer: () => {
      if (!profile.autodial_enabled) return;
      setTimeout(async () => {
        if (!(currentDial?.id === dial.id && dialMode === "view") || isCallActive()) return; // the caller already moved on
        const target = autodialTarget("no_response");
        if (!(await updateDialStatus("no_response"))) return; // error is shown on the card; the caller picks it by hand
        showToast("No answer. Marked as No answer.");
        if (target) runAutodial(target);
      }, 1500);
    },
    onNext: () => { const t = nextCompanyTarget(); if (t?.dial) { primeAudio(); runAutodial(t); } else showNotice("Nothing more is due. Check Callbacks, or pick another list.", { title: "Next company" }); },
  });
}
document.addEventListener(
  "click",
  (e) => {
    const btn = e.target.closest?.(".contact-action-call");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const dial = dials.find((d) => d.id === btn.dataset.dialId) || (currentDial?.id === btn.dataset.dialId ? currentDial : null) || home?.dialById?.(btn.dataset.dialId);
    if (dial) placeCall(dial, btn.dataset.tel, btn.dataset.method || "mobile");
    if (btn.closest(".dh-row") && home?.openCall) setTimeout(() => home.openCall(btn.dataset.dialId), 400); // call sheet: open the card to log the outcome
  },
  true
);

function buildDialTranscriptHTML() {
  return `
    <div class="readonly-field">
      <div class="rf-label">Transcript</div>
      <div id="dialTranscriptBody" class="dial-transcript"><div class="help-text">Loading…</div></div>
    </div>`;
}

async function loadDialTranscript() {
  const box = document.getElementById("dialTranscriptBody");
  if (!box || !currentDial) return;
  const dialId = currentDial.id;
  const { data, error } = await supabase
    .from("calls")
    .select("id, started_at, duration_sec, answered, transcribed, skip_reason, summary, dial_method, recording_path, mode, call_outcome")
    .eq("dial_id", dialId)
    .eq("direction", "outbound")
    .order("started_at", { ascending: false })
    .limit(5);
  const el = document.getElementById("dialTranscriptBody");
  if (!el || currentDial?.id !== dialId) return;
  if (error || !data?.length) {
    el.innerHTML = `<div class="help-text">${error ? "Couldn't load calls." : "No in-app calls yet."}</div>`;
    return;
  }
  // The newest call's summary is shown above "More" when it is from the last day, so nobody has to dig for what was just said.
  const recent = data.find((c) => c.summary && Date.now() - Date.parse(c.started_at) < 86400000);
  const more = document.querySelector(".dial-more");
  let last = document.getElementById("dialLastCall");
  if (recent && more) {
    if (!last) { last = document.createElement("div"); last.id = "dialLastCall"; last.className = "dial-last-call"; more.before(last); }
    last.innerHTML = `<b>Last call, ${escapeHtml(new Date(recent.started_at).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" }))}:</b> ${escapeHtml(recent.summary)}`;
  } else last?.remove();
  el.innerHTML = data
    .map((c) => {
      const when = new Date(c.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const dur = c.duration_sec ? ` · ${Math.floor(c.duration_sec / 60)}:${String(c.duration_sec % 60).padStart(2, "0")}` : "";
      const NATIVE = { mic_denied: "the microphone was blocked", mic_busy: "the microphone was in use", mic_missing: "no microphone was found", unknown_state: "the state couldn't be determined", no_cell: "no cell number on the profile" };
      const body = c.mode === "native"
        ? `Called from the phone's own dialer${NATIVE[c.skip_reason] ? ` (${NATIVE[c.skip_reason]})` : ""}: no transcript or recording.`
        : c.summary
        ? escapeHtml(c.summary)
        : !c.answered
          ? "Not answered."
          : c.skip_reason
            ? (c.skip_reason === "stt_failed" ? "The live transcript failed on this call." : "Not recorded (call-recording rules for this state).")
            : c.transcribed ? "Summary is still being prepared." : "No transcript.";
      const lines = c.transcribed && c.answered ? `<details data-call-id="${c.id}"><summary>Full transcript</summary><div class="dial-transcript-lines"></div></details>` : "";
      const line = c.dial_method === "company" ? "Company line" : c.dial_method === "mobile" ? "Mobile" : "Call";
      const rec = c.recording_path ? `<div class="dial-recording" data-path="${escapeHtml(c.recording_path)}"><button type="button" class="btn secondary dial-recording-play">▶ Play recording</button></div>` : "";
      return `<div class="dial-transcript-call"><div class="dial-transcript-when"><b>${line}</b> · ${escapeHtml(when + dur)}</div><div>${body}</div>${rec}${lines}</div>`;
    })
    .join("");
  el.querySelectorAll(".dial-recording").forEach((box) => {
    box.querySelector(".dial-recording-play").addEventListener("click", async () => {
      const path = box.dataset.path;
      try {
        const url = await signedRecordingUrl(path, 3600);
        box.innerHTML = `<audio controls autoplay preload="auto" src="${url}"></audio>
          <div class="dial-recording-actions"><button type="button" class="btn secondary" data-act="share">Copy share link (7 days)</button><button type="button" class="btn secondary" data-act="download">Download</button></div>`;
        box.querySelector('[data-act="share"]').addEventListener("click", async (e) => {
          const b = e.currentTarget;
          try { await navigator.clipboard.writeText(await signedRecordingUrl(path, 7 * 24 * 3600)); b.textContent = "Link copied"; } catch { b.textContent = "Couldn't copy"; }
          setTimeout(() => { b.textContent = "Copy share link (7 days)"; }, 2000);
        });
        box.querySelector('[data-act="download"]').addEventListener("click", async () => {
          try { window.location.href = await signedRecordingUrl(path, 300, true); } catch { /* ignore */ }
        });
      } catch (err) {
        const gone = /not found|404|no such|does not exist/i.test(err?.message || String(err));
        box.innerHTML = `<div class="help-text">${gone ? "This recording is no longer available." : "Couldn't load the recording. Check your connection and tap Play again."}</div>`;
      }
    });
  });
  el.querySelectorAll("details[data-call-id]").forEach((d) => {
    d.addEventListener("toggle", async () => {
      const target = d.querySelector(".dial-transcript-lines");
      if (!d.open || target.dataset.loaded) return;
      target.dataset.loaded = "1";
      const { data: lines } = await supabase.from("call_lines").select("speaker, text").eq("call_id", d.dataset.callId).order("start_ms");
      target.innerHTML = (lines || []).length
        ? lines.map((l) => `<div><b>${l.speaker === "intern" ? "You" : "Them"}:</b> ${escapeHtml(l.text)}</div>`).join("")
        : `<div class="help-text">No transcript lines.</div>`;
    });
  });
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
// goToDial/updateDialStatus/autoMarkContacted, all of which now `await`
// this before doing anything else).
// Returns true when there is nothing to save or the save worked, false when it failed. A failed save says so under the notes box in
// plain words (never "Saved", never a raw error at the top of the card) and the text stays in the box so it can be saved again.
function setNotesStatus(ok, text) {
  const msg = document.getElementById("callNotesSavedMsg");
  if (!msg) return;
  msg.textContent = text;
  msg.classList.toggle("bad", !ok);
  msg.classList.remove("hidden");
  clearTimeout(setNotesStatus.t);
  if (ok) setNotesStatus.t = setTimeout(() => msg.classList.add("hidden"), 1500);
}
async function flushCallNotes() {
  const notesEl = document.getElementById("d_call_notes_live");
  if (!notesEl || !currentDial) return true;
  const val = notesEl.value.trim() || null;
  if (val === (currentDial.call_notes || null)) return true;
  const { error } = await supabase.from("dials").update({ call_notes: val }).eq("id", currentDial.id);
  if (error) {
    setNotesStatus(false, `Note not saved (${(friendlyMsg(error) || "no connection").replace(/\s*(and )?press Retry\.?/i, "").replace(/\.$/, "")}). Tap outside the box to try again.`);
    return false;
  }
  currentDial.call_notes = val;
  const idx = dials.findIndex((d) => d.id === currentDial.id);
  if (idx !== -1) dials[idx].call_notes = val;
  await syncTodaysCallLogSnapshot({ call_notes: val });
  return true;
}

function wireCallNotesAutosave() {
  const notesEl = document.getElementById("d_call_notes_live");
  if (!notesEl || !currentDial) return;
  notesEl.addEventListener("blur", async () => {
    const ok = await flushCallNotes();
    if (ok) setNotesStatus(true, "Saved");
  });
}

// ---------------------------------------------------------------------------
// Lists (tabs)
// ---------------------------------------------------------------------------

async function loadLists() {
  // Admins can also read trashed tabs (see the "Deleted tabs" popup on the
  // Profile page), so this filters them out explicitly rather than relying
  // on RLS alone.
  const { data, error } = await supabase.from("dial_lists").select("*").is("deleted_at", null).order("sort_order", { ascending: true });
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

// On a computer the tab row would be a wall of tabs, so only the most recently created ones show (plus whichever
// tab is open) with a "More tabs" button at the end to reveal the rest. Phones keep every tab (their row scrolls).
const TAB_LIMIT = 12;
let showAllTabs = false;
// On a computer the row is always newest -> oldest (by when each tab was created), so the most recent tabs sit at
// the front and are always the ones visible; there is no manual reordering there.
function shownTabLists(filtered) {
  if (isMobileViewport()) return filtered;
  const newestFirst = [...filtered].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (showAllTabs || newestFirst.length <= TAB_LIMIT) return newestFirst;
  const keep = new Set(newestFirst.slice(0, TAB_LIMIT).map((l) => l.id));
  if (currentListId) keep.add(currentListId);
  return newestFirst.filter((l) => keep.has(l.id));
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
    els.dialTabs.innerHTML = `<span class="help-text">${simpleUi ? "No lists yet." : "No lists yet — tap + to create one."}</span>`;
  } else {
    const shown = shownTabLists(filtered);
    const hiddenCount = filtered.length - shown.length;
    els.dialTabs.innerHTML = shown
      .map((l) => {
        const isActive = l.id === currentListId;
        return `
        <div class="dial-tab-wrap">
          <button type="button" class="dial-tab ${isActive ? "active" : ""}" data-id="${l.id}">${escapeHtml(l.name)}</button>
        </div>`;
      })
      .join("");
    if (hiddenCount > 0 || (showAllTabs && !isMobileViewport() && filtered.length > TAB_LIMIT)) {
      els.dialTabs.insertAdjacentHTML(
        "beforeend",
        `<button type="button" class="dial-tab-more" id="dialTabMoreBtn">${hiddenCount > 0 ? `More tabs (${hiddenCount})` : "Show fewer"}</button>`
      );
      els.dialTabs.querySelector("#dialTabMoreBtn").addEventListener("click", () => {
        showAllTabs = hiddenCount > 0;
        renderTabs();
      });
    }
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
  if (!window.__staleCallsSwept) { window.__staleCallsSwept = true; supabase.rpc("close_my_stale_calls").then(() => {}, () => {}); }   // a call row left open by a closed page / dead phone is closed here (once the call is 2h old)
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

els.dialTabSeqBtn.addEventListener("click", async () => {
  if (!archiveMenuTabId) return;
  const list = allLists.find((l) => l.id === archiveMenuTabId);
  closeArchiveMenu();
  if (list) await runSequenceSetupFlow(list, loadLists);
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
      // Soft delete: the tab and its dials move to the admin-only "Deleted
      // tabs" popup on the Profile page (see js/deletedTabs.js), where they
      // can be restored or permanently deleted.
      const { error } = await supabase.rpc("trash_dial_list", { p_list_id: tabId });
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
  let query = supabase.from("profiles").select("id, full_name, role").order("full_name", { ascending: true });
  if (isTeamLead) {
    query = query.or(`role.eq.admin,and(role.in.(intern,independent_lead),team_id.in.(${teamIdsOf(profile).join(",")})),id.eq.${profile.id}`);
  }
  if (isOwnTab) query = query.neq("id", profile.id);
  const { data, error } = await query;

  if (error) {
    els.dialTabTransferList.innerHTML = `<div class="dial-tab-transfer-empty">Couldn't load accounts.</div>`;
    return;
  }
  const targets = withoutAi(data);
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
    const ROLE = { admin: "admin", team_lead: "team lead", intern: "intern", independent_lead: "independent lead" };
    const option = (p) => `<button type="button" class="dial-tab-transfer-option" data-id="${p.id}" data-name="${escapeHtml(p.full_name || "")}"><span>${escapeHtml(p.full_name)}${p.id === profile.id ? " (you)" : ""}</span><small>${ROLE[p.role] || ""}</small></button>`;
    const searchHTML = otherTargets.length > 6 ? `<input type="search" class="dial-tab-transfer-search" placeholder="Search people" aria-label="Search people" autocomplete="off">` : "";
    els.dialTabTransferList.innerHTML = `${searchHTML}<div class="dial-tab-transfer-confirm hidden"></div><div class="dial-tab-transfer-opts">${ownerHTML}${otherTargets.length ? otherTargets.map(option).join("") : `<div class="dial-tab-transfer-empty">No other accounts yet.</div>`}</div>`;
    const confirmBox = els.dialTabTransferList.querySelector(".dial-tab-transfer-confirm");
    const optsBox = els.dialTabTransferList.querySelector(".dial-tab-transfer-opts");
    els.dialTabTransferList.querySelector(".dial-tab-transfer-search")?.addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      optsBox.querySelectorAll(".dial-tab-transfer-option").forEach((b) => { b.hidden = !!q && !b.dataset.name.toLowerCase().includes(q); });
    });
    // Two steps so a stray tap never hands a whole tab to the wrong person.
    optsBox.querySelectorAll(".dial-tab-transfer-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        optsBox.classList.add("hidden"); confirmBox.classList.remove("hidden");
        confirmBox.innerHTML = `<div>Send this tab to <b>${escapeHtml(btn.dataset.name)}</b>? They get all its leads.</div><div class="dial-tab-transfer-confirm-btns"><button type="button" class="btn secondary" data-no>Cancel</button><button type="button" class="btn secondary" data-yes>Send</button></div>`;
        confirmBox.querySelector("[data-no]").addEventListener("click", () => { confirmBox.classList.add("hidden"); optsBox.classList.remove("hidden"); });
        confirmBox.querySelector("[data-yes]").addEventListener("click", () => completeTransfer(btn.dataset.id, btn.dataset.name));
      });
    });
  }
}

async function completeTransfer(targetId, targetName) {
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

  // The recipient is notified by the database when the list changes hands (trigger dial_lists_notify_transfer).

  archiveMenuTabId = null;
  currentListId = null;
  showToast(`Sent to ${targetName || "them"}.`);
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
      if (!isMobileViewport()) return; // computer: tabs are always newest-first, so there is nothing to drag
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
  // The row may show only some tabs: the dragged order goes into the slots those tabs already held, so hidden tabs keep their place.
  const shownOrder = [...els.dialTabs.querySelectorAll(".dial-tab")].map((b) => b.dataset.id);
  const shownSet = new Set(shownOrder);
  let next = 0;
  const ids = filteredLists().map((l) => (shownSet.has(l.id) ? shownOrder[next++] : l.id));
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
    if (teamIdsOf(profile).length) {
      const { data: teamProfiles } = await supabase
        .from("profiles")
        .select("id")
        .in("team_id", teamIdsOf(profile))
        .or(`role.in.(intern,independent_lead),id.eq.${profile.id}`);
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
  // Buyer attachment is a seller-tab-only concept — see #newListBuyerRow's
  // own comment in dials.html — so a buyer-side tab never even shows the
  // picker, let alone populates it.
  const isBuyerTab = currentType === "buyer";
  els.newListBuyerRow.classList.toggle("hidden", isBuyerTab);
  if (!isBuyerTab) populateBuyerSelect(els.newListBuyerSelect);
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
    .insert({
      name,
      dial_type: currentType,
      status: currentStatus,
      sort_order: sortOrder,
      // The picker doesn't exist for a buyer-side tab at all (hidden, see
      // els.addTabBtn's click handler) — reading its value regardless would
      // just be whatever a PRIOR seller-tab creation left selected in the
      // still-live DOM element, not a real choice made for this tab.
      buyer_id: currentType === "seller" ? els.newListBuyerSelect.value || null : null,
    })
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
    updateDialTabClientBtnVisibility();
    els.settingsMenu.classList.add("hidden");
    els.pageSettingsBtn.classList.remove("open");
    // Force renderTabs() to pick a fresh default tab for the new side
    // instead of trying to keep whatever tab id was active before (which
    // almost certainly doesn't belong to this side at all).
    currentListId = null;
    await loadLists();
  }, { popup: isAdmin });
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

const importWizard = createImportWizard({
  container: document.getElementById("importDialsPreview"),
  profile, isTeamLead, teamIdsOf,
  getMandate: () => importMandate.get(), type: () => currentType,
  listNames: () => new Set(allLists.filter((l) => l.dial_type === currentType && !l.deleted_at).map((l) => (l.name || "").trim().toLowerCase())),
  onChange: (s) => {
    els.importDialsImportBtn.disabled = !s.readyFiles || s.loading || !s.rows;
    els.importDialsImportBtn.textContent = s.rows ? `Import ${s.rows.toLocaleString("en-US")} lead${s.rows === 1 ? "" : "s"}` : "Import";
  },
});

function openImportDialsModal() {
  els.importDialsError.classList.add("hidden");
  els.importDialsFileName.textContent = "";
  els.importDialsImportBtn.disabled = true;
  els.importDialsImportBtn.textContent = "Import";
  els.importDialsFileInput.value = "";
  importWizard.clear();
  els.importDialsModal.classList.remove("hidden");
  resetImportResult();
  importMandate = mountMandatePicker(els.importDialsImportBtn.parentNode);
  // Same seller-tab-only buyer attachment as els.addTabBtn's click handler
  // above.
  const isBuyerTab = currentType === "buyer";
  els.importDialsBuyerRow.classList.toggle("hidden", isBuyerTab);
  if (isBuyerTab) importMandate.hide();
  else populateBuyerSelect(els.importDialsBuyerSelect);
  importWizard.loadAssignees();
}

// ---- email-sequence additions to the import flow (see js/copyReview.js) ----
let importMandate = { get: () => null, set() {}, hide() {}, flagMissing() {} };
function resetImportResult() {
  document.getElementById("importDialsResult")?.remove();
  els.importDialsImportBtn.classList.remove("hidden");
  els.importDialsCancelBtn.textContent = "Cancel";
}

els.importDialsBuyerSelect.addEventListener("change", () => {
  const sel = els.importDialsBuyerSelect;
  const m = defaultMandateForBuyer(sel.options[sel.selectedIndex]?.textContent);
  if (m) importMandate.set(m);
});
els.menuImportBtn.addEventListener("click", () => {
  closePageHeaderMenu();
  openImportDialsModal();
});
els.importDialsCancelBtn.addEventListener("click", () => {
  if (importWizard.isBusy()) return; // an import is running: let it finish
  els.importDialsModal.classList.add("hidden");
});
els.importDialsModal.addEventListener("click", (e) => { if (e.target.closest(".cr-mandate-btn")) importWizard.refreshMailboxWarning(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.importDialsModal.classList.contains("hidden") && !importWizard.isBusy() && !document.querySelector("#noticeModal:not(.hidden)")) els.importDialsModal.classList.add("hidden");
});
// The visible "Choose CSV files" button just proxies to the real (hidden)
// file input (consistent look on desktop and mobile pickers). Shared by the
// input's change event AND a drag-and-drop onto #importDialsDropzone.
function setSelectedImportFiles(files) {
  const csvFiles = files.filter((f) => /\.(csv|tsv|txt)$/i.test(f.name) || f.type === "text/csv");
  resetImportResult();
  if (csvFiles.length > MAX_IMPORT_FILES) {
    importWizard.clear();
    els.importDialsFileName.textContent = "";
    els.importDialsImportBtn.disabled = true;
    els.importDialsError.textContent = `Select ${MAX_IMPORT_FILES} CSV files or fewer at a time (${csvFiles.length} selected).`;
    els.importDialsError.classList.remove("hidden");
    return;
  }
  els.importDialsError.classList.add("hidden");
  els.importDialsFileName.textContent = csvFiles.length
    ? `${csvFiles.length} file${csvFiles.length === 1 ? "" : "s"} selected: ${csvFiles.map((f) => f.name).join(", ")}`
    : files.length ? "Those files are not CSVs. Export the sheet as CSV (File > Download > .csv) and choose that." : "";
  importWizard.setFiles(csvFiles);
}
els.importDialsChooseBtn.addEventListener("click", () => els.importDialsFileInput.click());
els.importDialsFileInput.addEventListener("change", () => {
  setSelectedImportFiles([...(els.importDialsFileInput.files || [])]);
});

// Drag-and-drop onto the dropzone (harmless on touch devices; the hint text is desktop-only, see css/style.css).
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
  if (!importWizard.summary().rows || importWizard.isBusy()) return;
  els.importDialsError.classList.add("hidden");
  const mandate = currentType === "buyer" ? null : importMandate.get();
  if (currentType !== "buyer" && !mandate) {
    importMandate.flagMissing();
    els.importDialsError.textContent = "Pick what this list is for: M&A or Data sales.";
    els.importDialsError.classList.remove("hidden");
    return;
  }
  els.importDialsImportBtn.disabled = true;
  els.importDialsCancelBtn.disabled = true;
  els.importDialsImportBtn.textContent = "Importing...";
  let out;
  try {
    out = await importWizard.run({
      type: currentType, mandate, buyerId: els.importDialsBuyerSelect.value || null,
      // sort_order is computed once up front and incremented locally so several new tabs land in file order.
      sortOrderStart: allLists.filter((l) => l.dial_type === currentType && l.status === "current").length,
    });
  } catch (err) {
    els.importDialsError.textContent = friendlyMsg(err) || "Could not import that CSV.";
    els.importDialsError.classList.remove("hidden");
    els.importDialsCancelBtn.disabled = false;
    els.importDialsImportBtn.disabled = false;
    els.importDialsImportBtn.textContent = "Import";
    return;
  }
  els.importDialsCancelBtn.disabled = false;

  // Land on the last tab that is still mine (a list sent to someone else is no longer in this account).
  if (out.lastOwnId) {
    if (currentStatus !== "current") {
      currentStatus = "current";
      els.menuStatusBtn.querySelector(".menu-item-label").textContent = "Current";
      els.menuStatusBtn.dataset.status = "current";
      persistStatus();
    }
    currentListId = out.lastOwnId;
    persistCurrentListId();
  }
  if (out.lastId) await loadLists();

  const failed = out.results.filter((r) => r.error);
  if (failed.length) {
    els.importDialsError.textContent = `${failed.length} of ${out.results.length} file(s) not imported: ${failed.map((r) => `${r.file} (${r.error})`).join("; ")}. Re-select just those to try again.`;
    els.importDialsError.classList.remove("hidden");
  }
  // Show what happened (counts, who got it, how long) and let the person close it.
  importWizard.clear();
  resetImportResult();
  els.importDialsImportBtn.parentNode.parentNode.insertBefore(importWizard.renderResult(out), els.importDialsImportBtn.parentNode);
  els.importDialsImportBtn.classList.add("hidden");
  els.importDialsCancelBtn.textContent = "Done";
  els.importDialsFileInput.value = "";
  els.importDialsFileName.textContent = "";
});

// ---------------------------------------------------------------------------
// Select mode — bulk-select dials in the current tab to move to another
// tab, or delete. See the module-level selectMode/
// moveMode/selectedDialIds declared near the top of this file, and the
// selectMode branch inside renderDialsTable() for the selection-circle UI.
// ---------------------------------------------------------------------------

function enterSelectMode() {
  // Mutually exclusive with search — a filtered, ambiguous-looking list
  // during a bulk Select/Move/Delete is more confusing than helpful, so
  // starting one closes the other.
  exitSearchMode();
  selectMode = true;
  moveMode = false;
  selectedDialIds = new Set();
  els.selectModeBar.classList.remove("hidden");
  els.selectModeBar.scrollLeft = 0;
  // Mass email only exists while a Recommended first/second email is the
  // selected Advanced-settings option (team leads only).
  els.selectMassEmailBtn.classList.toggle("hidden", !selectedRecommendedEmailKind(profile));
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

// ---------------------------------------------------------------------------
// Search — filters the dials of every tab in this category by name, company
// name, email, or phone (see visibleDials above). Unlike Select/Move above,
// this isn't an exclusive "mode" with its own bulk actions — it's just a
// filter, so it has no outside-click-to-exit behavior; it stays open until
// the × is pressed or Select mode takes over (see enterSelectMode).
// ---------------------------------------------------------------------------

function enterSearchMode() {
  if (selectMode) exitSelectMode();
  els.dialsSearchBar.classList.remove("hidden");
  els.dialsSearchInput.focus();
}

function exitSearchMode() {
  dialSearchQuery = "";
  els.dialsSearchInput.value = "";
  els.dialsSearchBar.classList.add("hidden");
  if (searchPoolActive) {
    searchPoolActive = false;
    loadDials();
    return;
  }
  renderDialsTable();
}

document.getElementById("headerSearchBtn")?.addEventListener("click", (e) => { e.stopPropagation(); enterSearchMode(); });
els.menuSearchBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closePageHeaderMenu();
  enterSearchMode();
});

let searchPoolActive = false;
els.dialsSearchInput.addEventListener("input", async () => {
  dialSearchQuery = els.dialsSearchInput.value;
  const wanted = !!dialSearchQuery.trim();
  if (wanted && !searchPoolActive) {
    searchPoolActive = await loadSearchPool();
  } else if (!wanted && searchPoolActive) {
    searchPoolActive = false;
    await loadDials();
    return;
  }
  renderDialsTable();
});

els.dialsSearchCloseBtn.addEventListener("click", exitSearchMode);
// Enter in the search box opens the first match (type, Enter, the card is open)
els.dialsSearchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || selectMode || !dialSearchQuery.trim() || !visibleDials().length) return;
  e.preventDefault();
  openDialModal(0);
});

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

// ---------------------------------------------------------------------------
// Mass email — Select mode's 5th button, only shown while a Recommended
// first/second email is the selected Advanced-settings option. Confirms the
// email type + recipients WITH the time each one will go out, then queues
// them (scheduled_emails table).
//
// The emails are dripped out, not blasted: the first goes immediately, each
// next one a random 3-6 minutes after the previous. Because that can take
// hours for a big batch, the schedule lives in the database and is sent by a
// server job every minute (dispatch_scheduled_emails -> the email-send Edge
// Function, the same one Messages uses), so it keeps running with the tab
// closed or the phone locked. Each message is filed in the mailbox's real
// Sent folder and shows up under Messages -> Sent at the moment it goes out.
// Still-pending ones can be cancelled from this same popup.
// ---------------------------------------------------------------------------

const MASS_EMAIL_MIN_GAP_S = 180;
const MASS_EMAIL_MAX_GAP_S = 360;
let massPlan = null; // { send, mailbox, offsetsMs, sendAts|null, timer }

async function loadMyMailboxes() {
  const { data, error } = await supabase.from("email_accounts").select("id, email_address, label").eq("owner_id", profile.id);
  return error || !data ? [] : data;
}

function pickPrimaryMailbox(mailboxes) {
  if (!mailboxes.length) return null;
  return mailboxes.find((m) => (m.email_address || "").toLowerCase() === (profile.email || "").toLowerCase()) || mailboxes[0];
}

async function findPrimaryMailbox() {
  return pickPrimaryMailbox(await loadMyMailboxes());
}

function formatSendTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// First email immediately (offset 0), then each one 3-6 minutes after the
// previous — cumulative, so e.g. 0, 4, 9, 14 minutes.
function randomOffsetsMs(count) {
  const out = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (i > 0) t += (MASS_EMAIL_MIN_GAP_S + Math.floor(Math.random() * (MASS_EMAIL_MAX_GAP_S - MASS_EMAIL_MIN_GAP_S + 1))) * 1000;
    out.push(t);
  }
  return out;
}

// Picks which of the user's mailboxes sends each email, and enforces the
// per-mailbox daily cap (25 per rolling 24h — also enforced by the database
// and email-send). First emails ALTERNATE 1-and-1 between the user's
// mailboxes (primary first), skipping any mailbox that has hit its limit; if
// every mailbox is full the batch is refused. A follow-up (second email) has
// to go out from the mailbox that sent the first email — same thread, same
// From address — so it is pinned to that mailbox and counts against it.
// Mutates each item's `senderId`; returns { problems: string[] }.
async function assignSenders(send, mailboxes) {
  const problems = [];
  if (!mailboxes.length) return { problems: ["You need to connect an email to the app before you can send — go to Profile → Edit."] };
  const ordered = [pickPrimaryMailbox(mailboxes), ...mailboxes.filter((m) => m !== pickPrimaryMailbox(mailboxes))];
  const remaining = new Map();
  const used = new Map();
  let limit = 25;
  for (const mb of ordered) {
    const { data, error } = await supabase.rpc("mailbox_daily_quota", { p_account_id: mb.id });
    const q = Array.isArray(data) ? data[0] : data;
    if (error || !q) {
      remaining.set(mb.id, 25); // unknown — the database re-checks on insert regardless
      continue;
    }
    limit = q.daily_limit;
    remaining.set(mb.id, Math.max(0, q.daily_limit - q.sent - q.scheduled));
    used.set(mb.id, q.sent + q.scheduled);
  }
  const label = (id) => (mailboxes.find((m) => m.id === id) || {}).email_address || "this mailbox";

  // Pinned follow-ups first, so they aren't crowded out.
  const pinned = new Map();
  send.filter((x) => x.accountId).forEach((x) => pinned.set(x.accountId, (pinned.get(x.accountId) || 0) + 1));
  for (const [id, count] of pinned) {
    if (!remaining.has(id)) continue;
    const r = remaining.get(id);
    if (count > r) {
      problems.push(
        `Daily limit: follow-ups must go out from the mailbox that sent the first email, and ${label(id)} can only send ${r} more today (limit ${limit} per 24 hours, ${used.get(id) ?? "?"} used) — this batch needs ${count}. Select fewer dials.`
      );
    }
    remaining.set(id, Math.max(0, r - count));
  }

  // First emails: round-robin over mailboxes that still have room.
  let ptr = 0;
  let unassigned = 0;
  for (const item of send.filter((x) => !x.accountId)) {
    let picked = null;
    for (let step = 0; step < ordered.length; step++) {
      const idx = (ptr + step) % ordered.length;
      if ((remaining.get(ordered[idx].id) || 0) > 0) {
        picked = idx;
        break;
      }
    }
    if (picked === null) {
      unassigned += 1;
      continue;
    }
    item.senderId = ordered[picked].id;
    remaining.set(item.senderId, remaining.get(item.senderId) - 1);
    ptr = (picked + 1) % ordered.length;
  }
  if (unassigned) {
    const summary = ordered.map((m) => `${m.email_address} (${used.get(m.id) ?? "?"} of ${limit})`).join(", ");
    problems.push(
      `Daily limit: not enough room to send this batch — each mailbox can send at most ${limit} emails per 24 hours (${summary}). ${unassigned} email${unassigned === 1 ? "" : "s"} can't be sent. Select fewer dials.`
    );
  }
  return { problems };
}

function showMassEmailError(message) {
  els.massEmailProgress.classList.remove("hidden");
  els.massEmailProgress.style.color = "var(--danger)";
  els.massEmailProgress.textContent = message;
}

async function fetchPendingScheduled() {
  const { data } = await supabase
    .from("scheduled_emails")
    .select("id, to_address, body_text, send_at, status")
    .eq("created_by", profile.id)
    .in("status", ["pending", "sending"])
    .order("send_at", { ascending: true });
  return data || [];
}

// Works out, per selected dial, what Mass email would send or why it skips.
// First email: skipped if this address already got that subject (so running
// it twice never double-sends). Second email: a follow-up threaded onto the
// first email already sent to this address — skipped if the first was never
// sent, or if the follow-up already went out. Either kind is also skipped if
// the same message is already sitting in the schedule.
async function planMassEmail() {
  const send = [];
  const skipped = [];
  const pending = await fetchPendingScheduled();
  // Every automatic email ends "Thanks," + the first name of whoever is
  // sending it — the signed-in user — regardless of whose tab the dial sits in
  // (e.g. a team lead emailing from an intern's dial sheet) or which of their
  // mailboxes it goes out from.
  const signed = (body) => withSignoff(body, profile.full_name);
  const isQueued = (to, body) => pending.some((p) => (p.to_address || "").toLowerCase() === to.toLowerCase() && p.body_text === body);
  for (const d of dials.filter((x) => selectedDialIds.has(x.id))) {
    const r = resolveRecommendedEmail(profile, d);
    const name = dialDisplayName(d);
    if (!d.email) {
      skipped.push({ name, why: "no email address" });
      continue;
    }
    if (!r) {
      skipped.push({ name, why: "no email text imported" });
      continue;
    }
    const prior = await findPriorOutbound(d.email, r.baseSubject);
    const body = signed(r.body);
    if (isQueued(d.email, body)) {
      skipped.push({ name, why: "already scheduled" });
      continue;
    }
    if (!r.followUp) {
      if (!r.subject) skipped.push({ name, why: "no subject line" });
      else if (prior) skipped.push({ name, why: "first email already sent" });
      else send.push({ dialId: d.id, name, to: d.email, subject: r.subject, body });
      continue;
    }
    if (!prior) skipped.push({ name, why: "first email not sent yet" });
    else if (await followUpAlreadySent(prior.message_id)) skipped.push({ name, why: "follow-up already sent" });
    else
      send.push({
        dialId: d.id,
        name,
        to: d.email,
        subject: "Re: " + stripReplyPrefix(prior.subject),
        body,
        accountId: prior.account_id,
        inReplyTo: prior.message_id,
        threadId: prior.thread_id,
      });
  }
  return { send, skipped };
}

function stopMassEmailClock() {
  if (massPlan && massPlan.timer) {
    clearInterval(massPlan.timer);
    massPlan.timer = null;
  }
}

function closeMassEmailModal() {
  stopMassEmailClock();
  els.massEmailModal.classList.add("hidden");
  unlockPageScroll();
}

// "Sending" bullets: name, address, and the time it goes out. Until the user
// confirms, times are live (offset from right now, so what's shown is what
// they'll get if they confirm this second); after confirming they're frozen.
function renderMassEmailTimes() {
  if (!massPlan) return;
  const base = Date.now();
  els.massEmailList.querySelectorAll("[data-time-idx]").forEach((el) => {
    const i = Number(el.dataset.timeIdx);
    el.textContent = formatSendTime(massPlan.sendAts ? massPlan.sendAts[i] : base + massPlan.offsetsMs[i]);
  });
}

async function refreshMassEmailPendingBanner() {
  const pending = await fetchPendingScheduled();
  // Sends that failed in the last day (mail server refused, bad login, ...) —
  // otherwise a queued email failing later would go unnoticed.
  const { data: failed } = await supabase
    .from("scheduled_emails")
    .select("recipient_name, error")
    .eq("created_by", profile.id)
    .eq("status", "failed")
    .gte("send_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const failedList = failed || [];
  els.massEmailPending.classList.toggle("hidden", !pending.length && !failedList.length);
  els.massEmailCancelPendingBtn.classList.toggle("hidden", !pending.length);
  const parts = [];
  if (pending.length) {
    const last = Math.max(...pending.map((p) => new Date(p.send_at).getTime()));
    parts.push(`${pending.length} email${pending.length === 1 ? " is" : "s are"} still scheduled — last one goes out at ${formatSendTime(last)}.`);
  }
  if (failedList.length) {
    parts.push(`${failedList.length} failed in the last day: ${failedList.map((f) => `${f.recipient_name || "?"} (${f.error || "error"})`).join("; ")}.`);
  }
  els.massEmailPendingText.textContent = parts.join(" ");
}

els.massEmailCancelPendingBtn.addEventListener("click", async () => {
  els.massEmailCancelPendingBtn.disabled = true;
  els.massEmailProgress.style.color = "";
  const { error } = await supabase.from("scheduled_emails").update({ status: "cancelled" }).eq("created_by", profile.id).eq("status", "pending");
  els.massEmailCancelPendingBtn.disabled = false;
  if (error) return showError(els.errorBox, error);
  await refreshMassEmailPendingBanner();
  els.massEmailProgress.classList.remove("hidden");
  els.massEmailProgress.textContent = "Cancelled every email that hadn't gone out yet.";
});

els.selectMassEmailBtn.addEventListener("click", async () => {
  const kind = selectedRecommendedEmailKind(profile);
  if (!kind) return;
  if (!selectedDialIds.size) return showError(els.errorBox, new Error("Select at least one dial first."));
  els.selectMassEmailBtn.disabled = true;
  const { send, skipped } = await planMassEmail();
  els.selectMassEmailBtn.disabled = false;
  const mailboxes = await loadMyMailboxes();
  if (!mailboxes.length) return showError(els.errorBox, new Error("You need to connect an email to the app before you can send — go to Profile → Edit."));
  const assignment = await assignSenders(send, mailboxes);
  const emailOf = (id) => (mailboxes.find((m) => m.id === id) || {}).email_address || "";

  stopMassEmailClock();
  massPlan = { send, mailboxes, offsetsMs: randomOffsetsMs(send.length), sendAts: null, timer: null };

  // Which mailboxes will actually send, and how many each: "a@x (3), b@x (2)".
  const senderCounts = new Map();
  send.forEach((x) => {
    const id = x.accountId || x.senderId;
    if (id) senderCounts.set(id, (senderCounts.get(id) || 0) + 1);
  });
  const sendersText = [...senderCounts].map(([id, n]) => `${emailOf(id)} (${n})`).join(", ");

  els.massEmailTitle.textContent = kind === "second" ? "Send Recommended second email (follow-up)?" : "Send Recommended first email?";
  els.massEmailSummary.textContent = !send.length
    ? "None of the selected dials can be emailed."
    : (kind === "second"
        ? `The Recommended second email will go out as a follow-up reply to each dial's first email (same thread, from the mailbox that sent it)`
        : senderCounts.size > 1
          ? `The Recommended first email will go out alternating between your mailboxes — ${sendersText}`
          : `The Recommended first email will go out from ${sendersText || "your mailbox"}`) +
      `, one at a time — the first right away, then each one a random 3–6 minutes after the last. It keeps sending even if you close the app. Times:`;
  els.massEmailList.innerHTML = send
    .map(
      (x, i) =>
        `<li>${escapeHtml(x.name)} <span class="help-text" style="display:inline;">${escapeHtml(x.to)}${senderCounts.size > 1 ? ` · from ${escapeHtml(emailOf(x.accountId || x.senderId))}` : ""}</span> — <strong data-time-idx="${i}"></strong></li>`
    )
    .join("");
  els.massEmailSendingTitle.textContent = `Sending (${send.length}):`;
  els.massEmailSendingTitle.classList.toggle("hidden", !send.length);
  els.massEmailList.classList.toggle("hidden", !send.length);
  els.massEmailSkippedTitle.textContent = `Skipped (${skipped.length}):`;
  els.massEmailSkippedList.innerHTML = skipped
    .map((x) => `<li>${escapeHtml(x.name)} <span class="help-text" style="display:inline;">— ${escapeHtml(x.why)}</span></li>`)
    .join("");
  els.massEmailSkipped.classList.toggle("hidden", !skipped.length);
  els.massEmailProgress.classList.add("hidden");
  els.massEmailProgress.style.color = "";
  els.massEmailProgress.textContent = "";
  els.massEmailSendBtn.classList.toggle("hidden", !send.length);
  els.massEmailSendBtn.disabled = false;
  els.massEmailSendBtn.textContent = "Send";
  els.massEmailCancelBtn.textContent = "Cancel";
  renderMassEmailTimes();
  massPlan.timer = setInterval(renderMassEmailTimes, 1000);
  if (assignment.problems.length) showMassEmailError(assignment.problems.join(" "));
  refreshMassEmailPendingBanner();
  els.massEmailModal.classList.remove("hidden");
  lockPageScroll();
});

els.massEmailCancelBtn.addEventListener("click", () => {
  const scheduledNow = !!(massPlan && massPlan.sendAts);
  closeMassEmailModal();
  if (scheduledNow) exitSelectMode();
});

els.massEmailSendBtn.addEventListener("click", async () => {
  if (!massPlan || massPlan.sendAts || !massPlan.send.length) return;
  els.massEmailSendBtn.disabled = true;
  els.massEmailProgress.style.color = "";
  // Re-check with fresh numbers (another send may have used up a mailbox
  // since the popup opened) and re-pick senders before queueing anything.
  massPlan.send.forEach((x) => delete x.senderId);
  const { problems } = await assignSenders(massPlan.send, massPlan.mailboxes);
  if (problems.length) {
    els.massEmailSendBtn.disabled = false;
    return showMassEmailError(problems.join(" "));
  }
  const now = Date.now();
  const sendAts = massPlan.offsetsMs.map((o) => now + o);
  const rows = massPlan.send.map((x, i) => ({
    created_by: profile.id,
    account_id: x.accountId || x.senderId,
    dial_id: x.dialId,
    recipient_name: x.name,
    to_address: x.to,
    subject: x.subject,
    body_text: x.body,
    in_reply_to: x.inReplyTo || null,
    thread_id: x.threadId || null,
    send_at: new Date(sendAts[i]).toISOString(),
  }));
  const { error } = await supabase.from("scheduled_emails").insert(rows);
  if (error) {
    els.massEmailSendBtn.disabled = false;
    return showMassEmailError(error.message || "Couldn't schedule the emails.");
  }
  massPlan.sendAts = sendAts;
  stopMassEmailClock();
  renderMassEmailTimes();
  // Fire the first one now rather than waiting for the next once-a-minute
  // server pass (it's a no-op for anything not yet due).
  supabase.rpc("dispatch_scheduled_emails").then(() => {});
  els.massEmailProgress.classList.remove("hidden");
  els.massEmailProgress.textContent = `Scheduled ${rows.length} email${rows.length === 1 ? "" : "s"}, from ${formatSendTime(sendAts[0])} to ${formatSendTime(sendAts[sendAts.length - 1])}. They send automatically — you can close the app. Each one appears in Messages → Sent when it goes out.`;
  els.massEmailSendBtn.classList.add("hidden");
  els.massEmailCancelBtn.textContent = "Done";
  refreshMassEmailPendingBanner();
});

// Tapping anywhere outside the select-mode-bar and outside the dials list
// itself exits select mode (per spec). Clicks inside any modal (the bulk
// delete confirm or any other popup) are exempt — those manage their own
// dismissal and shouldn't also tear down select mode underneath them. The
// triangle button/menu and the settings gear button/menu are exempt too —
// real, confirmed bug: opening either while select mode was active used to
// immediately exit it (neither is inside selectModeBar or dialsTableWrap),
// hiding the selection bar the moment you tried to open Options. A tab tap
// while moveMode is active is also exempt — that's handled by
// wireTabInteractions' click handler (completeMoveToList), which itself
// calls exitSelectMode() when it's done.
document.addEventListener("click", (e) => {
  if (!selectMode) return;
  if (e.target.closest(".modal-backdrop")) return;
  if (els.selectModeBar.contains(e.target)) return;
  if (els.dialsTableWrap.contains(e.target)) return;
  if (e.target.closest("#pageMenuToggle") || els.pageHeaderMenu.contains(e.target)) return;
  if (e.target.closest("#pageSettingsBtn") || els.settingsMenu.contains(e.target)) return;
  if (moveMode && e.target.closest(".dial-tab")) return;
  exitSelectMode();
});

// ---------------------------------------------------------------------------
// Dials list (spreadsheet-like table)
// ---------------------------------------------------------------------------

// Same 5 columns renderDialsTable's real <table> uses (Name/Company/
// Location/Phone/Email) — see skeletonListHtml in js/placeholders.js.
const DIALS_SKELETON_COLUMN_WIDTHS = ["55%", "65%", "45%", "50%", "70%"];

// While a search is active the table shows matches from EVERY tab in this category (not just the selected one), so
// `dials` is swapped for the pooled rows of all those tabs; clearing the search reloads the selected tab's own rows.
async function loadSearchPool() {
  const ids = filteredLists().map((l) => l.id);
  if (!ids.length) return false;
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("dials").select("*").in("list_id", ids).order("id").range(from, from + 999);
    if (error) return false;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  dials = rows.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "", undefined, { sensitivity: "base" }));
  return true;
}

function searchTabName(d) {
  return allLists.find((l) => l.id === d.list_id)?.name || "";
}

// Dials home (Emails bar + one priority call sheet) — see js/dialsHome.js. The sheet replaces the plain list; leads/admins can
// switch to the plain list of every company from the page menu, and Search / Select mode always use the plain list.
let home = null;
let showAll = false;
const sheetMode = () => !showAll && !dialSearchQuery.trim() && !selectMode;
// Open a company's card from a list that is not the one on screen (Follow up now rows): prev/next stay within that set.
function openCardFrom(set, index) {
  if (index < 0 || !set[index]) return;
  currentDialSet = set; currentDialIndex = index; currentDial = set[index]; dialMode = "view";
  els.dialModalBackdrop.classList.remove("hidden");
  lockPageScroll();
  renderDialModal();
}

const loadFailedHTML = () => `<div class="empty-state dials-load-failed" role="alert"><p>Couldn't load this list. Nothing is lost.</p><button type="button" class="btn secondary" data-reload-dials>Retry</button></div>`;
els.dialsTableWrap.addEventListener("click", (e) => { if (e.target.closest("[data-reload-dials]")) loadDials(); });
async function loadDials() {
  if (dialSearchQuery.trim() && (await loadSearchPool())) {
    renderDialsTable();
    return;
  }
  if (!currentListId) {
    dials = [];
    renderDialsTable();
    return;
  }
  // Shown the instant a fetch starts (see placeholders.js) rather than
  // leaving the previous list's now-stale rows up, or a blank area, while
  // this one loads — replaced by the real render (or an empty-state
  // message, or the offline-cache fallback below) as soon as it resolves.
  els.dialsTableWrap.innerHTML = home && sheetMode() ? skeletonSheetHtml() : skeletonListHtml({ columnWidths: DIALS_SKELETON_COLUMN_WIDTHS });
  const cacheKey = "dials_" + currentListId;
  const { data, error } = await supabase.from("dials").select("*").eq("list_id", currentListId);
  if (error) {
    if (!isNetworkError(error)) { dials = []; dialsLoadFailed = true; renderDialsTable(); return; } // a retry state, never "all caught up"
    const cached = cacheGet(cacheKey);
    if (!cached) { dialsLoadFailed = true; renderDialsTable(); return hideOfflineNotice(); }
    dials = cached;
    showOfflineNotice(true);
    renderDialsTable();
    return;
  }
  hideOfflineNotice();
  dialsLoadFailed = false;
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
// Phone searches compare digits only, so "5024380520" finds "+1 (502) 438-0520" however the number was typed or imported.
// A search counts as a phone search when it holds at least 3 digits and nothing but phone punctuation (spaces + ( ) - . ) besides.
const phoneDigits = (s) => { const n = String(s || "").replace(/\D/g, ""); return n.length === 11 && n[0] === "1" ? n.slice(1) : n; };
function searchPhoneDigits(q) {
  if (!/^[\d\s+().\-]+$/.test(q)) return "";
  const n = phoneDigits(q);
  return n.length >= 3 ? n : "";
}

function visibleDials() {
  const q = dialSearchQuery.trim().toLowerCase();
  const qd = searchPhoneDigits(q);
  return dials.filter(
    (d) =>
      !hiddenStatuses.has(d.contact_status || "uncontacted") &&
      (!q ||
        (d.full_name || "").toLowerCase().includes(q) ||
        (d.company_name || "").toLowerCase().includes(q) ||
        (d.email || "").toLowerCase().includes(q) ||
        (d.mobile_phone || "").toLowerCase().includes(q) ||
        (d.company_phone || "").toLowerCase().includes(q) ||
        (qd && (phoneDigits(d.mobile_phone).includes(qd) || phoneDigits(d.company_phone).includes(qd))))
  );
}

// Updates the small "X prospects displayed" text next to the Dials heading —
// always reflects however many dials are actually visible right now in the
// selected tab, after the Categories filter (hiddenStatuses) is applied.
function updateProspectCount(count) {
  if (!els.dialsProspectCount) return;
  // In Select mode the header counts what's ticked instead of what's shown.
  if (selectMode) {
    const n = selectedDialIds.size;
    els.dialsProspectCount.textContent = `${n} prospect${n === 1 ? "" : "s"} selected`;
    return;
  }
  els.dialsProspectCount.textContent = "";
}

function renderDialsTable() {
  home?.refreshEmails();
  const sc = document.getElementById("dialsSearchCount");
  if (sc) { const q = dialSearchQuery.trim(); sc.classList.toggle("hidden", !q); if (q) { const n = visibleDials().length; sc.textContent = n === 1 ? "1 match" : `${n} matches`; } }
  if (dialsLoadFailed && currentListId) { els.dialsTableWrap.innerHTML = loadFailedHTML(); updateProspectCount(0); return; }
  if (home && sheetMode()) {
    home.renderSheet(!currentListId ? (simpleUi ? "No lists yet. Your team lead will add one." : "Nothing to call yet.")
      : dials.length === 0 ? (simpleUi ? "No companies in this list yet." : `No dials in this list yet — use the arrow next to "Dials" and tap "Add new".`) : "You're all caught up.");
    return;
  }
  if (!currentListId) {
    els.dialsTableWrap.innerHTML = `<div class="empty-state">${simpleUi ? "No lists yet. Your team lead will add one." : "Nothing to call yet."}</div>`;
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
    els.dialsTableWrap.innerHTML = dialSearchQuery.trim()
      ? `<div class="empty-state">No dials in any tab match "${escapeHtml(dialSearchQuery.trim())}".</div>`
      : `<div class="empty-state">Every dial in this list is hidden by the status filter above.</div>`;
    return;
  }

  // While select mode is active, instant-contact icons are replaced by a
  // plain selection circle (highlighted when that dial is selected), and a
  // matching empty header cell is added to the desktop table so the columns
  // still line up.
  const selectCircleHTML = (d) => `<div class="select-circle ${selectedDialIds.has(d.id) ? "selected" : ""}"></div>`;

  els.dialsTableWrap.innerHTML = `
    <table class="list-table">
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
          <tr class="clickable-row" role="button" tabindex="0" data-index="${i}" style="background:${statusInfo(d.contact_status).bg};">
            ${selectMode ? `<td>${selectCircleHTML(d)}</td>` : ""}
            <td data-label="Name">${escapeHtml(dialDisplayName(d))}${showAll ? seqBadgeHTML(d) : ""}</td>
            <td class="muted" data-label="Company">${escapeHtml(d.company_name || "—")}${searchPoolActive ? ` <span class="search-tab-tag">${escapeHtml(searchTabName(d))}</span>` : ""}</td>
            <td class="muted" data-label="Location">${escapeHtml(dialLocation(d))}</td>
            <td class="muted" data-label="Phone">${escapeHtml(d.mobile_phone || d.company_phone || "—")}</td>
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
        <div class="mobile-card clickable-row" role="button" tabindex="0" data-index="${i}" style="background:${statusInfo(d.contact_status).bg}; border-color:${statusInfo(d.contact_status).border};">
          <div class="mc-main">
            <div class="mc-name">${escapeHtml(dialDisplayName(d))}${showAll ? seqBadgeHTML(d) : ""}</div>
            <div class="mc-sub">${escapeHtml(dialCompanyAndLocation(d))}${searchPoolActive ? ` <span class="search-tab-tag">${escapeHtml(searchTabName(d))}</span>` : ""}</div>
          </div>
          ${
            selectMode
              ? selectCircleHTML(d)
              : contactActionIcons({
                  dialId: d.id,
                  linkedin: d.linkedin,
                  method: d.mobile_phone ? "mobile" : "company",
                  phone: d.mobile_phone || d.company_phone,
                  email: d.email,
                  personalizedEmailBody: resolveEmailBody(d),
                  personalizedEmailSubject: resolveEmailSubject(d),
                  personalizedTextingBody: resolvePersonalizedTextingBody(profile, d),
                })
          }
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
    // keyboard: Enter / Space on a focused row opens it, like the rows on the main sheet
    row.addEventListener("keydown", (e) => {
      if (e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      row.click();
    });
  });
  if (!selectMode) {
    stopContactActionPropagation(els.dialsTableWrap);
    wireQuickSendButtons(els.dialsTableWrap);
  }

  if (selectMode) {
    els.selectAllBtn.classList.toggle("active", visible.every((d) => selectedDialIds.has(d.id)));
  }
}

// ---------------------------------------------------------------------------
// Dial detail / create popup
// ---------------------------------------------------------------------------

// Personalized email, About us email and the team-lead Recommended first/
// second email are mutually exclusive (see selectEmailOption in
// js/advancedSettings.js — enforced both client-side and by a DB CHECK
// constraint), so at most one ever returns non-null — a plain OR picks
// whichever is actually on without needing to check which one first.
function resolveEmailBody(dial) {
  const recommended = resolveRecommendedEmail(profile, dial);
  if (recommended) return withSignoff(recommended.body, profile.full_name);
  return resolvePersonalizedEmailBody(profile, dial) || resolveAboutUsEmailBody(profile, dial);
}
function resolveEmailSubject(dial) {
  const recommended = resolveRecommendedEmail(profile, dial);
  if (recommended) return recommended.subject;
  return resolvePersonalizedEmailSubject(profile, dial) || resolveAboutUsEmailSubject(profile, dial);
}

// Company name / Industry sector / Website used to be seller-only boxes on
// a dial (currentType — the active Sellers/Buyers toggle, see
// js/dealSide.js) — buyer dials now show the exact same fields as seller
// dials (a buyer can have its own company/firm name and industry worth
// recording too), so buildDialViewHTML/buildDialEditHTML below no longer
// branch on isBuyer at all. The one deliberate exception is company name's
// REQUIRED-ness: still enforced for sellers, still optional for buyers —
// see getMissingDialClientFields further down, which is unchanged.
// createClientFromDial's own transfer-to-client step also still excludes
// company_name/industry for buyer-sourced clients (clientForm.js's buyer
// client form has no fields to show them in afterward) — that's a separate,
// narrower scope than this dial-level change.
function buildDialViewHTML(dial) {
  return `
    ${dial.mobile_phone || dial.company_phone ? "" : `<div class="help-text">No phone number. Tap the pencil to add one.</div>`}
    ${dialCallButtonsHTML(dial)}
    ${outcomeButtonsHTML(dial)}
    ${dial.email ? rfContact("Email", dial.email, "email", "", resolveEmailBody(dial), resolveEmailSubject(dial)) : ""}
    ${rfWebsite("LinkedIn", dial.linkedin)}
    ${rfWebsite("Website", dial.website)}
    ${rf("Industry sector", dial.industry)}
    ${rf("Summary", dial.summary)}
    <details class="dial-more">
      <summary>More</summary>
      ${buildCallNotesLiveHTML(dial)}
      ${buildCallbackHTML(dial)}
      ${buildDialTranscriptHTML()}
    </details>
  `;
}

// ---------------------------------------------------------------------------
// Calling + the five outcomes (docs/CRM_DESIGN.md §1). Big call buttons (one per number, labelled), then five outcome
// buttons that replace the old 7-option status pill for everyone; after one is saved the card moves on to the next row of
// the call sheet. Admins/team leads also keep the old status pill (to re-categorise or reset a company).
// ---------------------------------------------------------------------------
const simpleUi = !isAdmin && !isTeamLead; // interns (and independent leads): the slimmest card
const OUTCOME_CHIPS = [["callback_interested", "Talked – interested"], ["busy_callback", "Call back"], ["no_response", "No answer"], ["not_interested", "Not interested"], ["unable_to_contact", "Wrong / dead number"], ["intro_call_scheduled", "Intro call booked"]];
const OUTCOMES = [
  { status: "callback_interested", label: "Talked – interested", callback: true },
  { status: "busy_callback", label: "Call back", callback: true },
  { status: "no_response", label: "No answer" },
  { status: "not_interested", label: "Not interested" },
  { status: "unable_to_contact", label: "Wrong / dead number" },
];
function dialCallButtonsHTML(dial) {
  // Each number: the big in-app Call button plus a Text button (sms: link, with the personalized text if that setting is on).
  const btn = (num, method, label) =>
    `<div class="dial-call-line"><button type="button" class="btn dial-call-btn contact-action-call" data-dial-id="${escapeHtml(dial.id)}" data-tel="${escapeHtml(num)}" data-method="${method}"><b>${label}</b><span>${escapeHtml(num)}</span></button>` +
    `<a class="btn secondary dial-text-btn" href="${escapeHtml(buildSmsHref(num, resolvePersonalizedTextingBody(profile, dial)))}" title="Text ${escapeHtml(num)}">Text</a></div>`;
  const rows = [];
  if (dial.mobile_phone) rows.push(btn(dial.mobile_phone, "mobile", dial.mobile_phone_unsure ? "Call (may not be a mobile)" : "Call mobile"));
  if (dial.company_phone) rows.push(btn(dial.company_phone, "company", "Call office"));
  return rows.length ? `<div class="dial-call-row">${rows.join("")}</div>` : "";
}
function outcomeButtonsHTML(dial) {
  return `
    <div class="dial-outcomes" id="dialOutcomes">
      <div class="rf-label">How did it go?</div>
      ${OUTCOMES.map((o) => `<button type="button" class="btn dial-outcome ${dial.contact_status === o.status ? "current" : ""}" data-outcome="${o.status}">${o.label}</button>`).join("")}
      <button type="button" class="btn secondary dial-outcome dial-outcome-intro ${dial.contact_status === "intro_call_scheduled" ? "current" : ""}" data-outcome="intro_call_scheduled">Intro call booked</button>
    </div>`;
}
// Moves on to the next row of the call sheet (the order the card was opened from), or closes the card at the end.
async function advanceAfterOutcome() {
  if (currentDialIndex < currentDialSet.length - 1) await goToDial(1);
  else await closeDialModal();
}
function wireOutcomeButtons() {
  const wrap = document.getElementById("dialOutcomes");
  if (!wrap) return;
  wrap.querySelectorAll("[data-outcome]").forEach((b) => b.addEventListener("click", async () => {
    const value = b.dataset.outcome, dial = currentDial;
    wrap.querySelectorAll("button").forEach((x) => (x.disabled = true));
    if (value === "intro_call_scheduled" && dial.contact_status !== "intro_call_scheduled" && introInfoMissing(dial)) { renderDialModal(); return; } // asked BEFORE anything is saved
    const target = autodialTarget(value); // the Autodial setting (if on) still picks its own next company
    if (target) primeAudio();
    // Remember where the dial was, so backing out of the "Confirm the scheduled time" step can put it back.
    introRevert = value === "intro_call_scheduled" && dial.contact_status !== "intro_call_scheduled" ? snapIntro(dial) : null;
    const saved = await updateDialStatus(value);
    if (!saved) { // error shown by updateDialStatus; re-enable the buttons, then put the error back (the re-render clears it)
      const why = els.dialModalError.textContent;
      renderDialModal();
      els.dialModalError.textContent = `The outcome was not saved. Nothing changed, so tap it again.${why ? ` (${friendlyMsg(why).replace(/\s*(and )?press Retry\.?/i, "")})` : ""}`;
      els.dialModalError.classList.remove("hidden");
      els.dialModalError.scrollIntoView({ block: "nearest" });
      return;
    }
    if (value === "intro_call_scheduled") return handleScheduleIntroCallFromDial(dial); // the existing intro-call flow
    const def = OUTCOMES.find((o) => o.status === value);
    if (def?.callback) return openCallbackModal(dial, { after: target ? () => runAutodial(target) : advanceAfterOutcome }); // pick the time first
    if (target) { runAutodial(target); keepCardFocus(); return; }
    await advanceAfterOutcome();
    keepCardFocus();
  }));
}
// After an outcome moves the card on to the next company the old buttons are gone and focus falls to the page: put it on the new card's
// first outcome (or the card itself) so a keyboard user keeps their place. Anything the person focused meanwhile wins.
function keepCardFocus() {
  setTimeout(() => {
    const a = document.activeElement;
    if (a && a !== document.body && els.dialModalBackdrop.contains(a)) return;
    if (els.dialModalBackdrop.classList.contains("hidden")) return;
    const first = document.querySelector("#dialOutcomes [data-outcome]:not([disabled])");
    (first || els.dialModalBackdrop).focus?.({ preventScroll: true });
  }, 450);
}

// ---------------------------------------------------------------------------
// Callback time (dials.callback_at): a button under Call notes that opens a calendar + time picker. A set callback
// shows under "Callbacks for today" on Profile, as a banner at the top of the app, and as a push reminder 5 minutes
// before (server-side run_callback_reminders()). Tapping any of those opens this dial.
// ---------------------------------------------------------------------------
const CALLBACK_STATUSES = ["busy_callback", "callback_interested"];
function callbackLabel(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}
function buildCallbackHTML(dial) {
  const set = !!dial.callback_at;
  return `
    <div class="readonly-field">
      <div class="rf-label">Callback</div>
      <div class="callback-field">
        ${set ? `<span class="callback-field-time">${escapeHtml(callbackLabel(dial.callback_at))}</span>` : ""}
        ${set && dial.callback_defaulted ? `<span class="help-text">(default time)</span>` : ""}
        <button type="button" class="btn secondary" id="callbackSetBtn">${set ? "Change" : "Pick a callback time"}</button>
        ${set && !CALLBACK_STATUSES.includes(dial.contact_status) ? `<button type="button" class="btn secondary" id="callbackClearBtn">Clear</button>` : ""}
      </div>
    </div>`;
}
async function saveCallback(dial, iso) {
  const patch = iso ? { callback_at: iso, callback_user_id: profile.id, callback_reminded_at: null } : { callback_at: null, callback_user_id: null, callback_reminded_at: null };
  const { error } = await supabase.from("dials").update(patch).eq("id", dial.id);
  if (error) throw error;
  patch.callback_defaulted = false; // a time chosen by hand (the trigger records the same)
  Object.assign(dial, patch);
  if (currentDial?.id === dial.id) Object.assign(currentDial, patch);
  const idx = dials.findIndex((d) => d.id === dial.id);
  if (idx !== -1) Object.assign(dials[idx], patch);
  window.dispatchEvent(new Event("callbacks-changed")); // refreshes the top-of-app banners and Profile's list
}
function openCallbackModal(dial, { after } = {}) {
  const base = dial.callback_at ? new Date(dial.callback_at) : new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  els.callbackDateInput.value = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
  els.callbackTimeInput.value = `${pad(base.getHours())}:${pad(Math.round(base.getMinutes() / 5) * 5 % 60)}`;
  els.callbackTimeError.classList.add("hidden");
  const help = document.getElementById("callbackTimeHelp");
  if (help) help.textContent = dial.callback_defaulted
    ? "A reminder is already set for this time (the next business morning). Change it if they asked for a different time, or just press Save. Your own local time."
    : "Pick when to call them back. It shows on your call sheet, and you get a reminder 5 minutes before. Your own local time.";
  els.callbackTimeModal.classList.remove("hidden");
  const close = () => {
    els.callbackTimeModal.classList.add("hidden");
    els.callbackTimeSaveBtn.removeEventListener("click", onSave);
    els.callbackTimeCancelBtn.removeEventListener("click", onCancel);
  };
  const onCancel = () => { close(); if (after) after(); };
  const onSave = async () => {
    const date = els.callbackDateInput.value, time = els.callbackTimeInput.value;
    if (!date || !time) {
      els.callbackTimeError.textContent = "Pick both a date and a time.";
      els.callbackTimeError.classList.remove("hidden");
      return;
    }
    const when = new Date(`${date}T${time}`);
    if (Number.isNaN(when.getTime())) return;
    els.callbackTimeSaveBtn.disabled = true;
    try {
      await saveCallback(dial, when.toISOString());
      close();
      if (after) await after(); else renderDialModal();
    } catch (err) {
      els.callbackTimeError.textContent = err?.message || String(err);
      els.callbackTimeError.classList.remove("hidden");
    } finally {
      els.callbackTimeSaveBtn.disabled = false;
    }
  };
  els.callbackTimeSaveBtn.addEventListener("click", onSave);
  els.callbackTimeCancelBtn.addEventListener("click", onCancel);
}
document.addEventListener("click", async (e) => {
  const setBtn = e.target.closest?.("#callbackSetBtn");
  const clearBtn = e.target.closest?.("#callbackClearBtn");
  if ((!setBtn && !clearBtn) || !currentDial) return;
  if (setBtn) return openCallbackModal(currentDial);
  try { await saveCallback(currentDial, null); renderDialModal(); } catch (err) { showError(els.dialModalError, err); }
});

function buildDialEditHTML(dial) {
  return `
    <label for="d_full_name">Full name</label>
    <input id="d_full_name" value="${escapeHtml(dial.full_name)}" />
    <label for="d_company_name">Company name</label>
    <input id="d_company_name" value="${escapeHtml(dial.company_name)}" />
    <div class="form-row">
      <div><label for="d_city">City</label><input id="d_city" value="${escapeHtml(dial.city)}" /></div>
      <div>
        <label for="d_state">State</label>
        <select id="d_state">
          ${stateOptionsHTML(dial.state)}
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
    <label for="d_website">Website</label>
    <input id="d_website" value="${escapeHtml(dial.website)}" />
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
    full_name: document.getElementById("d_full_name").value.trim() || null,
    city: document.getElementById("d_city").value.trim() || null,
    // the select always carries the stored value (code mapped to its name, or an unmatched value as its own option), so null only means "cleared on purpose"
    state: document.getElementById("d_state").value || null,
    email: document.getElementById("d_email").value.trim() || null,
    mobile_phone: document.getElementById("d_mobile_phone").value.trim() || null,
    company_phone: document.getElementById("d_company_phone").value.trim() || null,
    linkedin: document.getElementById("d_linkedin").value.trim() || null,
    summary: document.getElementById("d_summary").value.trim() || null,
    // Company name / Industry / Website boxes are now on every dial's edit
    // form regardless of Sellers/Buyers (see buildDialEditHTML above), so
    // these just read straight off the DOM the same as every other field.
    industry: document.getElementById("d_industry").value.trim() || null,
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
        ${isViewingExisting ? seqPanelHTML(currentDial) : ""}
      </div>
      <div class="dial-modal-header-right">
        <div class="dial-modal-header-actions">
          ${
            isViewingExisting && !simpleUi
              ? `
          <div class="dial-status-dropdown">
            <button type="button" class="dial-status-btn" id="dialStatusBtn"
              style="background:${statusInfo(dial.contact_status).bg}; border-color:${statusInfo(dial.contact_status).border};" aria-label="Status: ${escapeHtml(statusInfo(dial.contact_status).label)}. Change" title="Change status">Status: ${escapeHtml(statusInfo(dial.contact_status).label)}</button>
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
            <button type="button" class="dial-schedule-intro-btn" id="scheduleIntroCallFromDialBtn">${isQuestionnaireDial(dial) ? "Intro call / form" : "Schedule intro call"}</button>
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
    wireSeqPanel(currentDial, (d) => {
      const i = dials.findIndex((x) => x.id === d.id);
      if (i >= 0) Object.assign(dials[i], { seq_state: d.seq_state, seq_stop_reason: d.seq_stop_reason });
      renderDialModal();
      renderDialsTable();
    });
  }
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
    if (statusBtn) statusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      statusMenu.classList.toggle("hidden");
    });
    if (statusMenu) document.addEventListener("click", () => statusMenu.classList.add("hidden"), { once: true });
    if (statusMenu) statusMenu.querySelectorAll(".dial-status-option").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const value = btn.dataset.value;
        const target = autodialTarget(value); // decided before the save so the right "next" dial is used
        if (target) primeAudio(); // unlock call audio inside this tap
        const saved = await updateDialStatus(value);
        if (saved && target) runAutodial(target);
      });
    });
  }

  els.dialModalError.classList.add("hidden");
  els.dialModalError.textContent = "";

  const fieldsHTML = dialMode === "edit" || isCreate ? buildDialEditHTML(dial) : buildDialViewHTML(dial);
  els.dialModalBody.innerHTML = fieldsHTML;
  stopContactActionPropagation(els.dialModalBody);
  wireQuickSendButtons(els.dialModalBody);

  if (dialMode === "edit" || isCreate) {
    els.dialModalActions.innerHTML = `
      <button type="button" class="btn" id="dialSaveBtn">Save</button>
      <button type="button" class="btn secondary" id="dialCancelBtn" data-esc-close>Cancel</button>
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
    // Esc presses this button (data-esc-close), so Esc in the edit form leaves only the form, and asks first when something was typed
    editBaseline = JSON.stringify(collectDialFormData());
    document.getElementById("dialCancelBtn").addEventListener("click", () => {
      if (JSON.stringify(collectDialFormData()) !== editBaseline && !window.confirm("Discard your changes to this company?")) return;
      dialMode = "view";
      renderDialModal();
    });
    const delBtn = document.getElementById("dialDeleteBtn");
    if (delBtn) delBtn.addEventListener("click", handleDeleteDial);
  } else {
    wireCallNotesAutosave();
    loadDialTranscript();
    wireOutcomeButtons();
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

let editBaseline = "";
// Saves only the fields this person changed, and refuses when another tab or device changed one of those same fields since this
// card was opened (the old save wrote all eleven fields back, so a stale tab silently undid the other tab's edit).
async function handleEditDialSave() {
  const all = collectDialFormData();
  const same = (a, b) => (a ?? null) === (b ?? null);
  const data = {};
  for (const k of Object.keys(all)) if (!same(all[k], currentDial[k])) data[k] = all[k];
  if (!Object.keys(data).length) { dialMode = "view"; renderDialModal(); return; }
  const { data: fresh } = await supabase.from("dials").select(Object.keys(data).join(",")).eq("id", currentDial.id).maybeSingle();
  if (fresh) {
    const clash = Object.keys(data).filter((k) => !same(fresh[k], currentDial[k]));
    if (clash.length) {
      els.dialModalError.textContent = "This company was changed on another screen while you were editing. Cancel, then open it again to see the latest, and make your change again.";
      els.dialModalError.classList.remove("hidden");
      return;
    }
  }
  // An imported number flagged "(Unsure)" (see rowsToDials) was never
  // confirmed as a mobile — changing the mobile number here is the user
  // stating what it is, so it goes back to the normal "(Mobile)" label.
  if ((data.mobile_phone || null) !== (currentDial.mobile_phone || null)) data.mobile_phone_unsure = false;
  const { error } = await supabase.from("dials").update(data).eq("id", currentDial.id);
  if (error) return showError(els.dialModalError, error);
  Object.assign(currentDial, data);
  // See syncTodaysCallLogSnapshot's comment — these are the same snapshot
  // fields autoMarkContacted() captures, kept in sync if they're corrected
  // through the edit form later the same day a call was already logged.
  const snap = {};
  for (const [col, key] of [["company_name", "company_name"], ["contact_name", "full_name"], ["website", "website"], ["city", "city"], ["state", "state"], ["industry", "industry"]]) if (key in data) snap[col] = data[key];
  if (Object.keys(snap).length) await syncTodaysCallLogSnapshot(snap);
  dialMode = "view";
  renderDialModal();
  await loadDials();
}

// Sets the dial's quick call-outcome status. Not part of the edit form —
// this is a standalone dropdown in the popup's header row that autosaves
// immediately, same pattern as the Call notes autosave. Changing this no
// longer affects the weekly call count — that's the separate per-contact-
// method check circles (see autoMarkContacted).
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
  // Picking a category no longer requires the dial to have been marked contacted first (interns calling from
  // their own phone often had no contact recorded yet). If it has no contact on record, one is recorded now
  // — on the number that would have been called — so the reports still count this company as contacted.
  // "uncontacted" itself asserts nothing, so it never records anything.
  if (newStatus !== "uncontacted") {
    const { count, error: historyError } = await supabase
      .from("call_status_changes")
      .select("id", { count: "exact", head: true })
      .eq("dial_id", currentDial.id);
    if (historyError) return showError(els.dialModalError, historyError);
    // Live counts a contact only when the company has no call history at all. A later-day sequence call by the dial's owner
    // is a new contact too: no row from this user today -> record one (autoMarkContacted writes the row and today's date).
    let needsContact = !count;
    if (count && currentDial.created_by === profile.id) {
      const { startIso, endIso } = localDayBoundsIso(todayDateStr());
      const { count: todayCount, error: tErr } = await supabase.from("call_status_changes").select("id", { count: "exact", head: true })
        .eq("dial_id", currentDial.id).eq("user_id", profile.id).gte("changed_at", startIso).lt("changed_at", endIso);
      if (tErr) return showError(els.dialModalError, tErr);
      needsContact = !todayCount;
    }
    if (needsContact) {
      const method = currentDial.mobile_phone ? "mobile" : currentDial.company_phone ? "company" : currentDial.email ? "email" : "mobile";
      await autoMarkContacted(currentDial, method);
    }
  }
  // A fresh arrival at "Accepted intro call" (switching in from some other
  // category — not just re-saving while already sitting in it) re-shows the
  // "Schedule intro call" button if a previous use had hidden it — see
  // renderDialModal's showScheduleIntroBtn and the success path in
  // openIntroCallTimeConfirmModal, which is what sets this flag true.
  const wasAlreadyIntroScheduled = currentDial.contact_status === "intro_call_scheduled";
  // A pending call task for this company is finished by the outcome. Done BEFORE the status update: a final status stops the
  // sequence, which would cancel the task before its outcome was recorded.
  const pendingTask = newStatus !== "uncontacted" ? home?.callTaskFor(currentDial.id) : null;
  let taskClosed = null;
  if (pendingTask) {
    const outcome = { no_response: "no_answer", unable_to_contact: "no_answer", busy_callback: "busy_callback", callback_interested: "talked_callback", not_interested: "not_interested", intro_call_scheduled: "intro_booked" }[newStatus] || newStatus;
    const { error: taskErr } = await supabase.rpc("complete_sequence_task", { p_task_id: pendingTask.id, p_outcome: outcome, p_note: null, p_skip: false });
    if (taskErr) { console.error("complete_sequence_task failed", taskErr); showToast("The follow-up task could not be closed. Refresh and check the task list.", "bad"); } else { home.taskDone(pendingTask.id); taskClosed = pendingTask.id; }
  }
  const data = { contact_status: newStatus };
  // The weekly survey's "Owners talked to" counts dials by called_today_date: stamp it when the outcome means an owner was reached
  // (also set by the dials_called_today trigger, 20261126b_called_today.sql).
  if (["not_interested", "callback_interested", "busy_callback", "intro_call_scheduled"].includes(newStatus)) data.called_today_date = todayDateStr();
  // The DB trigger dials_default_callback gives a callback status a default time (next business morning) and clears it when the
  // status leaves the callback categories; read the result back so the card and the time picker show what is saved.
  const { data: savedRows, error } = await supabase.from("dials").update(data).eq("id", currentDial.id).select("callback_at, callback_user_id, callback_defaulted");
  if (error) {
    // The task was closed just before the status update; if the update failed, put the task back so the call isn't lost.
    if (taskClosed) { await supabase.rpc("reopen_sequence_task", { p_task_id: taskClosed }); home?.refreshFollowups(); }
    return showError(els.dialModalError, error);
  }
  if (savedRows?.[0]) Object.assign(data, savedRows[0]);
  Object.assign(currentDial, data);
  const updatedDialId = currentDial.id;
  if (newStatus === "intro_call_scheduled" && !wasAlreadyIntroScheduled) {
    currentDial._scheduleIntroCallUsed = false;
  }
  // Recording rules: "Record accepted" keeps a call's recording only for Accepted intro call (any other category deletes it,
  // held and saved alike). "Record all calls" keeps it for every category except no_response / busy_callback (which only drop
  // the recordings still held in memory; ones already saved stay) and unable_to_contact (which drops held AND saved ones).
  const recAll = profile.record_all_calls === true;
  const recAccepted = !recAll && profile.record_accepted_calls !== false;
  const keepThis = recAll ? !["no_response", "busy_callback", "unable_to_contact"].includes(newStatus) : newStatus === "intro_call_scheduled";
  if (!keepThis) {
    discardRecordingsForDial(currentDial.id, { savedToo: !recAll || newStatus === "unable_to_contact" }).then(() => { if (!recAll && wasAlreadyIntroScheduled && currentDial?.id === updatedDialId) loadDialTranscript(); }, () => {});
  } else if ((recAll || recAccepted) && (recAll || !wasAlreadyIntroScheduled)) {
    const dialId = currentDial.id;
    keepRecordingForDial(profile, dialId, isCallActive()).then(
      (saved) => {
        if (!saved) return;
        showNotice("The recording of this call was saved. Find it under the dial's Transcript, where you can play it, copy a share link, or download it.", { title: "Recording saved" });
        if (currentDial?.id === dialId) loadDialTranscript();
      },
      (err) => showNotice(`The call recording couldn't be saved: ${err?.message || err}`, { title: "Recording not saved" })
    );
  }
  const idx = dials.findIndex((d) => d.id === currentDial.id);
  if (idx !== -1) Object.assign(dials[idx], data);
  await syncTodaysCallLogSnapshot({ contact_status_at_call: newStatus });
  // Also corrects the dial's most recent call(s) even when that call was on an
  // earlier day or was logged by someone else (a team lead re-categorizing an
  // intern's dial) — otherwise the buyer reports keep the old category for it.
  const { error: syncErr } = await supabase.rpc("sync_latest_call_status", { p_dial_id: currentDial.id, p_status: newStatus });
  if (syncErr) { console.error("sync_latest_call_status failed", syncErr); showToast("The outcome was saved, but the call log did not update. Reports may be off until you retry.", "bad"); }

  renderDialModal();
  renderDialsTable();
  return true;
}

// ---------------------------------------------------------------------------
// Autodial (setting in Dials > Advanced, js/autodial.js). The moment an outcome is chosen it:
//  1. calls a MOBILE twice in a row: "No answer" on the first try rings the same mobile once more before moving on;
//  2. opens the card of the company it is about to call;
//  3. works down the call sheet in its own order (Past due, Due today, Not called yet) and dials the number the
//     sequence step asks for: a "Call" step = the owner's mobile, a "Call company line" step = the office (each falls
//     back to the other number when one is missing). A company with no step due yet starts with its mobile.
// Never after "Accepted intro call" (the booking form is open) or a callback outcome (the time is picked first),
// and never while a call is still in progress.
// ---------------------------------------------------------------------------
let autoCall = null; // { dialId, method, phone, attempt }: the last call placed, and how many times in a row (see placeCall)

function sequenceNumber(d, kind) {
  const mobile = d.mobile_phone ? { phone: d.mobile_phone, method: "mobile" } : null;
  const office = d.company_phone ? { phone: d.company_phone, method: "company" } : null;
  return kind === "call_company" ? office || mobile : mobile || office;
}

function autodialTarget(newStatus) {
  if (!profile.autodial_enabled || !currentDial || dialMode !== "view") return null;
  if (newStatus === "intro_call_scheduled" || newStatus === "uncontacted" || isCallActive()) return null;
  if (newStatus === "no_response" && autoCall?.dialId === currentDial.id && autoCall.method === "mobile" && autoCall.attempt === 1)
    return { dial: currentDial, number: { phone: autoCall.phone, method: "mobile" }, attempt: 2 };
  return nextCallTarget(currentDial.id);
}

// The next company to call, skipping `skipId` (the one just finished).
function nextCallTarget(skipId) {
  if (home && sheetMode()) {
    const x = home.callQueue().find((q) => q.d.id !== skipId && sequenceNumber(q.d, q.kind));
    return x ? { dial: x.d, number: sequenceNumber(x.d, x.kind), attempt: 1 } : { none: true };
  }
  // "Show all companies" view (leads/admins): the next uncontacted company below this one, wrapping around.
  const list = visibleDials();
  const i = list.findIndex((d) => d.id === skipId);
  const after = i >= 0 ? [...list.slice(i + 1), ...list.slice(0, i)] : list;
  const next = after.find((d) => d.id !== skipId && (d.contact_status || "uncontacted") === "uncontacted" && (d.mobile_phone || d.company_phone));
  return next ? { dial: next, number: sequenceNumber(next, "call"), attempt: 1 } : { none: true };
}

// "Next company" in the call bar: same order and same numbers, whether or not Autodial is on.
function nextCompanyTarget() {
  return currentDial ? nextCallTarget(currentDial.id) : null;
}

function runAutodial(target) {
  if (target.none) {
    showNotice("Nothing more is due. Check Callbacks, or pick another list.", { title: "Autodial" });
    return;
  }
  const d = target.dial, num = target.number || sequenceNumber(d, home?.callTaskFor(d.id)?.kind);
  if (!num) return;
  const set = visibleDials(), idx = set.findIndex((x) => x.id === d.id);
  if (idx >= 0) openCardFrom(set, idx); else openCardFrom([d], 0); // a follow-up from another tab is not in this list's array
  if (target.attempt === 2) showToast("No answer. Calling the mobile a second time.");
  placeCall(d, num.phone, num.method);
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
  home?.refreshFollowups();
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

// Re-entrancy guard — a fast swipe or a spammed arrow key/button used to be
// able to fire a SECOND goToDial() while the first one's animation was still
// mid-flight. Both calls manipulate the same .dial-modal element's inline
// transform/opacity across their own independent 180ms waits with nothing
// serializing them, so their writes could interleave in whatever order the
// two setTimeouts happened to resolve in — real, confirmed symptom: the
// modal settling off-center (visually "stuck" toward one edge) instead of
// landing back at transform: none. Blocking a new swipe outright while one
// is already in progress removes the interleaving entirely, same pattern as
// contactCheckToggleInFlight above.
let dialSwipeInFlight = false;

async function goToDial(delta) {
  if (dialSwipeInFlight) return;
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

  dialSwipeInFlight = true;
  try {
    // Save any notes typed but not yet blurred BEFORE swapping to the next
    // dial, and wait for it to finish before rendering — otherwise the
    // render below could land while that save is still in flight and
    // show/overwrite stale data for whichever dial is being left (see
    // flushCallNotes).
    await flushCallNotes();

    const modalBox = els.dialModalBackdrop.querySelector(".dial-modal");

    // Slide + fade the current content out in the direction being swiped
    // away from, then swap in the new dial, then slide + fade it in from
    // the opposite side — an actual swipe transition instead of an instant
    // snap (see .dial-modal's transition in css/style.css).
    if (modalBox) {
      modalBox.style.transform = delta > 0 ? "translateX(-28px)" : "translateX(28px)";
      modalBox.style.opacity = "0";
      await new Promise((resolve) => setTimeout(resolve, DIAL_SWIPE_MS));
    }

    currentDialIndex = newIndex;
    currentDial = currentDialSet[newIndex];
    renderDialModal();

    if (modalBox) {
      // Jump (no transition) to just off the opposite side, then release
      // back to centered/opaque — that release is what animates the "slide
      // in".
      modalBox.classList.add("dial-modal-jump");
      modalBox.style.transform = delta > 0 ? "translateX(28px)" : "translateX(-28px)";
      void modalBox.offsetWidth; // force reflow so the jump above isn't itself animated
      modalBox.classList.remove("dial-modal-jump");
      modalBox.style.transform = "";
      modalBox.style.opacity = "";
    }
  } finally {
    dialSwipeInFlight = false;
  }
}

els.dialPrevBtn.addEventListener("click", () => goToDial(-1));
els.dialNextBtn.addEventListener("click", () => goToDial(1));

document.addEventListener("keydown", (e) => {
  if (els.dialModalBackdrop.classList.contains("hidden")) return;
  // Arrow keys inside a field (or with Shift/Ctrl/Cmd held, i.e. moving or extending a text selection) are for
  // the text, not for flipping dials.
  if (e.target.closest?.("input, textarea, select, [contenteditable]") || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "ArrowLeft") goToDial(-1);
  if (e.key === "ArrowRight") goToDial(1);
});

// A swipe flips dials only when it is a quick, mostly-sideways flick that started outside a text field and
// didn't begin on selected text: a long-press, a drag of the selection handles, or a drag across text to select
// it (all of which move sideways too) must never flip, or nothing in a dial can be copied.
let touchStart = null;
els.dialModalBackdrop.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) { touchStart = null; return; }
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY, at: Date.now(), target: e.target, inField: !!e.target.closest?.("input, textarea, select, [contenteditable]") };
});
els.dialModalBackdrop.addEventListener("touchcancel", () => { touchStart = null; });
els.dialModalBackdrop.addEventListener("touchend", (e) => {
  const start = touchStart;
  touchStart = null;
  if (!start || start.inField) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - start.x;
  const dy = t.clientY - start.y;
  if (Math.abs(dx) <= 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // too short, or more up/down than sideways
  if (Date.now() - start.at > 500) return; // a slow drag is a selection gesture, not a swipe
  const sel = window.getSelection?.();
  // A swipe that starts on the selected text itself is the user adjusting the selection, not flipping.
  if (sel && !sel.isCollapsed && String(sel).trim() && start.target && sel.containsNode(start.target, true)) return;
  if (dx < 0) goToDial(1);
  else goToDial(-1);
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
// such field. Company name / Industry sector are shown on every dial's edit
// form now (see buildDialEditHTML), but deliberately stay required for
// sellers only, optional for buyers — a buyer's own company name is nice to
// have on file, not something to block scheduling an intro call over.
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
// Before "Intro call booked" is saved: a dial missing what a client needs is not flipped to Accepted. Returns true when it is blocked, after
// saying what is missing, with a button that opens the edit form right away.
function introInfoMissing(dial) {
  if (isQuestionnaireDial(dial)) return false;
  const { missing, labels } = getMissingDialClientFields(dial);
  if (!missing.length) return false;
  els.requiredPopupText.textContent = `Please fill out the missing information on this dial before booking an intro call: ${labels.join(", ")}. The outcome was not changed.`;
  els.requiredPopupFill?.classList.remove("hidden");
  els.requiredPopup.classList.remove("hidden");
  return true;
}
async function handleScheduleIntroCallFromDial(dial) {
  if (isQuestionnaireDial(dial)) {
    openQuestionnaireIntroPopup(dial);
    return;
  }
  const { missing, labels } = getMissingDialClientFields(dial);
  if (missing.length) {
    els.requiredPopupText.textContent = `Please fill out the missing information on this dial before scheduling an intro call: ${labels.join(", ")}.`;
    els.requiredPopup.classList.remove("hidden");
    return;
  }

  // Team leads/admins/independent leads also get "Intro completed during outreach" under the
  // Open Calendly button — for an intro call they already held live during
  // the outreach call itself, so there's nothing to book (see
  // openCompletedIntroReportModal below).
  const canReportDuringOutreach = profile.role === "team_lead" || profile.role === "admin" || profile.role === "independent_lead";
  els.introCallPopupBody.innerHTML = buildIntroCallFormHTML({ allowCompletedDuringOutreach: canReportDuringOutreach, allowManual: true });
  els.introCallPopup.classList.remove("hidden");
  wireIntroCallForm(els.introCallPopupBody, {
    profile,
    prefill: { full_name: dial.full_name || "", email: dial.email || "", client_type: currentType },
    onCalendlyClosed: async () => {
      els.introCallPopup.classList.add("hidden");
      openIntroCallTimeConfirmModal(dial);
    },
    // Calendly not set up, or the time was agreed on the phone: enter it by hand (same confirm step, same records).
    onManual: () => {
      els.introCallPopup.classList.add("hidden");
      openIntroCallTimeConfirmModal(dial, { manualIntro: true });
    },
    onCompletedDuringOutreach: () => {
      els.introCallPopup.classList.add("hidden");
      openCompletedIntroReportModal(dial);
    },
  });
}

// Builds the new client record from a dial's info — split out of
// handleScheduleIntroCallFromDial above so openIntroCallTimeConfirmModal can
// call it itself once the real scheduled date/time/timezone is known,
// instead of this running the moment Calendly opens (see that function's own
// top comment for why the client is deliberately created this late).
// A booked intro call keeps the call's recording even when the dial was ALREADY "Accepted intro call" beforehand — in
// that case the status handler (updateDialStatus) treats the call as a follow-up and skips the save, so the booking
// itself is what saves it. Does nothing for accounts with recording off, or when no recording is being held.
function keepRecordingForBookedIntro(dial) {
  if (profile.record_all_calls !== true && profile.record_accepted_calls === false) return;
  const dialId = dial.id;
  keepRecordingForDial(profile, dialId, isCallActive()).then(
    (saved) => {
      if (!saved) return;
      showNotice("The recording of this call was saved. Find it under the dial's Transcript, where you can play it, copy a share link, or download it.", { title: "Recording saved" });
      if (currentDial?.id === dialId) loadDialTranscript();
    },
    (err) => showNotice(`The call recording couldn't be saved: ${err?.message || err}`, { title: "Recording not saved" })
  );
}

// Creates the client for a booked intro call (see createClientRecordFromDial) and saves the call's recording.
async function createClientFromDial(dial) {
  const client = await createClientRecordFromDial(dial);
  keepRecordingForBookedIntro(dial);
  return client;
}

async function createClientRecordFromDial(dial) {
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
  // overrode it. Company name / Industry still don't transfer for a buyer
  // dial even though both are now collected on one (see buildDialEditHTML)
  // — deliberately scoped narrower than that: clientForm.js's buyer branch
  // has no fields to show them in afterward, so transferring them here
  // would just be writing data nowhere in the app could ever display or
  // edit again post-conversion.
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
  // FK-less snapshot (see the matching comment in autoMarkContacted())
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
// modal is actually confirmed. Cancel / Esc puts the dial back to its status from before the tap. The booking is already
// made in Calendly regardless, so reopening this dial's "Schedule intro call" again later
// to finish recording it.
// Guards #introCallTimeConfirmBtn against accumulating more than one live
// click listener if this modal is ever opened again before a previous
// open's listener was cleaned up — see the matching fix in introCall.js
// (activeOnMessage) for the actual root cause this pairs with. Only the
// LATEST open's listener should ever be able to fire; without this, a click
// on Confirm re-runs every still-attached one, each independently creating
// its own client + intro_call event for what was really only one booking.
let introCallTimeConfirmCleanup = null;
let introRevert = null; // { id, status, callback_*}: the dial's status AND callback time before "Intro call booked" was tapped (the status flip clears the callback)
function snapIntro(dial) {
  return { id: dial.id, status: dial.contact_status || "uncontacted", callback_at: dial.callback_at || null, callback_user_id: dial.callback_user_id || null, callback_defaulted: dial.callback_defaulted ?? null };
}

// "Intro call booked" was tapped but no time was saved (time step cancelled, or the chooser closed): put the dial back to what it was.
// The dials_intro_booked trigger removes the placeholder client when the status leaves "Accepted intro call".
async function revertIntroStatus(dialArg) {
  const back = introRevert;
  introRevert = null;
  const dial = dialArg || (back && (dials.find((d) => d.id === back.id) || (currentDial?.id === back.id ? currentDial : null)));
  if (!back || !dial || back.id !== dial.id || dial.contact_status !== "intro_call_scheduled") return;
  // restore the promised callback time in the same update (the status flip had cleared it, and a time was agreed with the owner)
  const restore = { contact_status: back.status };
  if (back.callback_at) Object.assign(restore, { callback_at: back.callback_at, callback_user_id: back.callback_user_id, callback_defaulted: back.callback_defaulted ?? false });
  const { error } = await supabase.from("dials").update(restore).eq("id", dial.id);
  if (error) return showToast("The status could not be set back. Change it from the outcome buttons.", "bad");
  const idx = dials.findIndex((d) => d.id === dial.id);
  for (const target of [dial, idx !== -1 ? dials[idx] : null, currentDial?.id === dial.id ? currentDial : null]) if (target) Object.assign(target, restore);
  renderDialModal(); renderDialsTable();
  window.dispatchEvent(new Event("callbacks-changed"));
  showToast("No time was saved, so the intro call is not booked.");
}

function openIntroCallTimeConfirmModal(dial, { onConfirmed, manualIntro = false } = {}) {
  introCallTimeConfirmCleanup?.();
  introCallTimeConfirmCleanup = null;

  const modal = els.introCallTimeModal;
  const dateInput = els.introCallTimeDateInput;
  const timeSelect = els.introCallTimeSelect;
  const tzSelect = els.introCallTimeZoneSelect;
  const errEl = els.introCallTimeError;
  const confirmBtn = els.introCallTimeConfirmBtn;

  // No date is pre-filled (a default of "today" is how calls ended up backdated): the rep must pick the real day. Past days are
  // refused unless "This call already happened" is ticked.
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  dateInput.min = today.toISOString().slice(0, 10);
  dateInput.value = "";
  // Prefill what we already know: a callback time the owner agreed to (only when it is still ahead). The rep confirms or changes it.
  let guess = "";
  const cbAt = introRevert?.id === dial.id && introRevert.callback_at ? introRevert.callback_at : dial.callback_at;   // captured before the status flip cleared it
  if (cbAt && Date.parse(cbAt) > Date.now()) {
    const cb = new Date(cbAt), pad2 = (n) => String(n).padStart(2, "0");
    const mins = Math.round((cb.getHours() * 60 + cb.getMinutes()) / 30) * 30;
    if (mins >= 7 * 60 && mins <= 19 * 60) { dateInput.value = `${cb.getFullYear()}-${pad2(cb.getMonth() + 1)}-${pad2(cb.getDate())}`; guess = `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`; }
  }
  const pastOk = document.getElementById("introCallPastOk");
  if (pastOk) { pastOk.checked = false; pastOk.onchange = () => { dateInput.min = pastOk.checked ? "" : today.toISOString().slice(0, 10); }; }
  timeSelect.innerHTML = timeOptionsHTML(guess, { includeNoTime: false });
  tzSelect.innerHTML = timezoneOptionsHTML(defaultTimezone());
  errEl.classList.add("hidden");
  const prefillNote = document.getElementById("introCallPrefillNote");
  if (prefillNote) prefillNote.classList.toggle("hidden", !guess);

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
    const eventDateIso = zonedTimeToUtcIso(val, time, timezone);
    const allowPast = !!pastOk?.checked;
    if (!allowPast && new Date(eventDateIso).getTime() < Date.now() - 5 * 60 * 1000) {
      errEl.textContent = "That time has already passed. If the call already happened, tick \"This call already happened\".";
      errEl.classList.remove("hidden");
      return;
    }
    // Questionnaire flow (see openQuestionnaireIntroPopup): just hand the
    // chosen time back — the client is created later, from that popup.
    if (onConfirmed) {
      onConfirmed({ val, time, timezone, eventDate: eventDateIso, pastOk: allowPast });
      cleanup();
      return;
    }
    confirmBtn.disabled = true;
    errEl.classList.add("hidden");
    try {
      if (!createdClient) {
        createdClient = await createClientFromDial(dial);
      }
      // Updates the pending intro event the status change already created (or adds one); the database writes the Profile
      // "Intro calls" credit and notifies the team. One event per client, never a second.
      const { error } = await supabase.rpc("set_intro_call_time", {
        p_client_id: createdClient.id, p_dial_id: dial.id, p_event_date: eventDateIso, p_time: time, p_timezone: timezone,
        p_via: manualIntro ? "manual" : "calendly", p_past_ok: allowPast,
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
    cancelBtn?.removeEventListener("click", onCancel);
    modal.removeEventListener("click", onBackdrop);
    document.removeEventListener("keydown", onKey);
    introCallTimeConfirmCleanup = null;
  };
  // Cancel / Esc / tap outside: nothing was saved, so the dial goes back to what it was before "Intro call booked" was tapped.
  const onCancel = async () => {
    cleanup();
    if (!createdClient && !onConfirmed) await revertIntroStatus(dial);
  };
  const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
  const onKey = (e) => { if (e.key === "Escape") onCancel(); };
  const cancelBtn = document.getElementById("introCallTimeCancelBtn");
  confirmBtn.addEventListener("click", onConfirmClick);
  cancelBtn?.addEventListener("click", onCancel);
  modal.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onKey);
  introCallTimeConfirmCleanup = cleanup;
}

// ---------------------------------------------------------------------------
// Questionnaire-flow buyer's tabs (the one buyer whose sellers are companies
// we source DATA from — see clients.tracking_flow in js/clients.js). On these
// dials "Intro call / form" opens a short qualifying form first (js/intakeForm.js,
// saved on dials.intake_form), then — once it passes — the buyer's own calendar
// (see openQuestionnaireIntroPopup below).
// ---------------------------------------------------------------------------
let questionnaireBuyerIds = new Set();
try {
  const { data } = await supabase.rpc("get_questionnaire_buyer_ids");
  questionnaireBuyerIds = new Set(data || []);
} catch {
  // best-effort — dials just fall back to the normal intro call flow
}
function isQuestionnaireDial(dial) {
  if (currentType !== "seller" || !questionnaireBuyerIds.size) return false;
  const buyerId = allLists.find((l) => l.id === dial.list_id)?.buyer_id;
  return !!buyerId && questionnaireBuyerIds.has(buyerId);
}

// "Intro call / form" on one of those dials: the short qualifying form first (js/intakeForm.js). It is saved on
// the dial either way. Once every check passes, "Schedule intro call" opens the buyer's calendar and the time
// is then entered here like any other intro call — which creates the client with the intro call booked.
async function saveDialIntake(dial, values) {
  // Merged into what is already saved: the submission popup stores each step as it is finished (form answers plus
  // "_" step flags), and a later step must never wipe an earlier one.
  const patch = { intake_form: { ...(dial.intake_form || {}), ...values } };
  const email = (values.contact_email || "").trim();
  if (email && email !== (dial.email || "")) patch.email = email; // "email on record": the dial's email follows the form
  const { error } = await supabase.from("dials").update(patch).eq("id", dial.id);
  if (error) throw error;
  Object.assign(dial, patch);
  const idx = dials.findIndex((d) => d.id === dial.id);
  if (idx !== -1) Object.assign(dials[idx], patch);
  if (currentDial?.id === dial.id) Object.assign(currentDial, patch);
}

function openQuestionnaireIntroPopup(dial) {
  openSubmissionPopup({
    dial,
    rep: profile?.full_name || "",
    data: { ...(dial.intake_form || {}), contact_email: dial.email || dial.intake_form?.contact_email || "" },
    // Each step saves the moment it is finished, so closing the popup and coming back picks up where it left off.
    onPersist: async (patch) => {
      await saveDialIntake(dial, patch);
      renderDialModal();
      renderDialsTable();
    },
    // All three steps are done: create the client with the intro call already booked.
    onSubmit: async (values, sched) => {
      let client = null;
      try {
        client = await createClientFromDial(dial);
        // The moment the client exists, the lead goes to Slack and the leads sheet (company info + the form's
        // few answers) — before the intro call is filed, so a problem filing it can't hold the lead back.
        const delivery = await sendLeadToSheetAndSlack(client.id, values);
        const problem = describeDelivery(delivery);
        if (problem) showNotice(`The client was created, but the lead wasn't fully sent: ${problem}`, { title: "Lead not fully sent" });
        const { error: introErr } = await supabase.rpc("set_intro_call_time", {
          p_client_id: client.id, p_dial_id: dial.id, p_event_date: sched.eventDate, p_time: sched.time, p_timezone: sched.timezone,
          p_via: "calendly", p_past_ok: true, // the time modal already refused a past time unless "already happened" was ticked
        });
        if (introErr) throw introErr;
        // The form passed, so the client's Questionnaire step is done as of now (the Intro call step above is the
        // booked call, which stays open until it happens).
        const { data: haveQ } = await supabase.from("client_events").select("id").eq("client_id", client.id).eq("event_type", "questionnaire");
        if (!haveQ?.length) {
          const nowIso = new Date().toISOString();
          const { data: qEvent, error: qErr } = await supabase.from("client_events").insert({
            client_id: client.id, event_type: "questionnaire", created_by: profile.id, event_date: nowIso,
            details: { via: "form", category: "meeting" },
          }).select("id").single();
          if (qErr) throw qErr;
          const report = ["Questionnaire completed on the dial.",
            `• Employees: ${values.employees || "not given"}`, `• Years in business: ${values.years_in_business}`, `• Willing to sell their data: ${values.willing_to_sell}`,
            `• Able to sell their data: ${values.able_to_sell}`, `• Not talking to other brokers: ${values.no_other_brokers}`, `• Email: ${values.contact_email}`].join("\n");
          await supabase.rpc("set_client_event_confirmed", { p_event_id: qEvent.id, p_confirmed: true, p_report: report });
        }
        dial._scheduleIntroCallUsed = true;
        renderDialModal();
      } catch (err) {
        throw new Error(`${client ? "The client was created, but the" : "The"} intro call couldn't be saved: ${err?.message || err}. Press Submit client again to retry.`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// "Intro completed during outreach" (team leads/admins) — the intro call
// already happened live during the outreach call, so there's no Calendly
// booking to confirm. Asks when it happened (defaults to right now) and what
// was discussed, then — in one step, same as the Calendly path — creates the
// client from the dial, logs its first Timeline entry as an intro call, and
// marks that entry confirmed WITH the report text (exactly what pressing the
// Timeline's confirm circle and writing a report does — see
// confirmEventWithReport in js/clients.js), so the client opens with the
// intro call already reported. Also credits the Profile page's "Intro calls"
// tracker, same as a Calendly booking does. Cancel leaves nothing behind.
// ---------------------------------------------------------------------------
let completedIntroCleanup = null;

function openCompletedIntroReportModal(dial) {
  completedIntroCleanup?.();
  completedIntroCleanup = null;

  const modal = els.introCompletedModal;
  const dateInput = els.introCompletedDateInput;
  const timeSelect = els.introCompletedTimeSelect;
  const tzSelect = els.introCompletedTimeZoneSelect;
  const reportInput = els.introCompletedReportInput;
  const errEl = els.introCompletedError;
  const saveBtn = els.introCompletedSaveBtn;
  const cancelBtn = els.introCompletedCancelBtn;

  // Defaults to right now: today's date and the latest 30-minute slot at or
  // before the current time, clamped into the picker's 7:00 AM-7:00 PM range.
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  dateInput.value = local.toISOString().slice(0, 10);
  const mins = Math.min(Math.max(now.getHours() * 60 + Math.floor(now.getMinutes() / 30) * 30, 7 * 60), 19 * 60);
  const defaultTime = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  timeSelect.innerHTML = timeOptionsHTML(defaultTime, { includeNoTime: false });
  tzSelect.innerHTML = timezoneOptionsHTML(defaultTimezone());
  reportInput.value = "";
  errEl.classList.add("hidden");
  modal.classList.remove("hidden");

  // Kept outside onSaveClick so a retry after a partial failure (e.g. the
  // event insert worked but confirming it didn't) picks up where it left
  // off instead of creating a second client/event for the same dial.
  let createdClient = null;
  let createdEventId = null;

  const onSaveClick = async () => {
    const val = dateInput.value;
    const time = timeSelect.value;
    const timezone = tzSelect.value;
    if (!val || !time) {
      errEl.textContent = "Please enter both a date and time.";
      errEl.classList.remove("hidden");
      return;
    }
    saveBtn.disabled = true;
    errEl.classList.add("hidden");
    try {
      if (!createdClient) createdClient = await createClientFromDial(dial);
      if (!createdEventId) {
        const { data: evId, error } = await supabase.rpc("set_intro_call_time", {
          p_client_id: createdClient.id, p_dial_id: dial.id, p_event_date: zonedTimeToUtcIso(val, time, timezone), p_time: time, p_timezone: timezone,
          p_via: "outreach", p_past_ok: true, // it already happened, so a past time is expected here
        });
        if (error) throw error;
        createdEventId = evId;
      }
      const { error: confirmErr } = await supabase.rpc("set_client_event_confirmed", {
        p_event_id: createdEventId,
        p_confirmed: true,
        p_report: reportInput.value.trim(),
      });
      if (confirmErr) throw confirmErr;
    } catch (err) {
      errEl.textContent = err.message || String(err);
      errEl.classList.remove("hidden");
      saveBtn.disabled = false;
      return;
    }
    saveBtn.disabled = false;
    // Same as the Calendly path: hides "Schedule intro call" on this dial now
    // that it's been used (see renderDialModal's showScheduleIntroBtn).
    dial._scheduleIntroCallUsed = true;
    renderDialModal();
    cleanup();
  };
  const onCancelClick = () => cleanup();
  const cleanup = () => {
    modal.classList.add("hidden");
    saveBtn.removeEventListener("click", onSaveClick);
    cancelBtn.removeEventListener("click", onCancelClick);
    completedIntroCleanup = null;
  };
  saveBtn.addEventListener("click", onSaveClick);
  cancelBtn.addEventListener("click", onCancelClick);
  completedIntroCleanup = cleanup;
}

els.requiredPopupOk.addEventListener("click", () => { els.requiredPopup.classList.add("hidden"); els.requiredPopupFill?.classList.add("hidden"); });
els.requiredPopupFill?.addEventListener("click", async () => {
  els.requiredPopup.classList.add("hidden"); els.requiredPopupFill.classList.add("hidden");
  if (currentDial) { await flushCallNotes(); dialMode = "edit"; renderDialModal(); }
});

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
        return error ? [] : withoutAi(data);
      }
      return loadTeamScopeAccounts(profile);
    },
    // Admin-only — groups the popup's account list under team section
    // labels (same real teams shown in the Teams popup) so an admin with
    // many accounts can tell them apart at a glance, rather than one long
    // alphabetical list. Team leads' own pool is already just themselves +
    // their interns, so grouping isn't offered there.
    getTeams: groupsByTeam(profile, isAdmin)
      ? async () => {
          const { data, error } = await supabase.from("teams").select("id, name").order("sort_order", { ascending: true });
          return error ? [] : withoutAi(data);
        }
      : undefined,
    onChange: renderTabs,
    escapeHtml,
  });
}

home = initDialsHome({
  profile,
  getList: () => allLists.find((l) => l.id === currentListId) || null,
  getDials: () => dials,
  loadFailed: () => dialsLoadFailed && !!currentListId,
  loadFailedHtml: () => loadFailedHTML(),
  openCard: openCardFrom,
  isSheet: sheetMode,
  isHidden: (d) => hiddenStatuses.has(d.contact_status || "uncontacted"),
  rowIcons: (d) => contactActionIcons({
    dialId: d.id, linkedin: d.linkedin, method: d.mobile_phone ? "mobile" : "company", phone: d.mobile_phone || d.company_phone, email: d.email,
    personalizedEmailBody: resolveEmailBody(d), personalizedEmailSubject: resolveEmailSubject(d), personalizedTextingBody: resolvePersonalizedTextingBody(profile, d),
  }),
  wireIcons: (root) => { stopContactActionPropagation(root); wireQuickSendButtons(root); },
});
// Page menu: leads/admins can see every company in the list instead of only Backup numbers; interns get the short menu.
if (isAdmin || isTeamLead) {
  els.menuShowAllBtn.classList.remove("hidden");
  els.menuShowAllBtn.addEventListener("click", () => {
    showAll = !showAll;
    els.menuShowAllLabel.textContent = showAll ? "Show call sheet" : "Show all companies";
    closePageHeaderMenu();
    renderDialsTable();
  });
} else {
  els.menuSelectBtn.classList.add("hidden");
  els.menuCategoriesBtn.classList.add("hidden");
}

// ?list=<id> (Admin > Campaigns > List details): open Calls on that list.
{
  const listLinkId = new URLSearchParams(window.location.search).get("list");
  if (listLinkId) {
    const { data: linked } = await supabase.from("dial_lists").select("id, dial_type, status, created_by").eq("id", listLinkId).is("deleted_at", null).maybeSingle();
    if (linked) {
      currentType = linked.dial_type;
      currentStatus = linked.status === "archived" ? "archived" : "current";
      currentListId = linked.id;
      // an admin's "Accounts visible" filter defaults to themselves: add the list's owner so the tab is shown
      const vis = getVisibleAccountIds();
      if (vis && linked.created_by && !vis.has(linked.created_by)) setVisibleAccountIds([...vis, linked.created_by]);
    }
    window.history.replaceState({}, "", "dials.html");
  }
}
await loadLists();

// ---------------------------------------------------------------------------
// Deep-link support: ?dial=<id> opens straight into that dial's detail popup
// — used by Messages' "click a participant's name" feature (see
// js/messages.js) to jump from an email straight to the matching dial.
// Unlike clients.html's own ?client= deep link, this has to first figure out
// which tab/side/current-vs-archived that dial actually lives under (a dial
// has no client_type of its own — dial_lists.dial_type is what decides
// seller/buyer), switch the page over to it, then reload before opening.
// Doesn't sync the Sellers/Buyers toggle's own displayed label if it has to
// flip sides — a minor cosmetic mismatch until next touched, not worth the
// extra plumbing for what should be a rare cross-side link.
// ---------------------------------------------------------------------------
const dialsDeepLinkParams = new URLSearchParams(window.location.search);
const deepLinkDialId = dialsDeepLinkParams.get("dial");
if (deepLinkDialId) {
  const { data: targetDial } = await supabase.from("dials").select("*").eq("id", deepLinkDialId).maybeSingle();
  if (targetDial?.list_id) {
    const { data: targetList } = await supabase.from("dial_lists").select("id, dial_type, status").eq("id", targetDial.list_id).maybeSingle();
    if (targetList) {
      currentType = targetList.dial_type;
      currentStatus = targetList.status === "archived" ? "archived" : "current";
      currentListId = targetList.id;
      await loadLists();
      await loadDials();
      currentDialSet = [targetDial];
      currentDialIndex = 0;
      currentDial = targetDial;
      dialMode = "view";
      els.dialModalBackdrop.classList.remove("hidden");
      lockPageScroll();
      renderDialModal();
    }
  }
  window.history.replaceState({}, "", "dials.html");
}
