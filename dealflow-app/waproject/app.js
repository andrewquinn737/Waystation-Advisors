// TEMPORARY standalone dialing page — see README.md in this folder. Own tables (wp_lists, wp_dials); nothing in the main
// app imports this file. Same Dials look (css/style.css), but calls and texts open WhatsApp instead of the company line.
import { supabase } from "../js/supabaseClient.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------------------
// Categories (same ones and colours as the main Dials page)
// ---------------------------------------------------------------------------
const CONTACT_STATUSES = [
  { value: "uncontacted", label: "Uncontacted", bg: "var(--status-uncontacted-bg)", border: "var(--status-uncontacted-border)", dot: "var(--status-uncontacted-dot)" },
  { value: "unable_to_contact", label: "Unable to contact", bg: "var(--status-unable-bg)", border: "var(--status-unable-border)", dot: "var(--status-unable-dot)" },
  { value: "not_interested", label: "Not interested", bg: "var(--status-not-interested-bg)", border: "var(--status-not-interested-border)", dot: "var(--status-not-interested-dot)" },
  { value: "no_response", label: "No response, try again", bg: "var(--status-no-response-bg)", border: "var(--status-no-response-border)", dot: "var(--status-no-response-dot)" },
  { value: "busy_callback", label: "Busy, call back", bg: "var(--status-busy-bg)", border: "var(--status-busy-border)", dot: "var(--status-busy-dot)" },
  { value: "callback_interested", label: "Callback, interested", bg: "var(--status-callback-bg)", border: "var(--status-callback-border)", dot: "var(--status-callback-dot)" },
  { value: "intro_call_scheduled", label: "Accepted intro call", bg: "var(--status-scheduled-bg)", border: "var(--status-scheduled-border)", dot: "var(--status-scheduled-dot)" },
];
const statusInfo = (v) => CONTACT_STATUSES.find((s) => s.value === v) || CONTACT_STATUSES[0];
const SELECT_ALL_CHECK_SVG = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
const ICON_CALL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
const ICON_TEXT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

// ---------------------------------------------------------------------------
// WhatsApp links
// ---------------------------------------------------------------------------
function waNumber(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  let d = s.replace(/\D/g, "");
  if (!d) return "";
  if (s.startsWith("+")) return d;
  if (s.startsWith("00")) return d.slice(2);
  d = d.replace(/^0+/, "");
  if (d.length >= 11) return d; // already has a country code
  return (store.get("wp_cc", "1").replace(/\D/g, "") || "1") + d;
}
function waTemplate(dial) {
  const t = store.get("wp_template", "") || "";
  if (!t) return "";
  const first = String(dial.full_name || "").trim().split(/\s+/)[0] || "";
  return t.replace(/\{name\}/gi, first);
}
// WhatsApp has no public "start a call" link: both buttons open the chat with that number (Call = plain chat, then tap
// WhatsApp's own call icon; Text = chat with your message pre-filled).
function waHref(phone, text) {
  const n = waNumber(phone);
  if (!n) return "";
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}
async function logContact(dialId) {
  const d = [...dials, ...(modalSet || [])].find((x) => x.id === dialId);
  const now = new Date().toISOString();
  const count = (d?.contact_count || 0) + 1;
  if (d) { d.last_contacted_at = now; d.contact_count = count; }
  await supabase.from("wp_dials").update({ last_contacted_at: now, contact_count: count }).eq("id", dialId);
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[data-wa-log]");
  if (a) { e.stopPropagation(); logContact(a.dataset.waLog); }
}, true);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let user = null;
let allLists = [];
let currentListId = store.get("wp_list");
let currentStatus = store.get("wp_status", "current");
let dials = [];
let searchPoolActive = false;
let searchQuery = "";
const hiddenStatuses = new Set((() => { try { return JSON.parse(store.get("wp_hidden", "[]")); } catch { return []; } })());
let selectMode = false, moveMode = false;
const selectedIds = new Set();
let menuTabId = null;
let addTabBtnEl = null; // kept by reference: tab re-renders replace the tab strip's innerHTML, which would otherwise drop the + button
let modalSet = [], modalIndex = -1, modalMode = "view", currentDial = null;

const showErr = (el, err) => { el.textContent = err?.message || String(err); el.classList.remove("hidden"); };

// ---------------------------------------------------------------------------
// Boot / sign-in
// ---------------------------------------------------------------------------
async function boot() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    $("wpLogin").classList.remove("hidden");
    $("wpLoginBtn").addEventListener("click", async () => {
      $("wpLoginError").classList.add("hidden");
      const { error } = await supabase.auth.signInWithPassword({ email: $("wpEmail").value.trim(), password: $("wpPassword").value });
      if (error) return showErr($("wpLoginError"), error);
      location.reload();
    });
    return;
  }
  user = data.session.user;
  addTabBtnEl = $("addTabBtn");
  $("wpApp").classList.remove("hidden");
  wireUi();
  await loadLists();
}

