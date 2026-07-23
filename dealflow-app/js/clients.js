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
import { wirePageHeaderMenu, closeAllPageHeaderMenus as closePageHeaderMenu } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { buildIntroCallFormHTML, wireIntroCallForm } from "./introCall.js";
import { getDealSide, wireDealSideToggle } from "./dealSide.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;
const isAdmin = profile?.role === "admin";

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

// Which pipeline statuses are currently hidden from the Clients list (toggled
// via the page-header triangle's Categories submenu) — persisted the same way
// as dials' hiddenStatuses.
const CLIENTS_STORAGE_KEYS = {
  hiddenStatuses: "waystation_clients_hidden_statuses",
  visibleAccounts: "waystation_clients_visible_accounts",
};
const hiddenClientStatuses = new Set();
// Admin-only "Accounts visible" filter (see menuAccountsVisibleBtn below).
// null = no filter applied (every account's clients show, i.e. "Select all")
// — the same as before this feature existed. Once narrowed down to specific
// accounts, this becomes a Set of the profile ids to show.
let visibleAccountIds = null;
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
  try {
    const savedAccounts = localStorage.getItem(CLIENTS_STORAGE_KEYS.visibleAccounts);
    if (savedAccounts) {
      const arr = JSON.parse(savedAccounts);
      if (Array.isArray(arr)) visibleAccountIds = new Set(arr);
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
function persistVisibleAccountIds() {
  try {
    if (visibleAccountIds === null) localStorage.removeItem(CLIENTS_STORAGE_KEYS.visibleAccounts);
    else localStorage.setItem(CLIENTS_STORAGE_KEYS.visibleAccounts, JSON.stringify([...visibleAccountIds]));
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
  { type: "nda_financials", label: "NDA + financials" },
  { type: "client_approval", label: "Client approval" },
  { type: "client_meeting", label: "Client meeting" },
  { type: "loi", label: "LOI" },
  { type: "due_diligence", label: "Due diligence" },
  { type: "close", label: "Close" },
];
const EVENT_TYPE_LABELS = {
  created: "Client created",
  ...Object.fromEntries(PROGRESS_STEPS.map((s) => [s.type, s.label])),
};
const CHECK_SVG = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;

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
  eventDateInput: document.getElementById("eventDateInput"),
  eventDateConfirmBtn: document.getElementById("eventDateConfirmBtn"),
  eventDateCancelBtn: document.getElementById("eventDateCancelBtn"),
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
  const rows = clients.filter(
    (c) =>
      (!q ||
        clientDisplayName(c).toLowerCase().includes(q) ||
        (c.company_name || "").toLowerCase().includes(q) ||
        (c.industry || "").toLowerCase().includes(q)) &&
      !hiddenClientStatuses.has(c.pipeline_status || "not_in_contact") &&
      // Admin-only "Accounts visible" filter — applied before Categories can
      // hide/show anything further (see renderCategoriesSubmenu). null means
      // no account filter is active (every account's clients pass through).
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
// "Categories" filter — same submenu-of-colored-rectangles pattern as the
// Dials page's Categories button (js/dials.js renderCategoriesSubmenu /
// positionCategoriesSubmenu), just with the 5 client pipeline statuses.
// ---------------------------------------------------------------------------

function renderCategoriesSubmenu() {
  els.categoriesSubmenu.innerHTML = CLIENT_STATUSES.map(
    (s) => `
      <button type="button" class="category-rect-option ${hiddenClientStatuses.has(s.value) ? "is-hidden" : ""}" data-value="${s.value}">
        <span class="category-rect-swatch" style="background:${s.dot}; border-color:${s.border};"></span>${escapeHtml(s.label)}
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
// Admin-only "Accounts visible" filter — a popup (not just a small submenu,
// since the list of accounts can run long) letting an admin narrow the
// Clients list down to only clients created by whichever accounts they've
// selected. Requires clients_select_own to also allow is_admin() (see
// supabase/schema.sql) — otherwise the admin's own Supabase session could
// never fetch other accounts' clients in the first place, filter or no
// filter. The Categories filter above is applied on top of whatever this
// leaves in (see renderTable).
// ---------------------------------------------------------------------------

if (isAdmin) els.menuAccountsVisibleBtn.classList.remove("hidden");

let allAccounts = []; // [{id, full_name}] — every account in the company, including the admin's own
let accountsLoaded = false;

async function loadAccountsIfNeeded() {
  if (accountsLoaded) return;
  const { data, error } = await supabase.from("profiles").select("id, full_name").order("full_name", { ascending: true });
  if (!error) {
    allAccounts = data || [];
    accountsLoaded = true;
  }
}

function isAccountVisible(id) {
  return !visibleAccountIds || visibleAccountIds.has(id);
}

function renderAccountsVisiblePopup() {
  const allSelected = !visibleAccountIds;
  const rowsHTML = allAccounts.length
    ? allAccounts
        .map(
          (a) => `
        <button type="button" class="accounts-visible-row" data-id="${a.id}">
          <input type="checkbox" ${isAccountVisible(a.id) ? "checked" : ""} tabindex="-1" />
          ${escapeHtml(a.full_name)}${a.id === profile.id ? " (you)" : ""}
        </button>`
        )
        .join("")
    : `<div class="accounts-visible-empty">No accounts found.</div>`;

  els.accountsVisibleBody.innerHTML = `
    <div class="accounts-visible-list">
      <button type="button" class="accounts-visible-row select-all" id="accountsSelectAllBtn">
        <input type="checkbox" ${allSelected ? "checked" : ""} tabindex="-1" />
        Select all
      </button>
      ${rowsHTML}
    </div>
  `;

  document.getElementById("accountsSelectAllBtn").addEventListener("click", () => {
    visibleAccountIds = null;
    persistVisibleAccountIds();
    renderAccountsVisiblePopup();
    renderTable();
  });
  els.accountsVisibleBody.querySelectorAll(".accounts-visible-row[data-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.id;
      // Narrowing down from "all" for the first time starts from the full
      // set of accounts (i.e. everything stays visible except the one just
      // unchecked), rather than jumping straight to "only this one".
      if (visibleAccountIds === null) visibleAccountIds = new Set(allAccounts.map((a) => a.id));
      if (visibleAccountIds.has(id)) visibleAccountIds.delete(id);
      else visibleAccountIds.add(id);
      persistVisibleAccountIds();
      renderAccountsVisiblePopup();
      renderTable();
    });
  });
}

els.menuAccountsVisibleBtn.addEventListener("click", async () => {
  closePageHeaderMenu();
  els.accountsVisiblePopup.classList.remove("hidden");
  els.accountsVisibleBody.innerHTML = `<div class="accounts-visible-empty">Loading…</div>`;
  await loadAccountsIfNeeded();
  renderAccountsVisiblePopup();
});
els.accountsVisibleClose.addEventListener("click", () => els.accountsVisiblePopup.classList.add("hidden"));

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
        style="background:${info.bg}; border-color:${info.border};">${escapeHtml(info.label)}</button>
      <div class="dial-status-menu hidden" id="clientStatusMenu">
        ${CLIENT_STATUSES.map(
          (s) => `
          <button type="button" class="dial-status-option" data-value="${s.value}">
            <span class="dial-status-dot" style="background:${s.dot}; border-color:${s.border};"></span>${escapeHtml(s.label)}
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
    ${rfContact("Phone number", client.phone, "phone")}
    ${rfLink("LinkedIn", client.linkedin)}
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
// Progress tab — vertical stepper of the 7 fixed milestones (PROGRESS_STEPS),
// each checked off green once a client_events row with the matching
// event_type exists (logged from the Timeline tab's "+" menu — see
// buildTimelineHTML/wireTimelineTab below).
// ---------------------------------------------------------------------------
function buildProgressHTML(events) {
  const doneTypes = new Set(events.map((e) => e.event_type));
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
  `;
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
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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
      // delete (x); only today-or-past ones additionally get the
      // confirm-happened circle (future events haven't happened yet, so
      // there's nothing to confirm — see isFutureDate above).
      let actionsHTML = "";
      if (!isCreated) {
        const deleteBtn = `<button type="button" class="timeline-delete-btn" data-event-id="${e.id}" title="Delete event">&times;</button>`;
        const confirmBtn = future
          ? ""
          : `<button type="button" class="timeline-confirm-btn ${e.confirmed ? "confirmed" : ""}" data-event-id="${e.id}" data-confirmed="${e.confirmed ? "1" : "0"}" title="${e.confirmed ? "Mark as not happened" : "Mark as happened"}">${e.confirmed ? CHECK_SVG : ""}</button>`;
        actionsHTML = `<div class="timeline-box-actions">${deleteBtn}${confirmBtn}</div>`;
      }

      const beforeDivider = i === lastFutureIndex;
      const itemHTML = `
          <div class="timeline-item${beforeDivider ? " tl-before-divider" : ""}">
            <div class="timeline-dot"></div>
            <div class="timeline-line"></div>
            <div class="timeline-box">
              <div>
                <div class="tl-date">${escapeHtml(timelineEventDateStr(e))}</div>
                <div class="tl-type">${escapeHtml(EVENT_TYPE_LABELS[e.event_type] || e.event_type)}</div>
              </div>
              ${actionsHTML}
            </div>
          </div>`;
      return beforeDivider ? itemHTML + `<div class="timeline-future-divider"></div>` : itemHTML;
    })
    .join("");

  const listHTML = sorted.length ? `<div class="timeline-list">${itemsHTML}</div>` : `<div class="empty-state">No events yet.</div>`;

  return `
    ${listHTML}
    <button type="button" class="timeline-add-btn" id="timelineAddBtn" title="Add event">+</button>
    <div class="timeline-add-menu hidden" id="timelineAddMenu">
      ${PROGRESS_STEPS.map((s) => `<button type="button" data-type="${s.type}">${escapeHtml(s.label)}</button>`).join("")}
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
  addMenu.querySelectorAll("button[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeMenu();
      const type = btn.dataset.type;
      // Every event added via "+" asks for the date it actually happened
      // first (defaults to today) — see openEventDateModal — rather than
      // always stamping it with "right now".
      openEventDateModal((eventDate) => {
        if (type === "intro_call") {
          openTimelineIntroCall(eventDate);
          return;
        }
        logClientEvent(type, eventDate);
      });
    });
  });

  document.querySelectorAll(".timeline-delete-btn[data-event-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteClientEvent(btn.dataset.eventId);
    });
  });
  document.querySelectorAll(".timeline-confirm-btn[data-event-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleClientEventConfirmed(btn.dataset.eventId, btn.dataset.confirmed !== "1");
    });
  });
}

