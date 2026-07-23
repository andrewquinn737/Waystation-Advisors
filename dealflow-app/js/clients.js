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
import { rfContact, contactActionIcons, stopContactActionPropagation, locationPinLink, buildPhoneNumbersHTML } from "./contactIcons.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus as closePageHeaderMenu } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { buildIntroCallFormHTML, wireIntroCallForm } from "./introCall.js";
import { getDealSide, wireDealSideToggle } from "./dealSide.js";
import { getVisibleAccountIds, wireAccountsVisiblePopup, initDefaultToSelf } from "./accountsVisible.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;
const isAdmin = profile?.role === "admin";
// Team leads get the settings gear (Sellers/Buyers + Accounts visible) like
// admins do, but Accounts visible only ever lists their own teammates (see
// getAllAccounts below) — everything else gated on isAdmin alone (Contract
// advancement, etc.) stays admin-only; a team lead is otherwise treated like
// an intern.
const isTeamLead = profile?.role === "team_lead";
// First-ever use of the shared Accounts visible setting defaults to "just
// me" instead of "Select all" — a no-op every subsequent load (see
// js/accountsVisible.js).
initDefaultToSelf(profile.id);

const MONTH_NAMES = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "Categories" pipeline status (see the colored dropdown in
// buildClientViewHTML, and the Categories filter menu further down) — colored
// the same as dials' CONTACT_STATUSES, reusing those same CSS variables for
// every shade except "Sold" (light blue), which has no dials equivalent.
const CLIENT_STATUSES = [
  { value: "sold", label: "Sold", bg: "var(--status-sold-bg)", border: "var(--status-sold-border)", dot: "var(--status-sold-dot)" },
  { value: "connected_to_buyer", label: "Connected to buyer", bg: "var(--status-scheduled-bg)", border: "var(--status-scheduled-border)", dot: "var(--status-scheduled-dot)" },
  { value: "potentially_interested", label: "Potentially interested", bg: "var(--status-callback-bg)", border: "var(--status-callback-border)", dot: "var(--status-callback-dot)" },
  { value: "not_in_contact", label: "Not in contact", bg: "var(--status-no-response-bg)", border: "var(--status-no-response-border)", dot: "var(--status-no-response-dot)" },
  { value: "no_longer_interested", label: "No longer interested", bg: "var(--status-not-interested-bg)", border: "var(--status-not-interested-border)", dot: "var(--status-not-interested-dot)" },
];
function clientStatusInfo(value) {
  return CLIENT_STATUSES.find((s) => s.value === value) || CLIENT_STATUSES[3];
}

// The green "connected_to_buyer" category reads as "In cahoots" while
// viewing Buyer-side clients (a buyer isn't "connected to a buyer" — it's
// connected to a seller they're in cahoots with) — every other status/mode
// keeps its normal label. Used everywhere a status label is displayed
// instead of reading `s.label`/`info.label` directly.
function statusLabel(s) {
  if (s.value === "connected_to_buyer" && getDealSide() === "buyer") return "In cahoots";
  return s.label;
}

// Which pipeline statuses are currently hidden from the Clients list (toggled
// via the page-header triangle's Categories submenu) — persisted the same way
// as dials' hiddenStatuses.
const CLIENTS_STORAGE_KEYS = {
  hiddenStatuses: "waystation_clients_hidden_statuses",
};
const hiddenClientStatuses = new Set();
function loadPersistedClientsState() {
  try {
    const saved = localStorage.getItem(CLIENTS_STORAGE_KEYS.hiddenStatuses);
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr)) arr.forEach((v) => hiddenClientStatuses.add(v));
    }
  } catch {
    // ignore
  }
}
function persistHiddenClientStatuses() {
  try {
    localStorage.setItem(CLIENTS_STORAGE_KEYS.hiddenStatuses, JSON.stringify([...hiddenClientStatuses]));
  } catch {
    // ignore
  }
}
loadPersistedClientsState();

// The 7 fixed Progress-tab milestones — checked off (green check) once a
// client_events row with the matching event_type exists (see
// buildProgressHTML). Timeline's "+" add-menu offers exactly these same 7
// options, so logging one there is what flips its Progress dot.
const PROGRESS_STEPS = [
  { type: "intro_call", label: "Intro call" },
  { type: "client_meeting", label: "Client meeting" },
  { type: "client_approval", label: "Client approval" },
  { type: "nda_financials", label: "NDA + financials" },
  { type: "loi", label: "LOI" },
  { type: "due_diligence", label: "Due diligence" },
  { type: "close", label: "Close" },
];
// "general_meeting" and "task" are Timeline-only — they're logged the same
// way as the 7 PROGRESS_STEPS types, but deliberately excluded from that list
// so they never affect the Progress tab's checkmarks.
const EVENT_TYPE_LABELS = {
  created: "Client created",
  general_meeting: "Meeting",
  task: "Task",
  ...Object.fromEntries(PROGRESS_STEPS.map((s) => [s.type, s.label])),
};
const CHECK_SVG = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

// Right-side-up triangle shown next to a CONFIRMED event's title (see
// buildTimelineHTML/wireTimelineTab) — toggling it flips it upside down via
// the .expanded CSS class (rotate 180deg) and reveals the connected report
// box underneath. Collapsed = pointing up, expanded = pointing down.
const TRIANGLE_SVG = `<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M12 5 L20 19 L4 19 Z"/></svg>`;

// Timeline's "+" menu is a 2-level picker: a top-level category, then (for
// Meeting/Contract advancement) a specific sub-type shown as a dropdown in
// the same date/time details popup — see openEventDetailsModal. Contract
// advancement's sub-types are 5 of the 7 PROGRESS_STEPS (everything except
// Intro call and Client meeting, which live under Meeting instead — Intro
// call keeps the existing Calendly hand-off, Client meeting additionally
// requires picking a counterpart client, see openCounterpartPicker).
const TIMELINE_CATEGORIES = [
  { value: "meeting", label: "Meeting" },
  { value: "contract_advancement", label: "Contract advancement" },
  { value: "task", label: "Task" },
];
const MEETING_SUBTYPES = [
  { value: "general_meeting", label: "General" },
  { value: "intro_call", label: "Intro call" },
  { value: "client_meeting", label: "Client meeting" },
];
const CONTRACT_SUBTYPES = PROGRESS_STEPS.filter((s) => s.type !== "intro_call" && s.type !== "client_meeting");

// Every half hour, midnight to 11:30pm — the "choose a time (optional)"
// dropdown shared by every Timeline "+" category (see openEventDetailsModal).
function timeOptionsHTML() {
  const opts = ['<option value="">No time</option>'];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const label = new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      opts.push(`<option value="${value}">${label}</option>`);
    }
  }
  return opts.join("");
}