// ---------------------------------------------------------------------------
// Lists (tabs)
// ---------------------------------------------------------------------------
async function loadLists() {
  const { data, error } = await supabase.from("wp_lists").select("*").order("sort_order", { ascending: true }).order("created_at", { ascending: true });
  if (error) return showErr($("errorBox"), error);
  allLists = data || [];
  renderTabs();
}
const filteredLists = () => allLists.filter((l) => l.status === currentStatus);

function renderTabs() {
  const lists = filteredLists();
  if (!currentListId || !lists.some((l) => l.id === currentListId)) currentListId = lists[0]?.id || null;
  store.set("wp_list", currentListId || "");
  $("dialTabs").innerHTML = lists.length
    ? lists.map((l) => `<div class="dial-tab-wrap"><button type="button" class="dial-tab ${l.id === currentListId ? "active" : ""}" data-id="${l.id}">${esc(l.name)}</button></div>`).join("")
    : `<span class="help-text">No lists yet — tap + to create one, or Import a CSV.</span>`;
  $("dialTabs").querySelectorAll(".dial-tab").forEach((btn) => btn.addEventListener("click", () => onTabClick(btn.dataset.id)));
  $("dialTabs").appendChild(addTabBtnEl);
  hideTabMenu();
  loadDials();
}

async function onTabClick(id) {
  if (moveMode) return completeMove(id);
  if (id === currentListId) {
    // Tapping the already-open tab reveals Rename / Archive / Delete.
    if (menuTabId === id) return hideTabMenu();
    menuTabId = id;
    $("dialTabArchiveBtn").textContent = currentStatus === "current" ? "Archive" : "Unarchive";
    $("dialTabMenu").classList.remove("hidden");
    return;
  }
  currentListId = id;
  store.set("wp_list", id);
  exitSelectMode();
  renderTabs();
}
function hideTabMenu() { menuTabId = null; $("dialTabMenu").classList.add("hidden"); }

function openListNameModal(title, initial, onSave) {
  $("listNameTitle").textContent = title;
  $("listNameInput").value = initial || "";
  $("listNameError").classList.add("hidden");
  $("listNameModal").classList.remove("hidden");
  $("listNameInput").focus();
  const close = () => { $("listNameModal").classList.add("hidden"); $("listNameSaveBtn").onclick = null; };
  $("listNameCancelBtn").onclick = close;
  $("listNameSaveBtn").onclick = async () => {
    const name = $("listNameInput").value.trim();
    if (!name) return showErr($("listNameError"), "Give the list a name.");
    try { await onSave(name); close(); } catch (err) { showErr($("listNameError"), err); }
  };
}
function confirmBox(title, text, yesLabel, onYes) {
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  $("confirmYesBtn").textContent = yesLabel;
  $("confirmModal").classList.remove("hidden");
  const close = () => { $("confirmModal").classList.add("hidden"); $("confirmYesBtn").onclick = null; };
  $("confirmNoBtn").onclick = close;
  $("confirmYesBtn").onclick = async () => { close(); await onYes(); };
}

// ---------------------------------------------------------------------------
// Dials load / filter
// ---------------------------------------------------------------------------
async function fetchDials(listIds) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("wp_dials").select("*").in("list_id", listIds).order("created_at", { ascending: true }).order("id").range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}
async function loadDials() {
  try {
    if (searchQuery.trim()) {
      const ids = filteredLists().map((l) => l.id);
      dials = ids.length ? await fetchDials(ids) : [];
      searchPoolActive = true;
    } else {
      searchPoolActive = false;
      dials = currentListId ? await fetchDials([currentListId]) : [];
    }
  } catch (err) { dials = []; showErr($("errorBox"), err); }
  renderTable();
}

const phoneDigits = (s) => { const n = String(s || "").replace(/\D/g, ""); return n.length === 11 && n[0] === "1" ? n.slice(1) : n; };
function searchPhoneDigits(q) {
  if (!/^[\d\s+().\-]+$/.test(q)) return "";
  const n = phoneDigits(q);
  return n.length >= 3 ? n : "";
}
function visibleDials() {
  const q = searchQuery.trim().toLowerCase();
  const qd = searchPhoneDigits(q);
  return dials.filter((d) =>
    !hiddenStatuses.has(d.contact_status || "uncontacted") &&
    (!q ||
      [d.full_name, d.company_name, d.email, d.mobile_phone, d.company_phone].some((v) => String(v || "").toLowerCase().includes(q)) ||
      (qd && (phoneDigits(d.mobile_phone).includes(qd) || phoneDigits(d.company_phone).includes(qd))))
  );
}
const dialName = (d) => d.full_name || d.company_name || "Unnamed dial";
const dialLocation = (d) => [d.city, d.state].filter(Boolean).join(", ") || "—";
const listName = (d) => allLists.find((l) => l.id === d.list_id)?.name || "";