// ---------------------------------------------------------------------------
// "Choose the date this happened" step shown before any Timeline "+" event is
// actually logged — a plain <input type="date"> defaulting to today, reused
// (rather than duplicated) for every event type including Intro call. Same
// show/confirm/cancel/cleanup shape as openConfirmModal-style helpers
// elsewhere in the app.
// ---------------------------------------------------------------------------
function openEventDateModal(onConfirm) {
  const modal = els.eventDateModal;
  const input = els.eventDateInput;
  const confirmBtn = els.eventDateConfirmBtn;
  const cancelBtn = els.eventDateCancelBtn;

  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  input.value = today.toISOString().slice(0, 10);
  modal.classList.remove("hidden");

  const cleanup = () => {
    modal.classList.add("hidden");
    confirmBtn.removeEventListener("click", onConfirmClick);
    cancelBtn.removeEventListener("click", onCancelClick);
  };
  const onConfirmClick = () => {
    const val = input.value;
    cleanup();
    if (!val) return;
    // Noon UTC-relative to the chosen calendar day (not midnight) so the
    // date can never accidentally roll back a day in a timezone behind UTC.
    onConfirm(new Date(`${val}T12:00:00`).toISOString());
  };
  const onCancelClick = () => cleanup();
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

async function logClientEvent(eventType, eventDate) {
  const payload = { client_id: currentClient.id, event_type: eventType, created_by: profile.id };
  if (eventDate) payload.event_date = eventDate;
  const { error } = await supabase.from("client_events").insert(payload);
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
// buildTimelineHTML). Purely a manual confirmation flag; doesn't affect the
// Progress tab's checkmarks, which are still based on the event simply
// existing, regardless of date or confirmed status.
async function toggleClientEventConfirmed(eventId, newValue) {
  const { error } = await supabase.from("client_events").update({ confirmed: newValue }).eq("id", eventId);
  if (error) return showError(document.getElementById("clientModalError"), error);
  await loadClientEvents();
  renderModalBody();
}

// Same shared "Schedule Intro Call" form the Dials page uses (js/introCall.js)
// — here the client already exists, so it's passed directly (no createClient
// callback needed). eventDate is whatever was chosen in openEventDateModal.
function openTimelineIntroCall(eventDate) {
  els.introCallPopupBody.innerHTML = buildIntroCallFormHTML({ allowSkip: true });
  els.introCallPopup.classList.remove("hidden");
  wireIntroCallForm(els.introCallPopupBody, {
    client: currentClient,
    userId: profile.id,
    // A future-dated intro call hasn't happened yet, so it shouldn't count
    // toward the Profile page's "Intro calls" graph until its date arrives
    // (see isFutureDate above, and the logToGraph comment in js/introCall.js).
    logToGraph: !isFutureDate(eventDate),
    onScheduled: async (client) => {
      await supabase.from("client_events").insert({
        client_id: client.id,
        event_type: "intro_call",
        event_date: eventDate || new Date().toISOString(),
        details: { via: "calendly_link" },
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

async function openDetailModal(client) {
  currentClient = client;
  currentMode = "view";
  currentSubTab = "profile";
  els.clientModal.classList.remove("hidden");
  lockPageScroll();
  await loadClientEvents();
  renderModalBody();
}

function closeModal() {
  els.clientModal.classList.add("hidden");
  unlockPageScroll();
}

els.addBtn.addEventListener("click", openCreateModal);
els.clientModalClose.addEventListener("click", closeModal);
wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu, extraCloseEl: els.categoriesSubmenu });

// Settings gear popover — admin-only Sellers/Buyers toggle (see
// js/dealSide.js). Never wired at all for non-admins, so the gear icon
// stays inert for them, same as before this existed.
if (isAdmin) {
  wirePageHeaderMenu({ toggleBtn: els.pageSettingsBtn, menuEl: els.settingsMenu });
  wireDealSideToggle(els.dealSideToggleBtn, els.dealSideLabel, async () => {
    els.settingsMenu.classList.add("hidden");
    els.pageSettingsBtn.classList.remove("open");
    await loadClients();
    renderTable();
  });
}
els.editProfileBtn.addEventListener("click", () => {
  currentMode = "edit";
  renderModalBody();
});

await loadClients();