// Formats a "HH:MM" 24-hour value (see timeOptionsHTML) back into a
// locale-formatted time string, for display on a logged Timeline event.
function formatTimeValue(value) {
  const [hh, mm] = value.split(":").map(Number);
  return new Date(2000, 0, 1, hh, mm).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

let clients = [];
let currentClient = null; // null while creating a new client
let currentMode = "create"; // 'create' | 'view' | 'edit'
let currentSubTab = "profile"; // 'profile' | 'progress' | 'timeline' — view mode only
let currentClientEvents = []; // client_events rows for currentClient, newest-last

const els = {
  errorBox: document.getElementById("errorBox"),
  pageMenuToggle: document.getElementById("pageMenuToggle"),
  pageHeaderMenu: document.getElementById("pageHeaderMenu"),
  pageSettingsBtn: document.getElementById("pageSettingsBtn"),
  settingsMenu: document.getElementById("settingsMenu"),
  dealSideToggleBtn: document.getElementById("dealSideToggleBtn"),
  dealSideLabel: document.getElementById("dealSideLabel"),
  tableWrap: document.getElementById("tableWrap"),
  search: document.getElementById("search"),
  countBadge: document.getElementById("countBadge"),
  menuAddNewBtn: document.getElementById("menuAddNewBtn"),
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
  menuCategoriesBtn: document.getElementById("menuCategoriesBtn"),
  categoriesSubmenu: document.getElementById("categoriesSubmenu"),
  menuAccountsVisibleBtn: document.getElementById("menuAccountsVisibleBtn"),
  accountsVisiblePopup: document.getElementById("accountsVisiblePopup"),
  accountsVisibleBody: document.getElementById("accountsVisibleBody"),
  accountsVisibleClose: document.getElementById("accountsVisibleClose"),
  clientSubtabs: document.getElementById("clientSubtabs"),
  introCallPopup: document.getElementById("introCallPopup"),
  introCallPopupBody: document.getElementById("introCallPopupBody"),
  introCallPopupClose: document.getElementById("introCallPopupClose"),
  eventDateModal: document.getElementById("eventDateModal"),
  eventDateModalTitle: document.getElementById("eventDateModalTitle"),
  eventDateInput: document.getElementById("eventDateInput"),
  eventTimeInput: document.getElementById("eventTimeInput"),
  eventSubtypeWrap: document.getElementById("eventSubtypeWrap"),
  eventSubtypeSelect: document.getElementById("eventSubtypeSelect"),
  eventTaskWrap: document.getElementById("eventTaskWrap"),
  eventTaskInput: document.getElementById("eventTaskInput"),
  eventDateConfirmBtn: document.getElementById("eventDateConfirmBtn"),
  eventDateCancelBtn: document.getElementById("eventDateCancelBtn"),
  counterpartModal: document.getElementById("counterpartModal"),
  counterpartSearchInput: document.getElementById("counterpartSearchInput"),
  counterpartList: document.getElementById("counterpartList"),
  counterpartConfirmBtn: document.getElementById("counterpartConfirmBtn"),
  counterpartCancelBtn: document.getElementById("counterpartCancelBtn"),
  confirmDeleteTitle: document.getElementById("confirmDeleteTitle"),
  eventReportModal: document.getElementById("eventReportModal"),
  eventReportInput: document.getElementById("eventReportInput"),
  eventReportConfirmBtn: document.getElementById("eventReportConfirmBtn"),
  eventReportCancelBtn: document.getElementById("eventReportCancelBtn"),
  editEventModal: document.getElementById("editEventModal"),
  editEventDateInput: document.getElementById("editEventDateInput"),
  editEventTimeInput: document.getElementById("editEventTimeInput"),
  editEventReportWrap: document.getElementById("editEventReportWrap"),
  editEventReportInput: document.getElementById("editEventReportInput"),
  editEventSaveBtn: document.getElementById("editEventSaveBtn"),
  editEventDeleteBtn: document.getElementById("editEventDeleteBtn"),
  editEventCancelBtn: document.getElementById("editEventCancelBtn"),
};

els.introCallPopupClose.addEventListener("click", () => els.introCallPopup.classList.add("hidden"));

// `title` defaults to the original "Delete this client?" wording so the
// existing client-delete call site (handleDelete) doesn't need to change;
// the Timeline event-delete flow (openEditEventModal) passes its own.
function openConfirmDelete(onConfirm, title) {
  els.confirmDeleteTitle.textContent = title || "Delete this client?";
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
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("client_type", getDealSide())
    .order("created_at", { ascending: false });
  if (error) return showError(els.errorBox, error);
  clients = data || [];
  renderTable();
}

function renderTable() {
  const q = els.search.value.trim().toLowerCase();
  const visibleAccountIds = getVisibleAccountIds();
  const rows = clients.filter(
    (c) =>
      (!q ||
        clientDisplayName(c).toLowerCase().includes(q) ||
        (c.company_name || "").toLowerCase().includes(q) ||
        (c.industry || "").toLowerCase().includes(q)) &&
      !hiddenClientStatuses.has(c.pipeline_status || "not_in_contact") &&
      // Admin-only "Accounts visible" filter (now shared across Clients,
      // Dials, and Profile — see js/accountsVisible.js), applied before
      // Categories can hide/show anything further (see
      // renderCategoriesSubmenu). null means no account filter is active
      // (every account's clients pass through).
      (!visibleAccountIds || visibleAccountIds.has(c.created_by))
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
          <tr class="clickable-row" data-id="${c.id}" style="background:${clientStatusInfo(c.pipeline_status).bg};">
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
        <div class="mobile-card clickable-row" data-id="${c.id}" style="background:${clientStatusInfo(c.pipeline_status).bg}; border-color:${clientStatusInfo(c.pipeline_status).border};">
          <div class="mc-main">
            <div class="mc-name">${escapeHtml(clientDisplayName(c))}</div>
            <div class="mc-sub">${escapeHtml(clientCompanyAndLocation(c))}</div>
          </div>
          ${contactActionIcons({ phone: c.mobile_phone, email: c.email })}
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
// "Categories" filter — same submenu-of-colored-rectangles pattern as the
// Dials page's Categories button (js/dials.js renderCategoriesSubmenu /
// positionCategoriesSubmenu), just with the 5 client pipeline statuses.
// ---------------------------------------------------------------------------

function renderCategoriesSubmenu() {
  els.categoriesSubmenu.innerHTML = CLIENT_STATUSES.map(
    (s) => `
      <button type="button" class="category-rect-option ${hiddenClientStatuses.has(s.value) ? "is-hidden" : ""}" data-value="${s.value}">
        <span class="category-rect-swatch" style="background:${s.dot}; border-color:${s.border};"></span>${escapeHtml(statusLabel(s))}
      </button>`
  ).join("");
  els.categoriesSubmenu.querySelectorAll(".category-rect-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = btn.dataset.value;
      if (hiddenClientStatuses.has(v)) hiddenClientStatuses.delete(v);
      else hiddenClientStatuses.add(v);
      persistHiddenClientStatuses();
      renderCategoriesSubmenu();
      renderTable();
    });
  });
}
renderCategoriesSubmenu();

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
// "Accounts visible" filter — a single shared setting across Clients, Dials,
// and Profile (see js/accountsVisible.js), visible to admins and team leads.
// Requires clients_select_own to also allow is_admin()/is_team_lead_of() (see
// supabase/schema.sql) — otherwise the session could never fetch other
// accounts' clients in the first place, filter or no filter. The Categories
// filter above is applied on top of whatever this leaves in (see
// renderTable).
// ---------------------------------------------------------------------------