function renderTable() {
  const visible = visibleDials();
  $("dialsProspectCount").textContent = selectMode ? `${selectedIds.size} prospect${selectedIds.size === 1 ? "" : "s"} selected` : `${visible.length} prospect${visible.length === 1 ? "" : "s"} displayed`;
  const wrap = $("dialsTableWrap");
  if (!currentListId && !searchQuery.trim()) { wrap.innerHTML = `<div class="empty-state">No lists yet — tap + next to the tabs to create one, or use Import.</div>`; return; }
  if (!dials.length) { wrap.innerHTML = `<div class="empty-state">${searchQuery.trim() ? "No dials match." : 'No dials in this list yet — use the arrow next to "Dials" and tap "Add new".'}</div>`; return; }
  if (!visible.length) { wrap.innerHTML = `<div class="empty-state">${searchQuery.trim() ? `No dials in any tab match "${esc(searchQuery.trim())}".` : "Every dial in this list is hidden by the status filter above."}</div>`; return; }
  const circle = (d) => `<div class="select-circle ${selectedIds.has(d.id) ? "selected" : ""}"></div>`;
  const tag = (d) => (searchPoolActive ? ` <span class="search-tab-tag">${esc(listName(d))}</span>` : "");
  const icons = (d) => {
    const phone = d.mobile_phone || d.company_phone;
    const call = waHref(phone), text = waHref(phone, waTemplate(d));
    if (!call) return "";
    return `<div class="contact-actions">
      <a class="contact-action-btn" href="${call}" target="_blank" rel="noopener" data-wa-log="${d.id}" title="WhatsApp (call)">${ICON_CALL}</a>
      <a class="contact-action-btn" href="${text}" target="_blank" rel="noopener" data-wa-log="${d.id}" title="WhatsApp (text)">${ICON_TEXT}</a>
    </div>`;
  };
  wrap.innerHTML = `
    <table class="list-table">
      <thead><tr>${selectMode ? "<th></th>" : ""}<th>Name</th><th>Company</th><th>Location</th><th>Phone</th><th>Email</th></tr></thead>
      <tbody>${visible.map((d, i) => `
        <tr class="clickable-row" data-index="${i}" style="background:${statusInfo(d.contact_status).bg};">
          ${selectMode ? `<td>${circle(d)}</td>` : ""}
          <td data-label="Name">${esc(dialName(d))}</td>
          <td class="muted" data-label="Company">${esc(d.company_name || "—")}${tag(d)}</td>
          <td class="muted" data-label="Location">${esc(dialLocation(d))}</td>
          <td class="muted" data-label="Phone">${esc(d.mobile_phone || d.company_phone || "—")}</td>
          <td class="muted" data-label="Email">${esc(d.email || "—")}</td>
        </tr>`).join("")}</tbody>
    </table>
    <div class="mobile-list">${visible.map((d, i) => `
      <div class="mobile-card clickable-row" data-index="${i}" style="background:${statusInfo(d.contact_status).bg}; border-color:${statusInfo(d.contact_status).border};">
        <div class="mc-main">
          <div class="mc-name">${esc(dialName(d))}</div>
          <div class="mc-sub">${esc([d.company_name, dialLocation(d) === "—" ? "" : dialLocation(d)].filter(Boolean).join(", "))}${tag(d)}</div>
        </div>
        ${selectMode ? circle(d) : icons(d)}
      </div>`).join("")}</div>`;
  wrap.querySelectorAll("[data-index]").forEach((row) => {
    const d = visible[Number(row.dataset.index)];
    row.addEventListener("click", () => {
      if (selectMode) return toggleSelect(d.id);
      openDialModal(visible, Number(row.dataset.index));
    });
  });
  wrap.querySelectorAll(".contact-actions").forEach((el) => el.addEventListener("click", (e) => e.stopPropagation()));
  if (selectMode) $("selectAllBtn").classList.toggle("active", visible.every((d) => selectedIds.has(d.id)));
}

// ---------------------------------------------------------------------------
// Select / move / delete
// ---------------------------------------------------------------------------
function enterSelectMode() {
  selectMode = true; moveMode = false; selectedIds.clear();
  $("selectModeBar").classList.remove("hidden");
  $("pageHeaderMenu").classList.add("hidden"); $("pageMenuToggle").classList.remove("open");
  renderTable();
}
function exitSelectMode() {
  if (!selectMode) return;
  selectMode = false; moveMode = false; selectedIds.clear();
  $("selectModeBar").classList.add("hidden"); $("selectMoveHint").classList.add("hidden");
  renderTable();
}
function toggleSelect(id) { if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); renderTable(); }
async function completeMove(listId) {
  if (!selectedIds.size) return;
  const ids = [...selectedIds];
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await supabase.from("wp_dials").update({ list_id: listId }).in("id", ids.slice(i, i + 200));
    if (error) return showErr($("errorBox"), error);
  }
  exitSelectMode();
  await loadDials();
}

// ---------------------------------------------------------------------------
// Dial popup
// ---------------------------------------------------------------------------
const emptyDial = () => ({ full_name: "", company_name: "", city: "", state: "", email: "", mobile_phone: "", company_phone: "", linkedin: "", website: "", industry: "", summary: "", call_notes: "", contact_status: "uncontacted", extra: {} });
const rf = (label, v) => `<div class="readonly-field"><div class="rf-label">${esc(label)}</div><div class="rf-value ${v ? "" : "empty"}">${v ? esc(v) : "Not provided"}</div></div>`;
const rfLink = (label, v) => {
  const href = v && !/^https?:\/\//i.test(v) ? `https://${v}` : v;
  return `<div class="readonly-field"><div class="rf-label">${esc(label)}</div><div class="rf-value ${v ? "" : "empty"}">${v ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(v)}</a>` : "Not provided"}</div></div>`;
};
function rfPhone(label, phone, dial) {
  const call = waHref(phone), text = waHref(phone, waTemplate(dial));
  return `<div class="readonly-field"><div class="rf-label">${esc(label)}</div>
    <div class="rf-value ${phone ? "" : "empty"}">${phone ? esc(phone) : "Not provided"}</div>
    ${call ? `<div class="wa-actions">
      <a class="btn secondary wa-btn" href="${call}" target="_blank" rel="noopener" data-wa-log="${dial.id}">${ICON_CALL} WhatsApp call</a>
      <a class="btn secondary wa-btn" href="${text}" target="_blank" rel="noopener" data-wa-log="${dial.id}">${ICON_TEXT} WhatsApp text</a>
    </div>` : ""}</div>`;
}
function openDialModal(set, index) {
  modalSet = set; modalIndex = index; currentDial = set[index]; modalMode = "view";
  $("dialModalBackdrop").classList.remove("hidden");
  renderModal();
}
function openCreate() {
  if (!currentListId) return showErr($("errorBox"), "Create a list first (the + next to the tabs).");
  modalSet = []; modalIndex = -1; currentDial = emptyDial(); modalMode = "create";
  $("dialModalBackdrop").classList.remove("hidden");
  renderModal();
}
async function closeModal() {
  await flushNotes();
  $("dialModalBackdrop").classList.add("hidden");
  currentDial = null;
  renderTable();
}
async function flushNotes() {
  const el = $("d_call_notes_live");
  if (!el || !currentDial?.id) return;
  const val = el.value.trim() || null;
  if (val === (currentDial.call_notes || null)) return;
  const { error } = await supabase.from("wp_dials").update({ call_notes: val, updated_at: new Date().toISOString() }).eq("id", currentDial.id);
  if (error) return showErr($("dialModalError"), error);
  currentDial.call_notes = val;
}
async function go(delta) {
  const next = modalIndex + delta;
  if (next < 0 || next >= modalSet.length) return;
  await flushNotes();
  modalIndex = next; currentDial = modalSet[next]; modalMode = "view";
  renderModal();
  $("dialModalBackdrop").scrollTop = 0;
}
async function setStatus(value) {
  await flushNotes();
  const { error } = await supabase.from("wp_dials").update({ contact_status: value, updated_at: new Date().toISOString() }).eq("id", currentDial.id);
  if (error) return showErr($("dialModalError"), error);
  currentDial.contact_status = value;
  renderModal();
}

function viewHTML(d) {
  const extra = Object.entries(d.extra || {}).filter(([, v]) => v);
  return `
    ${rfPhone("Mobile number", d.mobile_phone, d)}
    ${rfPhone("Company number", d.company_phone, d)}
    <div class="wa-note">WhatsApp can't start a call from a link: "call" opens the chat — tap the call icon there.</div>
    <div class="readonly-field"><div class="rf-label">Email</div><div class="rf-value ${d.email ? "" : "empty"}">${d.email ? `<a href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : "Not provided"}</div></div>
    ${rfLink("LinkedIn", d.linkedin)}
    ${rfLink("Website", d.website)}
    ${rf("Industry sector", d.industry)}
    ${rf("Summary", d.summary)}
    ${extra.map(([k, v]) => `<div class="dial-extra">${rf(k, v)}</div>`).join("")}
    <div class="readonly-field"><div class="rf-label">Call notes</div>
      <textarea id="d_call_notes_live" class="call-notes-live">${esc(d.call_notes || "")}</textarea></div>
    ${d.last_contacted_at ? rf("Last WhatsApp tap", `${new Date(d.last_contacted_at).toLocaleString()} (${d.contact_count || 1}×)`) : ""}`;
}
function editHTML(d) {
  const f = (id, label, v, type = "text") => `<label for="d_${id}">${esc(label)}</label><input id="d_${id}" type="${type}" value="${esc(v)}" />`;
  return `
    ${f("full_name", "Full name", d.full_name)}
    ${f("company_name", "Company name", d.company_name)}
    <div class="form-row"><div>${f("city", "City", d.city)}</div><div>${f("state", "State / region", d.state)}</div></div>
    ${f("email", "Email", d.email, "email")}
    <div class="form-row"><div>${f("mobile_phone", "Mobile number", d.mobile_phone, "tel")}</div><div>${f("company_phone", "Company number", d.company_phone, "tel")}</div></div>
    ${f("linkedin", "LinkedIn", d.linkedin)}
    ${f("website", "Website", d.website)}
    ${f("industry", "Industry sector", d.industry)}
    <label for="d_summary">Summary</label><textarea id="d_summary">${esc(d.summary || "")}</textarea>`;
}
function collectForm() {
  const v = (id) => $(`d_${id}`).value.trim() || null;
  return { full_name: v("full_name"), company_name: v("company_name"), city: v("city"), state: v("state"), email: v("email"), mobile_phone: v("mobile_phone"), company_phone: v("company_phone"), linkedin: v("linkedin"), website: v("website"), industry: v("industry"), summary: v("summary") };
}