if (isAdmin || isTeamLead) els.menuAccountsVisibleBtn.classList.remove("hidden");

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
      // (same team_id) — never every account. Requires clients_select_own to
      // also allow is_team_lead_of() (see supabase/schema.sql), otherwise a
      // team lead's session could never fetch a teammate's clients in the
      // first place, filter or no filter.
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
    onChange: renderTable,
    escapeHtml,
  });
}

// ---------------------------------------------------------------------------
// Field sections — shared between "new client" and the Profile tab
// ---------------------------------------------------------------------------

function rf(label, value) {
  const v = value === null || value === undefined || value === "" ? "" : String(value);
  return `<div class="readonly-field"><div class="rf-label">${escapeHtml(label)}</div><div class="rf-value ${v ? "" : "empty"}">${v ? escapeHtml(v) : "Not provided"}</div></div>`;
}

// Adds an https:// scheme if the stored value doesn't already have one (a
// bare "linkedin.com/in/..." or "www.linkedin.com/..." typed into the field
// isn't a valid href on its own — clicking it would be treated as a relative
// link on this site instead of opening LinkedIn).
function normalizeUrl(value) {
  const v = String(value).trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

// Same shape as rf() but renders the value as an actual clickable link
// (opens in a new tab) instead of plain text — used for LinkedIn so pressing
// it takes you straight to the profile instead of just displaying the URL.
function rfLink(label, value) {
  const v = value === null || value === undefined || value === "" ? "" : String(value);
  const valueHTML = v
    ? `<a href="${escapeHtml(normalizeUrl(v))}" target="_blank" rel="noopener noreferrer">${escapeHtml(v)}</a>`
    : "Not provided";
  return `<div class="readonly-field"><div class="rf-label">${escapeHtml(label)}</div><div class="rf-value ${v ? "" : "empty"}">${valueHTML}</div></div>`;
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

// "Categories" pipeline-status dropdown — a colored rectangle button showing
// the current status that reveals a dropdown of all 5 on click, same visual
// component as the dial popup's status dropdown (js/dials.js), reusing its
// .dial-status-* classes directly rather than duplicating that CSS. Sits
// right below the header, above Location (see buildClientViewHTML) — the
// only thing shown in the Profile tab that isn't part of the editable form.
function categoryDropdownHTML(client) {
  const info = clientStatusInfo(client.pipeline_status);
  return `
    <div class="dial-status-dropdown client-status-dropdown">
      <button type="button" class="dial-status-btn" id="clientStatusBtn"
        style="background:${info.bg}; border-color:${info.border};">${escapeHtml(statusLabel(info))}</button>
      <div class="dial-status-menu hidden" id="clientStatusMenu">
        ${CLIENT_STATUSES.map(
          (s) => `
          <button type="button" class="dial-status-option" data-value="${s.value}">
            <span class="dial-status-dot" style="background:${s.dot}; border-color:${s.border};"></span>${escapeHtml(statusLabel(s))}
          </button>`
        ).join("")}
      </div>
    </div>`;
}

// Wires the category dropdown's open/close + option clicks — called after
// buildClientViewHTML's markup lands in the DOM (Profile tab only).
function wireCategoryDropdown() {
  const statusBtn = document.getElementById("clientStatusBtn");
  if (!statusBtn) return;
  const statusMenu = document.getElementById("clientStatusMenu");
  statusBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    statusMenu.classList.toggle("hidden");
  });
  document.addEventListener("click", () => statusMenu.classList.add("hidden"), { once: true });
  statusMenu.querySelectorAll(".dial-status-option").forEach((btn) => {
    btn.addEventListener("click", () => updateClientStatus(btn.dataset.value));
  });
}