function renderModal() {
  const d = currentDial, isCreate = modalMode === "create", viewing = modalMode === "view";
  const company = d.company_name ? `<span class="subtitle-company">${esc(d.company_name)}</span>` : "";
  const loc = dialLocation(d) !== "—" ? ` <span class="subtitle-location">${esc(dialLocation(d))}</span>` : "";
  $("dialModalHeader").innerHTML = `
    <div class="dial-modal-header">
      <div class="dial-modal-header-main">
        <h2>${esc(isCreate ? "New dial" : dialName(d))}</h2>
        ${!isCreate && (company || loc) ? `<div class="dial-modal-subtitle">${company}${loc}</div>` : ""}
      </div>
      <div class="dial-modal-header-right">
        <div class="dial-modal-header-actions">
          ${viewing ? `<div class="dial-status-dropdown">
            <button type="button" class="dial-status-btn" id="dialStatusBtn" style="background:${statusInfo(d.contact_status).bg}; border-color:${statusInfo(d.contact_status).border};">${esc(statusInfo(d.contact_status).label)}</button>
            <div class="dial-status-menu hidden" id="dialStatusMenu">${CONTACT_STATUSES.map((s) => `<button type="button" class="dial-status-option" data-value="${s.value}"><span class="dial-status-dot" style="background:${s.dot}; border-color:${s.border};"></span>${esc(s.label)}</button>`).join("")}</div>
          </div>` : ""}
          <button type="button" class="fs-close" id="dialModalClose">&times;</button>
        </div>
        ${viewing ? `<div class="dial-modal-editrow"><button type="button" class="edit-icon-btn" id="dialEditBtn" title="Edit">&#9998;</button></div>` : ""}
      </div>
    </div>`;
  $("dialModalClose").addEventListener("click", closeModal);
  $("dialModalError").classList.add("hidden");
  $("dialModalBody").innerHTML = viewing ? viewHTML(d) : editHTML(d);
  $("dialModalBody").querySelectorAll(".wa-actions").forEach((el) => el.addEventListener("click", (e) => e.stopPropagation()));

  if (viewing) {
    $("dialEditBtn").addEventListener("click", async () => { await flushNotes(); modalMode = "edit"; renderModal(); });
    const btn = $("dialStatusBtn"), menu = $("dialStatusMenu");
    btn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); });
    document.addEventListener("click", () => menu.classList.add("hidden"), { once: true });
    menu.querySelectorAll(".dial-status-option").forEach((o) => o.addEventListener("click", () => setStatus(o.dataset.value)));
    $("d_call_notes_live").addEventListener("blur", flushNotes);
    $("dialModalActions").innerHTML = "";
  } else {
    $("dialModalActions").innerHTML = `<button type="button" class="btn" id="dialSaveBtn">Save</button><button type="button" class="btn secondary" id="dialCancelBtn">Cancel</button>${!isCreate ? `<button type="button" class="btn danger" id="dialDeleteBtn" style="margin-left:auto;">Delete</button>` : ""}`;
    $("dialSaveBtn").addEventListener("click", isCreate ? saveCreate : saveEdit);
    $("dialCancelBtn").addEventListener("click", () => { if (isCreate) closeModal(); else { modalMode = "view"; renderModal(); } });
    $("dialDeleteBtn")?.addEventListener("click", () => confirmBox("Delete this dial?", "This can't be undone.", "Delete", async () => {
      const { error } = await supabase.from("wp_dials").delete().eq("id", currentDial.id);
      if (error) return showErr($("dialModalError"), error);
      $("dialModalBackdrop").classList.add("hidden"); currentDial = null;
      await loadDials();
    }));
  }
  const showNav = viewing && modalSet.length > 1;
  $("dialNavRow").classList.toggle("hidden", !showNav);
  $("dialPrevBtn").disabled = modalIndex <= 0;
  $("dialNextBtn").disabled = modalIndex >= modalSet.length - 1;
}
async function saveCreate() {
  const row = { ...collectForm(), list_id: currentListId, contact_status: "uncontacted" };
  const { error } = await supabase.from("wp_dials").insert(row);
  if (error) return showErr($("dialModalError"), error);
  $("dialModalBackdrop").classList.add("hidden"); currentDial = null;
  await loadDials();
}
async function saveEdit() {
  const data = { ...collectForm(), updated_at: new Date().toISOString() };
  const { error } = await supabase.from("wp_dials").update(data).eq("id", currentDial.id);
  if (error) return showErr($("dialModalError"), error);
  Object.assign(currentDial, data);
  modalMode = "view";
  renderModal();
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const ALIASES = {
  full_name: ["full name", "fullname", "name", "client name", "contact name"],
  first_name: ["first name", "firstname", "first"],
  last_name: ["last name", "lastname", "last"],
  company_name: ["company name", "company", "business name", "business"],
  email: ["email", "email address", "e mail"],
  mobile_phone: ["mobile phone", "mobile", "cell phone", "cell", "phone", "phone number", "mobile number", "whatsapp", "whatsapp number"],
  company_phone: ["company phone", "office phone", "business phone", "work phone", "company number"],
  linkedin: ["linkedin", "linkedin url", "linkedin profile"],
  city: ["city"], state: ["state", "region", "province"],
  website: ["website", "url", "web site", "web address"],
  industry: ["industry", "industry sector", "sector"],
  summary: ["summary", "notes", "description"],
  call_notes: ["call notes", "callnotes", "call note"],
  contact_status: ["status"],
};
const normH = (h) => String(h || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function rowsToDials(rows, listId) {
  if (rows.length < 2) return [];
  const header = rows[0], map = {}, used = new Set();
  header.forEach((h, i) => {
    const n = normH(h); if (!n) return;
    for (const [field, al] of Object.entries(ALIASES)) {
      if (used.has(field)) continue;
      if (field === "contact_status" ? n.includes("status") : al.some((a) => normH(a) === n)) { map[i] = field; used.add(field); break; }
    }
  });
  return rows.slice(1).filter((r) => r.some((c) => (c || "").trim() !== "")).map((r) => {
    const d = { list_id: listId, contact_status: "uncontacted", extra: {} };
    r.forEach((cell, i) => {
      const v = (cell || "").trim(); if (!v) return;
      const field = map[i];
      if (!field) { const k = String(header[i] || "").trim(); if (k) d.extra[k] = v; return; }
      if (field === "contact_status") { const hit = CONTACT_STATUSES.find((s) => s.label.toLowerCase() === v.toLowerCase() || s.value === v.toLowerCase()); d.contact_status = hit ? hit.value : "uncontacted"; return; }
      d[field] = v;
    });
    if (!d.full_name) { const c = `${d.first_name || ""} ${d.last_name || ""}`.trim(); if (c) d.full_name = c; }
    delete d.first_name; delete d.last_name;
    return d;
  });
}
let importFiles = [];
function setImportFiles(files) {
  const csv = files.filter((f) => /\.csv$/i.test(f.name));
  $("importDialsError").classList.add("hidden");
  if (csv.length > 10) { importFiles = []; $("importDialsFileName").textContent = ""; $("importDialsImportBtn").disabled = true; return showErr($("importDialsError"), `Select 10 CSV files or fewer at a time (${csv.length} selected).`); }
  importFiles = csv;
  $("importDialsFileName").textContent = csv.length ? csv.map((f) => f.name).join(", ") : files.length ? "Only .csv files can be imported." : "";
  $("importDialsImportBtn").disabled = !csv.length;
}
async function runImport() {
  if (!importFiles.length) return;
  $("importDialsError").classList.add("hidden"); $("importDialsImportBtn").disabled = true;
  let sort = allLists.filter((l) => l.status === "current").length, last = null;
  const failures = [], total = importFiles.length;
  for (const file of importFiles) {
    try {
      const rows = parseCSV(await file.text()).filter((r) => r.some((c) => (c || "").trim() !== ""));
      if (rows.length < 2) throw new Error("no data rows to import");
      const name = file.name.replace(/\.csv$/i, "").trim() || "Imported";
      const { data: list, error: le } = await supabase.from("wp_lists").insert({ name, status: "current", sort_order: sort }).select().single();
      if (le) throw le;
      sort++;
      const recs = rowsToDials(rows, list.id);
      if (!recs.length) throw new Error("no data rows found");
      for (let i = 0; i < recs.length; i += 500) { const { error } = await supabase.from("wp_dials").insert(recs.slice(i, i + 500)); if (error) throw error; }
      last = list.id;
    } catch (err) { failures.push(`${file.name} (${err.message || "could not import"})`); }
  }
  if (last) { currentStatus = "current"; store.set("wp_status", "current"); $("menuStatusBtn").querySelector(".menu-item-label").textContent = "Current"; currentListId = last; await loadLists(); }
  importFiles = []; $("importDialsFileInput").value = ""; $("importDialsFileName").textContent = "";
  if (failures.length) { showErr($("importDialsError"), `${failures.length} of ${total} file(s) failed — ${failures.join("; ")}. Re-select just those to try again.`); $("importDialsImportBtn").disabled = false; }
  else $("importDialsModal").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Categories submenu
// ---------------------------------------------------------------------------
const persistHidden = () => store.set("wp_hidden", JSON.stringify([...hiddenStatuses]));
function renderCategories() {
  const all = hiddenStatuses.size === 0, sub = $("categoriesSubmenu");
  sub.innerHTML = `<button type="button" class="category-rect-option select-all-option ${all ? "is-selected" : ""}" data-select-all="1"><span class="category-rect-swatch progress-check-swatch">${all ? SELECT_ALL_CHECK_SVG : ""}</span>Select all</button>` +
    CONTACT_STATUSES.map((s) => `<button type="button" class="category-rect-option ${hiddenStatuses.has(s.value) ? "is-hidden" : ""}" data-value="${s.value}"><span class="category-rect-swatch" style="background:${s.dot}; border-color:${s.border};"></span>${esc(s.label)}</button>`).join("");
  sub.querySelector("[data-select-all]").addEventListener("click", (e) => {
    e.stopPropagation();
    if (hiddenStatuses.size === 0) CONTACT_STATUSES.forEach((s) => hiddenStatuses.add(s.value)); else hiddenStatuses.clear();
    persistHidden(); renderCategories(); renderTable();
  });
  sub.querySelectorAll("[data-value]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const v = b.dataset.value; if (hiddenStatuses.has(v)) hiddenStatuses.delete(v); else hiddenStatuses.add(v);
    persistHidden(); renderCategories(); renderTable();
  }));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function closeHeaderMenu() { $("pageHeaderMenu").classList.add("hidden"); $("categoriesSubmenu").classList.add("hidden"); $("pageMenuToggle").classList.remove("open"); }
function wireUi() {
  $("pageMenuToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("pageHeaderMenu").classList.toggle("hidden") === false;
    $("pageMenuToggle").classList.toggle("open", open);
    if (!open) $("categoriesSubmenu").classList.add("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!$("pageHeaderMenu").contains(e.target) && !$("categoriesSubmenu").contains(e.target) && !$("pageMenuToggle").contains(e.target)) closeHeaderMenu();
  });
  $("menuStatusBtn").querySelector(".menu-item-label").textContent = currentStatus === "current" ? "Current" : "Archived";

  $("menuAddNewBtn").addEventListener("click", () => { closeHeaderMenu(); openCreate(); });
  $("menuImportBtn").addEventListener("click", () => { closeHeaderMenu(); importFiles = []; $("importDialsFileInput").value = ""; $("importDialsFileName").textContent = ""; $("importDialsError").classList.add("hidden"); $("importDialsImportBtn").disabled = true; $("importDialsModal").classList.remove("hidden"); });
  $("menuSelectBtn").addEventListener("click", () => { closeHeaderMenu(); enterSelectMode(); });
  $("menuSearchBtn").addEventListener("click", () => { closeHeaderMenu(); $("dialsSearchBar").classList.remove("hidden"); $("dialsSearchInput").focus(); });
  $("menuStatusBtn").addEventListener("click", () => {
    currentStatus = currentStatus === "current" ? "archived" : "current";
    store.set("wp_status", currentStatus);
    $("menuStatusBtn").querySelector(".menu-item-label").textContent = currentStatus === "current" ? "Current" : "Archived";
    closeHeaderMenu(); exitSelectMode(); renderTabs();
  });
  $("menuCategoriesBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const sub = $("categoriesSubmenu"), opening = sub.classList.contains("hidden");
    sub.classList.toggle("hidden");
    if (opening) {
      const r = $("menuCategoriesBtn").getBoundingClientRect(), w = sub.offsetWidth || 190;
      let left = r.right + 8; if (left + w > window.innerWidth) left = r.left - w - 8;
      sub.style.left = `${Math.max(8, left)}px`; sub.style.top = `${r.top}px`;
    }
  });
  $("menuWaSettingsBtn").addEventListener("click", () => { closeHeaderMenu(); $("waCountryInput").value = store.get("wp_cc", "1"); $("waTemplateInput").value = store.get("wp_template", ""); $("waSettingsModal").classList.remove("hidden"); });
  $("waSettingsCancelBtn").addEventListener("click", () => $("waSettingsModal").classList.add("hidden"));
  $("waSettingsSaveBtn").addEventListener("click", () => { store.set("wp_cc", $("waCountryInput").value.replace(/\D/g, "") || "1"); store.set("wp_template", $("waTemplateInput").value); $("waSettingsModal").classList.add("hidden"); renderTable(); });
  $("menuSignOutBtn").addEventListener("click", async () => { await supabase.auth.signOut(); location.reload(); });
  renderCategories();

  // Search (all tabs in the current Current/Archived view)
  let timer = null;
  $("dialsSearchInput").addEventListener("input", () => {
    searchQuery = $("dialsSearchInput").value;
    clearTimeout(timer);
    timer = setTimeout(() => { if (searchQuery.trim() && !searchPoolActive) loadDials(); else if (!searchQuery.trim() && searchPoolActive) loadDials(); else renderTable(); }, 150);
  });
  $("dialsSearchCloseBtn").addEventListener("click", () => { $("dialsSearchInput").value = ""; searchQuery = ""; $("dialsSearchBar").classList.add("hidden"); loadDials(); });

  // Select bar
  $("selectBackBtn").addEventListener("click", exitSelectMode);
  $("selectAllBtn").addEventListener("click", () => {
    const v = visibleDials(), all = v.every((d) => selectedIds.has(d.id));
    v.forEach((d) => (all ? selectedIds.delete(d.id) : selectedIds.add(d.id)));
    renderTable();
  });
  $("selectMoveBtn").addEventListener("click", () => { if (!selectedIds.size) return; moveMode = true; $("selectMoveHint").classList.remove("hidden"); });
  $("selectDeleteBtn").addEventListener("click", () => {
    if (!selectedIds.size) return;
    confirmBox(`Delete ${selectedIds.size} dial${selectedIds.size === 1 ? "" : "s"}?`, "This can't be undone.", "Delete", async () => {
      const ids = [...selectedIds];
      for (let i = 0; i < ids.length; i += 200) { const { error } = await supabase.from("wp_dials").delete().in("id", ids.slice(i, i + 200)); if (error) return showErr($("errorBox"), error); }
      exitSelectMode(); await loadDials();
    });
  });

  // Tabs
  $("addTabBtn").addEventListener("click", () => openListNameModal("New list", "", async (name) => {
    const { data, error } = await supabase.from("wp_lists").insert({ name, status: "current", sort_order: allLists.length }).select().single();
    if (error) throw error;
    currentStatus = "current"; currentListId = data.id; await loadLists();
  }));
  $("dialTabRenameBtn").addEventListener("click", () => {
    const l = allLists.find((x) => x.id === menuTabId); if (!l) return;
    openListNameModal("Rename list", l.name, async (name) => { const { error } = await supabase.from("wp_lists").update({ name }).eq("id", l.id); if (error) throw error; await loadLists(); });
  });
  $("dialTabArchiveBtn").addEventListener("click", async () => {
    const id = menuTabId; if (!id) return;
    const { error } = await supabase.from("wp_lists").update({ status: currentStatus === "current" ? "archived" : "current" }).eq("id", id);
    if (error) return showErr($("errorBox"), error);
    await loadLists();
  });
  $("dialTabDeleteBtn").addEventListener("click", () => {
    const l = allLists.find((x) => x.id === menuTabId); if (!l) return;
    confirmBox(`Delete "${l.name}"?`, "This removes the list and every dial in it. This can't be undone.", "Delete", async () => {
      const { error } = await supabase.from("wp_lists").delete().eq("id", l.id);
      if (error) return showErr($("errorBox"), error);
      await loadLists();
    });
  });

  // Import
  $("importDialsChooseBtn").addEventListener("click", () => $("importDialsFileInput").click());
  $("importDialsFileInput").addEventListener("change", () => setImportFiles([...($("importDialsFileInput").files || [])]));
  $("importDialsCancelBtn").addEventListener("click", () => $("importDialsModal").classList.add("hidden"));
  $("importDialsImportBtn").addEventListener("click", runImport);
  const zone = $("importDialsDropzone");
  ["dragenter", "dragover"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove("dragover"); }));
  zone.addEventListener("drop", (e) => setImportFiles([...(e.dataTransfer?.files || [])]));

  // Dial popup
  $("dialPrevBtn").addEventListener("click", () => go(-1));
  $("dialNextBtn").addEventListener("click", () => go(1));
  $("dialModalBackdrop").addEventListener("click", (e) => { if (e.target === $("dialModalBackdrop")) closeModal(); });
  document.addEventListener("keydown", (e) => {
    if ($("dialModalBackdrop").classList.contains("hidden") || modalMode !== "view") return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (e.key === "ArrowLeft") go(-1); else if (e.key === "ArrowRight") go(1); else if (e.key === "Escape") closeModal();
  });
}

boot();