async function updateClientStatus(newStatus) {
  const { error } = await supabase.from("clients").update({ pipeline_status: newStatus }).eq("id", currentClient.id);
  if (error) return showError(document.getElementById("clientModalError"), error);
  currentClient.pipeline_status = newStatus;
  const idx = clients.findIndex((c) => c.id === currentClient.id);
  if (idx !== -1) clients[idx].pipeline_status = newStatus;
  renderModalBody();
  renderTable();
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
    ${categoryDropdownHTML(client)}
    ${rfLocation(client)}
    ${rfContact("Email", client.email, "email")}
    ${buildPhoneNumbersHTML(client)}
    ${rfLink("LinkedIn", client.linkedin)}
    ${rf("Intern's name", client.intern_name)}
    ${rf("Industry sector", client.industry)}
    ${rf("Annual revenue", client.annual_revenue != null ? `$${Number(client.annual_revenue).toLocaleString()}` : "")}
    ${rf("Employees", client.employee_count)}
    ${rf("Founded", founded)}
    ${rf(lookingForLabel(client.client_type), client.looking_for)}
    ${rf("Notes", client.other_notes)}
  `;
}

// ---------------------------------------------------------------------------
// Progress tab — vertical stepper of the 7 fixed milestones (PROGRESS_STEPS),
// each checked off green only once a client_events row with the matching
// event_type has actually been confirmed (checked off) on the Timeline tab —
// see the timeline-confirm-btn / toggleClientEventConfirmed. Merely logging
// the event via Timeline's "+" menu is NOT enough on its own; it also has to
// be marked as happened before the Progress dot reflects it.
// ---------------------------------------------------------------------------
function buildProgressHTML(events) {
  const doneTypes = new Set(events.filter((e) => e.confirmed).map((e) => e.event_type));

  // "Buyers/Sellers met with" — the counterpart names from every CONFIRMED,
  // not-in-the-future Client meeting (see logClientMeeting/openCounterpartPicker
  // in the Timeline section above), filling the empty space below the
  // stepper. A seller's clients met with buyers, so its label/list names
  // buyers, and vice versa — each name deep-links straight into that
  // counterpart's own Timeline (see wireProgressMetWith below).
  const metWithLabel = currentClient?.client_type === "seller" ? "Buyers met with" : "Sellers met with";
  const metWithEvents = events.filter(
    (e) => e.event_type === "client_meeting" && e.confirmed && !isFutureDate(e.event_date) && e.details?.counterpart_name && e.details?.counterpart_client_id
  );
  const metWithListHTML = metWithEvents.length
    ? metWithEvents
        .map(
          (e) => `
        <button type="button" class="progress-met-with-chip" data-client-id="${e.details.counterpart_client_id}">
          ${escapeHtml(e.details.counterpart_name)}
        </button>`
        )
        .join("")
    : `<div class="empty-state">None yet.</div>`;

  return `
    <div class="progress-stepper" id="progressStepper">
      ${PROGRESS_STEPS.map((s) => {
        const done = doneTypes.has(s.type);
        return `
          <div class="progress-step ${done ? "done" : ""}">
            <div class="progress-step-dot">${done ? CHECK_SVG : ""}</div>
            <div class="progress-step-label">${escapeHtml(s.label)}</div>
          </div>`;
      }).join("")}
    </div>
    <div class="progress-met-with">
      <h3 class="progress-met-with-title">${escapeHtml(metWithLabel)}</h3>
      <div class="progress-met-with-list">${metWithListHTML}</div>
    </div>
  `;
}

// Deep-links a "Buyers/Sellers met with" chip straight into that counterpart
// client's own Timeline tab (fetched directly, same as the ?client= deep-link
// support near the end of this file, since the counterpart may belong to a
// different account or be the opposite buyer/seller side).
function wireProgressMetWith() {
  document.querySelectorAll(".progress-met-with-chip[data-client-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { data } = await supabase.from("clients").select("*").eq("id", btn.dataset.clientId).maybeSingle();
      if (data) await openDetailModal(data, "timeline");
    });
  });
}

// Replaces the old single full-height rail with short connector segments
// drawn only BETWEEN each pair of adjacent dots (nothing above the first dot
// or below the last one). Positions are measured from the real rendered
// layout (getBoundingClientRect) rather than assumed from CSS math, since
// .progress-step-dot is an absolutely-positioned flex child whose exact
// vertical center depends on flexbox's own alignment math — measuring is far
// more robust than trying to replicate that math here. Called once right
// after the Progress tab's HTML is inserted into the DOM (see
// renderModalBody), inside requestAnimationFrame so layout has settled.
function positionProgressConnectors() {
  const stepper = document.getElementById("progressStepper");
  if (!stepper) return;
  requestAnimationFrame(() => {
    stepper.querySelectorAll(".progress-connector").forEach((el) => el.remove());
    const stepperRect = stepper.getBoundingClientRect();
    const dots = Array.from(stepper.querySelectorAll(".progress-step-dot"));
    for (let i = 0; i < dots.length - 1; i++) {
      const a = dots[i].getBoundingClientRect();
      const b = dots[i + 1].getBoundingClientRect();
      const top = a.bottom - stepperRect.top;
      const height = b.top - a.bottom;
      if (height <= 0) continue;
      const connector = document.createElement("div");
      connector.className = "progress-connector";
      connector.style.top = `${top}px`;
      connector.style.height = `${height}px`;
      connector.style.left = `${a.left - stepperRect.left + a.width / 2}px`;
      stepper.appendChild(connector);
    }
  });
}

// ---------------------------------------------------------------------------
// Timeline tab — vertical event feed + a "+" FAB that logs one of the same 7
// milestones (or opens the shared Schedule Intro Call form for "Intro call"
// specifically, same as the Dials page's flow).
// ---------------------------------------------------------------------------
function timelineEventDateStr(e) {
  const d = new Date(e.event_date);
  const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  // The optional 30-min-increment time chosen in openEventDetailsModal is
  // stored as a "HH:MM" string in details.time (separate from event_date's
  // own noon-anchored timestamp — see openEventDetailsModal) — appended here
  // when present.
  return e.details?.time ? `${dateStr}, ${formatTimeValue(e.details.time)}` : dateStr;
}

// What shows on the Timeline row's 2nd line — normally just the type label,
// but a Client meeting names its counterpart (see openCounterpartPicker /
// logClientMeeting) and a Task shows its own description instead of the
// generic "Task" label.
function eventTypeDisplay(e) {
  if (e.event_type === "client_meeting" && e.details?.counterpart_name) {
    return `Client meeting with ${e.details.counterpart_name}`;
  }
  if (e.event_type === "task" && e.details?.task_description) {
    return e.details.task_description;
  }
  return EVENT_TYPE_LABELS[e.event_type] || e.event_type;
}

// True if the event's calendar date (in the viewer's local timezone) is
// later than today — a future-dated Timeline entry that hasn't happened yet.
// Compared by calendar day, not exact timestamp, since event_date may be
// stamped at noon (manually-chosen dates, see openEventDateModal) or at the
// exact moment of scheduling (Intro call via Calendly) — either way, "today"
// should never count as future.
function isFutureDate(dateStr) {
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() > today.getTime();
}

function buildTimelineHTML(events) {
  // Newest first — most recent milestone at the top of the feed. Since
  // future-dated events sort above today/past ones, they end up clustered
  // together at the top, letting the divider below sit at a single clean
  // boundary rather than needing to be threaded between scattered items.
  const sorted = [...events].sort((a, b) => new Date(b.event_date) - new Date(a.event_date));
  const futureFlags = sorted.map((e) => isFutureDate(e.event_date));
  const hasFuture = futureFlags.some(Boolean);
  const hasPastOrToday = futureFlags.some((f) => !f);
  // Only meaningful (and only rendered) when both groups exist — see the
  // "only visible when future events exist" requirement. futureFlags is
  // guaranteed future-then-non-future in order (both blocks are internally
  // sorted by date), so the last `true` is exactly the boundary.
  const lastFutureIndex = hasFuture && hasPastOrToday ? futureFlags.lastIndexOf(true) : -1;

  const itemsHTML = sorted
    .map((e, i) => {
      const future = futureFlags[i];
      const isCreated = e.event_type === "created";

      // "Client created" is auto-inserted and gets no controls at all — every
      // other event type was added manually via "+". Of those, all get the
      // edit (pencil) button — which itself now hosts the Delete option, see
      // openEditEventModal — and only today-or-past ones additionally get the
      // confirm-happened circle (future events haven't happened yet, so
      // there's nothing to confirm — see isFutureDate above).
      let actionsHTML = "";
      let triangleHTML = "";
      let reportBoxHTML = "";
      if (!isCreated) {
        const editBtn = `<button type="button" class="timeline-edit-btn" data-event-id="${e.id}" title="Edit event">&#9998;</button>`;
        const confirmBtn = future
          ? ""
          : `<button type="button" class="timeline-confirm-btn ${e.confirmed ? "confirmed" : ""}" data-event-id="${e.id}" data-confirmed="${e.confirmed ? "1" : "0"}" title="${e.confirmed ? "Mark as not happened" : "Mark as happened"}">${e.confirmed ? CHECK_SVG : ""}</button>`;
        actionsHTML = `<div class="timeline-box-actions">${editBtn}${confirmBtn}</div>`;

        // Triangle toggle + connected report box — only exist at all once the
        // event has been checked off (there's no report to show otherwise).
        // Both start collapsed/hidden on every fresh render (see
        // wireTimelineTab, which handles the expand/collapse purely in the
        // DOM afterward, no re-render needed).
        if (e.confirmed) {
          triangleHTML = `<button type="button" class="timeline-triangle-btn" data-event-id="${e.id}" title="Show report">${TRIANGLE_SVG}</button>`;
          reportBoxHTML = `<div class="timeline-report-box hidden" data-report-for="${e.id}">${escapeHtml(e.details?.report || "(No report written)")}</div>`;
        }
      }

      const beforeDivider = i === lastFutureIndex;
      const itemHTML = `
          <div class="timeline-item${beforeDivider ? " tl-before-divider" : ""}">
            <div class="timeline-dot"></div>
            <div class="timeline-line"></div>
            <div class="timeline-box">
              <div>
                <div class="tl-date">${escapeHtml(timelineEventDateStr(e))}</div>
                <div class="tl-title-row"><span class="tl-type">${escapeHtml(eventTypeDisplay(e))}</span>${triangleHTML}</div>
              </div>
              ${actionsHTML}
            </div>
            ${reportBoxHTML}
          </div>`;
      return beforeDivider ? itemHTML + `<div class="timeline-future-divider"></div>` : itemHTML;
    })
    .join("");

  const listHTML = sorted.length ? `<div class="timeline-list">${itemsHTML}</div>` : `<div class="empty-state">No events yet.</div>`;

  return `
    ${listHTML}
    <button type="button" class="timeline-add-btn" id="timelineAddBtn" title="Add event">+</button>
    <div class="timeline-add-menu hidden" id="timelineAddMenu">
      ${TIMELINE_CATEGORIES.filter((c) => isAdmin || c.value !== "contract_advancement")
        .map((c) => `<button type="button" data-category="${c.value}">${escapeHtml(c.label)}</button>`)
        .join("")}
    </div>
  `;
}

function wireTimelineTab() {
  const addBtn = document.getElementById("timelineAddBtn");
  const addMenu = document.getElementById("timelineAddMenu");
  if (!addBtn) return;

  // Closing on an outside click used to be wired with a single one-time
  // document listener registered whenever this function ran (i.e. once per
  // Timeline-tab render) — but that meant the very next click ANYWHERE
  // (scrolling the list, tapping a delete button, etc.), not necessarily
  // opening the menu at all, would silently consume it. After that, no
  // outside-click listener was left registered, so a later "+" open could
  // never be dismissed by clicking away. Fixed by adding/removing the
  // listener exactly when the menu opens/closes instead.
  const closeMenu = () => {
    addMenu.classList.add("hidden");
    document.removeEventListener("click", onOutsideClick);
  };
  const onOutsideClick = (e) => {
    if (addMenu.contains(e.target) || addBtn.contains(e.target)) return;
    closeMenu();
  };
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = addMenu.classList.contains("hidden");
    if (opening) {
      addMenu.classList.remove("hidden");
      document.addEventListener("click", onOutsideClick);
    } else {
      closeMenu();
    }
  });
  addMenu.querySelectorAll("button[data-category]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeMenu();
      openTimelineAddFlow(btn.dataset.category);
    });
  });

  document.querySelectorAll(".timeline-edit-btn[data-event-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditEventModal(btn.dataset.eventId);
    });
  });
  // Confirm circle: unconfirmed -> confirmed always goes through the "write a
  // report" popup (prefilled with any report saved from a previous
  // confirm/uncheck cycle, so it can be edited rather than re-typed from
  // scratch — see openEventReportModal). Confirmed -> unconfirmed is a direct
  // toggle with no popup; that's what hides the triangle/report box again
  // (buildTimelineHTML only renders them at all when e.confirmed is true).
  document.querySelectorAll(".timeline-confirm-btn[data-event-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const eventId = btn.dataset.eventId;
      if (btn.dataset.confirmed === "1") {
        toggleClientEventConfirmed(eventId, false);
      } else {
        const existing = currentClientEvents.find((ev) => ev.id === eventId);
        openEventReportModal(existing?.details?.report || "", (reportText) => confirmEventWithReport(eventId, reportText));
      }
    });
  });
  // Triangle expand/collapse — purely a DOM toggle, no data reload, so the
  // confirmed report a user is mid-reading isn't disturbed by anything else
  // happening on the page.
  document.querySelectorAll(".timeline-triangle-btn[data-event-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const box = document.querySelector(`.timeline-report-box[data-report-for="${btn.dataset.eventId}"]`);
      btn.classList.toggle("expanded");
      if (box) box.classList.toggle("hidden");
    });
  });
}

// ---------------------------------------------------------------------------
// Timeline "+" flow — after picking a top-level category (Meeting/Contract
// advancement/Task) this shows the date/time/sub-type details popup, then
// branches by category+sub-type: Intro call keeps the existing Calendly
// hand-off; Client meeting additionally requires picking a counterpart
// client before it's logged (on BOTH sides — see logClientMeeting); every
// other combination just logs the one client_events row directly.
// ---------------------------------------------------------------------------
function openTimelineAddFlow(category) {
  openEventDetailsModal(category, ({ eventDate, time, subtype, taskDescription }) => {
    const details = time ? { time } : null;
    if (category === "meeting") {
      if (subtype === "intro_call") {
        openTimelineIntroCall(eventDate, time);
      } else if (subtype === "client_meeting") {
        openCounterpartPicker((counterpart) => logClientMeeting(eventDate, time, counterpart));
      } else {
        logClientEvent("general_meeting", eventDate, details);
      }
    } else if (category === "contract_advancement") {
      logClientEvent(subtype, eventDate, details);
    } else if (category === "task") {
      logClientEvent("task", eventDate, { ...(details || {}), task_description: taskDescription });
    }
  });
}

// ---------------------------------------------------------------------------
// Timeline "+" details step — date (required), time (optional, 30-min
// increments), plus whichever extra control the category needs: Meeting/
// Contract advancement get a sub-type dropdown, Task gets a required
// description field. Same show/confirm/cancel/cleanup shape as
// openConfirmModal-style helpers elsewhere in the app.
// ---------------------------------------------------------------------------
function openEventDetailsModal(category, onConfirm) {
  const modal = els.eventDateModal;
  const input = els.eventDateInput;
  const timeSelect = els.eventTimeInput;
  const subtypeWrap = els.eventSubtypeWrap;
  const subtypeSelect = els.eventSubtypeSelect;
  const taskWrap = els.eventTaskWrap;
  const taskInput = els.eventTaskInput;
  const confirmBtn = els.eventDateConfirmBtn;
  const cancelBtn = els.eventDateCancelBtn;

  els.eventDateModalTitle.textContent = category === "task" ? "New task" : "When did this happen?";

  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  input.value = today.toISOString().slice(0, 10);
  timeSelect.innerHTML = timeOptionsHTML();
  timeSelect.value = "";

  const showSubtype = category === "meeting" || category === "contract_advancement";
  subtypeWrap.classList.toggle("hidden", !showSubtype);
  const subtypeOptions = category === "meeting" ? MEETING_SUBTYPES : CONTRACT_SUBTYPES;
  if (showSubtype) {
    subtypeSelect.innerHTML = subtypeOptions.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join("");
    subtypeSelect.value = subtypeOptions[0].value;
  }
  const isTask = category === "task";
  taskWrap.classList.toggle("hidden", !isTask);
  taskInput.value = "";

  modal.classList.remove("hidden");

  const cleanup = () => {
    modal.classList.add("hidden");
    confirmBtn.removeEventListener("click", onConfirmClick);
    cancelBtn.removeEventListener("click", onCancelClick);
  };
  const onConfirmClick = () => {
    const val = input.value;
    if (!val) return;
    if (isTask && !taskInput.value.trim()) {
      els.requiredPopupText.textContent = "Please enter a description for the task.";
      els.requiredPopup.classList.remove("hidden");
      return;
    }
    const time = timeSelect.value || null;
    const subtype = showSubtype ? subtypeSelect.value : null;
    const taskDescription = isTask ? taskInput.value.trim() : null;
    cleanup();
    // Noon UTC-relative to the chosen calendar day (not midnight) so the
    // date can never accidentally roll back a day in a timezone behind UTC.
    const eventDate = new Date(`${val}T12:00:00`).toISOString();
    onConfirm({ eventDate, time, subtype, taskDescription });
  };
  const onCancelClick = () => cleanup();
  confirmBtn.addEventListener("click", onConfirmClick);
  cancelBtn.addEventListener("click", onCancelClick);
}

// ---------------------------------------------------------------------------
// "Who's the meeting with?" step — only for Meeting > Client meeting. Lists
// every opposite-side ("in cahoots"/connected_to_buyer) client this account
// can currently see (same Sellers/Buyers + Accounts visible scoping used
// everywhere else — see js/dealSide.js, js/accountsVisible.js), searchable,
// and requires picking exactly one before Continue is enabled.
// ---------------------------------------------------------------------------
function counterpartDisplayName(c) {
  return c.client_type === "seller" && c.company_name ? c.company_name : clientDisplayName(c);
}

async function openCounterpartPicker(onSelect) {
  const counterpartType = currentClient.client_type === "seller" ? "buyer" : "seller";
  const { data, error } = await supabase
    .from("clients")
    .select("id, first_name, last_name, company_name, client_type, created_by")
    .eq("client_type", counterpartType)
    .eq("pipeline_status", "connected_to_buyer")
    .order("first_name", { ascending: true });
  let options = error ? [] : data || [];
  const visibleAccountIds = getVisibleAccountIds();
  if (visibleAccountIds) options = options.filter((c) => visibleAccountIds.has(c.created_by));

  const modal = els.counterpartModal;
  const searchInput = els.counterpartSearchInput;
  const listEl = els.counterpartList;
  const confirmBtn = els.counterpartConfirmBtn;
  const cancelBtn = els.counterpartCancelBtn;

  let selectedId = null;

  function render() {
    const q = searchInput.value.trim().toLowerCase();
    const filtered = options.filter((c) => counterpartDisplayName(c).toLowerCase().includes(q));
    listEl.innerHTML = filtered.length
      ? filtered
          .map(
            (c) => `
        <button type="button" class="accounts-visible-row ${c.id === selectedId ? "selected" : ""}" data-id="${c.id}">
          ${escapeHtml(counterpartDisplayName(c))}
        </button>`
          )
          .join("")
      : `<div class="accounts-visible-empty">No matches.</div>`;
    listEl.querySelectorAll("[data-id]").forEach((row) => {
      row.addEventListener("click", () => {
        selectedId = row.dataset.id;
        confirmBtn.disabled = false;
        render();
      });
    });
  }

  searchInput.value = "";
  selectedId = null;
  confirmBtn.disabled = true;
  render();
  modal.classList.remove("hidden");

  const cleanup = () => {
    modal.classList.add("hidden");
    searchInput.removeEventListener("input", onSearchInput);
    confirmBtn.removeEventListener("click", onConfirmClick);
    cancelBtn.removeEventListener("click", onCancelClick);
  };
  const onSearchInput = () => render();
  const onConfirmClick = () => {
    const chosen = options.find((c) => c.id === selectedId);
    cleanup();
    if (chosen) onSelect(chosen);
  };
  const onCancelClick = () => cleanup();
  searchInput.addEventListener("input", onSearchInput);
  confirmBtn.addEventListener("click", onConfirmClick);
  cancelBtn.addEventListener("click", onCancelClick);
}

async function loadClientEvents() {
  if (!currentClient) {
    currentClientEvents = [];
    return;
  }
  const { data, error } = await supabase.from("client_events").select("*").eq("client_id", currentClient.id).order("event_date", { ascending: true });
  currentClientEvents = error ? [] : data || [];
}

async function logClientEvent(eventType, eventDate, details = null) {
  const payload = { client_id: currentClient.id, event_type: eventType, created_by: profile.id };
  if (eventDate) payload.event_date = eventDate;
  if (details) payload.details = details;
  const { error } = await supabase.from("client_events").insert(payload);
  if (error) return showError(document.getElementById("clientModalError"), error);
  await loadClientEvents();
  renderModalBody();
}

// Client meeting is the one Timeline entry that's mirrored onto a SECOND
// client's Timeline too (the counterpart picked in openCounterpartPicker) —
// "client meeting with (buyer name)" on the seller's side, and the reverse
// ("... with (seller name)") on the buyer's side, per spec. A plain insert
// can't do the counterpart's half when that client belongs to a different
// account (client_events_insert_own is still strictly own-client-only, same
// as everywhere else in this file — see supabase/schema.sql), so this calls
// the log_client_meeting() security-definer function instead, which checks
// the caller actually owns `currentClient` and then inserts both sides.
async function logClientMeeting(eventDate, time, counterpart) {
  const { error } = await supabase.rpc("log_client_meeting", {
    p_client_id: currentClient.id,
    p_counterpart_client_id: counterpart.id,
    p_event_date: eventDate,
    p_time: time || null,
    p_created_by: profile.id,
  });
  if (error) return showError(document.getElementById("clientModalError"), error);
  await loadClientEvents();
  renderModalBody();
}

async function deleteClientEvent(eventId) {
  const { error } = await supabase.from("client_events").delete().eq("id", eventId);
  if (error) return showError(document.getElementById("clientModalError"), error);
  await loadClientEvents();
  renderModalBody();
}

// Toggles the "confirm this happened" circle — only ever called for
// today-or-past events (future ones never render the control at all, see
// buildTimelineHTML). This is what the Progress tab's checkmarks are
// actually keyed off of (see buildProgressHTML's doneTypes) — merely logging
// an event via Timeline's "+" menu is NOT enough on its own to check a
// Progress dot; it also has to be confirmed here first. Used directly for
// un-confirming (no popup needed); confirming FOR THE FIRST TIME goes through
// confirmEventWithReport instead, since that also needs to save the report
// text written in openEventReportModal.
async function toggleClientEventConfirmed(eventId, newValue) {
  const { error } = await supabase.from("client_events").update({ confirmed: newValue }).eq("id", eventId);
  if (error) return showError(document.getElementById("clientModalError"), error);
  await loadClientEvents();
  renderModalBody();
}

// ---------------------------------------------------------------------------
// "Write a report" popup — shown when the confirm circle is pressed on an
// unconfirmed event (see wireTimelineTab). `existingReport` prefills it with
// whatever was last saved, so re-confirming after an uncheck lets you edit
// the old report rather than starting over.
// ---------------------------------------------------------------------------
function openEventReportModal(existingReport, onConfirm) {
  const modal = els.eventReportModal;
  const input = els.eventReportInput;
  const confirmBtn = els.eventReportConfirmBtn;
  const cancelBtn = els.eventReportCancelBtn;

  input.value = existingReport || "";
  modal.classList.remove("hidden");

  const cleanup = () => {
    modal.classList.add("hidden");
    confirmBtn.removeEventListener("click", onConfirmClick);
    cancelBtn.removeEventListener("click", onCancelClick);
  };
  const onConfirmClick = () => {
    const text = input.value.trim();
    cleanup();
    onConfirm(text);
  };
  const onCancelClick = () => cleanup();
  confirmBtn.addEventListener("click", onConfirmClick);
  cancelBtn.addEventListener("click", onCancelClick);
}

// Marks an event confirmed AND saves its report text in one update — the
// report lives in the existing `details` jsonb column (details.report) right
// alongside details.time/etc, so the other keys already on the event are
// preserved rather than clobbered by a full-column replace.
async function confirmEventWithReport(eventId, reportText) {
  const existing = currentClientEvents.find((e) => e.id === eventId);
  const details = { ...(existing?.details || {}), report: reportText };
  const { error } = await supabase.from("client_events").update({ confirmed: true, details }).eq("id", eventId);
  if (error) return showError(document.getElementById("clientModalError"), error);
  await loadClientEvents();
  renderModalBody();
}

// ---------------------------------------------------------------------------
// Edit-event popup — replaces the old standalone delete ("x") button. Always
// lets you change the date/time; the report field only appears if the event
// is currently confirmed (nothing to edit otherwise — see the "but only edit
// the report if you've checked the event" requirement). Also hosts Delete.
// ---------------------------------------------------------------------------
function openEditEventModal(eventId) {
  const e = currentClientEvents.find((ev) => ev.id === eventId);
  if (!e) return;

  const modal = els.editEventModal;
  const dateInput = els.editEventDateInput;
  const timeSelect = els.editEventTimeInput;
  const reportWrap = els.editEventReportWrap;
  const reportInput = els.editEventReportInput;
  const saveBtn = els.editEventSaveBtn;
  const deleteBtn = els.editEventDeleteBtn;
  const cancelBtn = els.editEventCancelBtn;

  const d = new Date(e.event_date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  dateInput.value = d.toISOString().slice(0, 10);
  timeSelect.innerHTML = timeOptionsHTML();
  timeSelect.value = e.details?.time || "";

  reportWrap.classList.toggle("hidden", !e.confirmed);
  reportInput.value = e.details?.report || "";

  modal.classList.remove("hidden");

  const cleanup = () => {
    modal.classList.add("hidden");
    saveBtn.removeEventListener("click", onSaveClick);
    deleteBtn.removeEventListener("click", onDeleteClick);
    cancelBtn.removeEventListener("click", onCancelClick);
  };
  const onSaveClick = async () => {
    const val = dateInput.value;
    if (!val) return;
    cleanup();
    // Same noon-UTC-relative anchoring as openEventDetailsModal, so this can
    // never accidentally roll the date back a day in a timezone behind UTC.
    const eventDate = new Date(`${val}T12:00:00`).toISOString();
    const details = { ...(e.details || {}), time: timeSelect.value || null };
    if (e.confirmed) details.report = reportInput.value.trim();
    const { error } = await supabase.from("client_events").update({ event_date: eventDate, details }).eq("id", eventId);
    if (error) return showError(document.getElementById("clientModalError"), error);
    await loadClientEvents();
    renderModalBody();
  };
  const onDeleteClick = () => {
    cleanup();
    openConfirmDelete(() => deleteClientEvent(eventId), "Delete this event?");
  };
  const onCancelClick = () => cleanup();
  saveBtn.addEventListener("click", onSaveClick);
  deleteBtn.addEventListener("click", onDeleteClick);
  cancelBtn.addEventListener("click", onCancelClick);
}

// Same shared "Schedule Intro Call" form the Dials page uses (js/introCall.js)
// — here the client already exists, so it's passed directly (no createClient
// callback needed). eventDate/time are whatever was chosen in
// openEventDetailsModal.
function openTimelineIntroCall(eventDate, time) {
  els.introCallPopupBody.innerHTML = buildIntroCallFormHTML({ allowSkip: true });
  els.introCallPopup.classList.remove("hidden");
  wireIntroCallForm(els.introCallPopupBody, {
    client: currentClient,
    userId: profile.id,
    // The Profile page's "Intro calls" graph counts SCHEDULING actions, not
    // completed/happened calls — so this always credits the graph the moment
    // "Open Calendly"/"Skip Calendly" is clicked here, regardless of whether
    // the eventDate picked for the Timeline entry is in the past, today, or
    // the future (logToGraph defaults to true — see js/introCall.js).
    onScheduled: async (client) => {
      await supabase.from("client_events").insert({
        client_id: client.id,
        event_type: "intro_call",
        event_date: eventDate || new Date().toISOString(),
        details: { via: "calendly_link", time: time || null },
        created_by: profile.id,
      });
      setTimeout(() => els.introCallPopup.classList.add("hidden"), 1200);
      await loadClientEvents();
      renderModalBody();
    },
  });
}

// ---------------------------------------------------------------------------
// Profile / Progress / Timeline sub-tabs — only shown in view mode (creating
// or editing a client always shows the plain editable form instead).
// ---------------------------------------------------------------------------
function renderSubtabsBar() {
  const show = currentMode === "view" && !!currentClient;
  els.clientSubtabs.classList.toggle("hidden", !show);
  if (!show) return;
  els.clientSubtabs.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === currentSubTab);
  });
}

els.clientSubtabs.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentSubTab = btn.dataset.tab;
    renderModalBody();
  });
});

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
  // information" — only shown in view mode, and only on the Profile tab
  // (editing doesn't apply to Progress/Timeline, which are event-driven).
  els.editProfileBtn.classList.toggle("hidden", currentMode !== "view" || currentSubTab !== "profile");
  renderSubtabsBar();

  if (currentMode === "create") {
    els.clientModalTitle.textContent = "New client";
    els.clientModalSubtitle.classList.add("hidden");
    els.clientModalBody.innerHTML = `
      <div id="clientModalError" class="error-msg hidden"></div>
      ${buildEditableSections(defaultClient(profile, { client_type: getDealSide() }))}
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

  // Edit mode always edits the Profile fields regardless of which sub-tab was
  // last active (the subtabs bar is hidden during edit anyway — see
  // renderSubtabsBar). Otherwise, show whichever of Profile/Progress/Timeline
  // is currently selected.
  let bodyHTML;
  if (currentMode === "edit") {
    bodyHTML = buildEditableSections(currentClient);
  } else if (currentSubTab === "progress") {
    bodyHTML = buildProgressHTML(currentClientEvents);
  } else if (currentSubTab === "timeline") {
    bodyHTML = buildTimelineHTML(currentClientEvents);
  } else {
    bodyHTML = buildClientViewHTML(currentClient);
  }

  els.clientModalBody.innerHTML = `
    <div id="clientModalError" class="error-msg hidden"></div>
    ${bodyHTML}
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
  } else if (currentSubTab === "timeline") {
    wireTimelineTab();
  } else if (currentSubTab === "progress") {
    positionProgressConnectors();
    wireProgressMetWith();
  } else if (currentSubTab === "profile") {
    wireCategoryDropdown();
    stopContactActionPropagation(els.clientModalBody);
  }
}

async function handleCreateSave() {
  const data = validateAndCollect();
  if (!data) return;
  data.assigned_to = profile.id;
  // Overrides whatever defaultClient() filled in (always "seller") with
  // whichever side is actually active right now — see js/dealSide.js. Every
  // non-admin is always on "seller", so this is a no-op for them.
  data.client_type = getDealSide();
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
  currentSubTab = "profile";
  els.clientModal.classList.remove("hidden");
  lockPageScroll();
  renderModalBody();
}

async function openDetailModal(client, initialSubTab = "profile") {
  currentClient = client;
  currentMode = "view";
  currentSubTab = initialSubTab;
  els.clientModal.classList.remove("hidden");
  lockPageScroll();
  await loadClientEvents();
  renderModalBody();
}

function closeModal() {
  els.clientModal.classList.add("hidden");
  unlockPageScroll();
}

// Replaces the old bottom-right "+" FAB — same create-client flow, now a
// regular menu item in the triangle dropdown (see menuAddNewBtn in
// clients.html), positioned directly above Categories.
els.menuAddNewBtn.addEventListener("click", () => {
  closePageHeaderMenu();
  openCreateModal();
});
els.clientModalClose.addEventListener("click", closeModal);
wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu, extraCloseEl: els.categoriesSubmenu });

// Settings gear popover — Sellers/Buyers toggle (see js/dealSide.js), visible
// to admins and team leads. Hidden entirely for interns (it used to just be
// inert but still visible/clickable, which was pointless since it has
// nothing for them — now it's not even shown).
if (!isAdmin && !isTeamLead) els.pageSettingsBtn.classList.add("hidden");
if (isAdmin || isTeamLead) {
  wirePageHeaderMenu({ toggleBtn: els.pageSettingsBtn, menuEl: els.settingsMenu });
  wireDealSideToggle(els.dealSideToggleBtn, els.dealSideLabel, async () => {
    els.settingsMenu.classList.add("hidden");
    els.pageSettingsBtn.classList.remove("open");
    // Refreshes the green category's label ("Connected to buyer" <->
    // "In cahoots" — see statusLabel()) immediately on toggle, not just
    // after a full reload.
    renderCategoriesSubmenu();
    await loadClients();
    renderTable();
  });
}
els.editProfileBtn.addEventListener("click", () => {
  currentMode = "edit";
  renderModalBody();
});

await loadClients();

// ---------------------------------------------------------------------------
// Deep-link support: ?client=<id>&tab=timeline opens straight into that
// client's Timeline tab — used by Profile's Upcoming events list (see
// loadUpcomingEvents() in js/profile.js) and the Progress tab's "Buyers/
// Sellers met with" names (see buildProgressHTML). Fetches the target client
// directly (rather than looking it up in the client_type-filtered `clients`
// array above) since the linked client may be the opposite buyer/seller side
// from whatever's currently toggled in Sellers/Buyers.
// ---------------------------------------------------------------------------
const deepLinkParams = new URLSearchParams(window.location.search);
const deepLinkClientId = deepLinkParams.get("client");
if (deepLinkClientId) {
  const { data: deepLinkClient } = await supabase.from("clients").select("*").eq("id", deepLinkClientId).maybeSingle();
  if (deepLinkClient) {
    await openDetailModal(deepLinkClient, deepLinkParams.get("tab") === "timeline" ? "timeline" : "profile");
  }
  // Clean the URL so refreshing, or closing the modal, doesn't reopen the
  // same client again.
  window.history.replaceState({}, "", "clients.html");
}
