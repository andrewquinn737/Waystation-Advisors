// Messages page — a small in-app email client (see supabase migrations for
// email_accounts/email_messages/email_attachments and the email-sync/
// email-send Edge Functions this reads/writes).
//
// Visible to everyone (interns included), but scoped very differently by
// role — same "team leads/admins see broadly, interns see only their own"
// shape as the rest of the app (Accounts visible on Profile/Clients/Dials):
//   - Team lead: the Mailboxes popup (triangle menu) lists their own
//     connected accounts (up to 3). Can read, reply, and compose.
//   - Admin: same, but the popup lists EVERY connected mailbox across every
//     team lead (RLS already scopes email_accounts/email_messages this way
//     — this file just renders whatever comes back), each one suffixed with
//     its owner's name.
//   - Intern: no triangle menu at all, no compose/reply — a read-only feed
//     of whatever messages are matched (by address) to clients THEY own,
//     enforced by email_messages' own RLS, not just hidden UI. (Their own
//     email quick-action icon on Clients/Dials sends through their team
//     lead's mailbox instead — see js/quickSend.js — this page never
//     enters into that flow at all.)

import { supabase } from "./supabaseClient.js";
import { showConnectEmailNotice } from "./notice.js";
import { findPriorOutbound, isReplySubject, stripReplyPrefix } from "./followUp.js";
import { requireSession, showError } from "./auth.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { wireNotificationsToggle } from "./notifications.js";
import { openQuickSend } from "./quickSend.js";
import { getTeamLeadMailbox } from "./contactIcons.js";
import { MAILBOX_KEY, loadMailboxes, buildGroups, selectedMailboxIds, loadUnreadCounts, loadSequenceBadges, loadQuotas, wireMailboxPicker, ownerFirstName, isMsMailbox, MS_PENDING_NOTE } from "./mailboxScope.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;

const isAdmin = profile?.role === "admin";
const isTeamLead = profile?.role === "team_lead";
const isIntern = !isAdmin && !isTeamLead;
// ?from=<address> ("Read reply" on the call sheet): the thread opens with Reply and Done side by side; Done finishes the reply task.
let replyThreadId = null;
const replyFrom = (new URLSearchParams(window.location.search).get("from") || "").trim();
// "Inbox mode" = the full mail client (folders, reply, compose, picker). Admins/team leads always; anyone else
// (interns) once they own at least one mailbox — set after loadAccounts(). An intern who owns none keeps the old
// read-only feed of mail matched to their clients. NOTE: Mailboxes picker selection lives in mailboxScope.js
// (MAILBOX_KEY), independent of the app-wide "Accounts visible" setting.
let canManageMail = isAdmin || isTeamLead;

const els = {
  mailToolbar: document.getElementById("mailToolbar"),
  mailNote: document.getElementById("mailNote"),
  mailboxesBtnLabel: document.getElementById("mailboxesBtnLabel"),
  menuMailboxesBtn: document.getElementById("menuMailboxesBtn"),
  messagesTitle: document.getElementById("messagesTitle"),
  pageSettingsBtn: document.getElementById("pageSettingsBtn"),
  settingsMenu: document.getElementById("settingsMenu"),
  menuSyncNowBtn: document.getElementById("menuSyncNowBtn"),
  syncSpinner: document.getElementById("syncSpinner"),
  menuSelectBtn: document.getElementById("menuSelectBtn"),
  menuFolderBtn: document.getElementById("menuFolderBtn"),
  menuFolderLabel: document.getElementById("menuFolderLabel"),
  viewingPopup: document.getElementById("viewingPopup"),
  viewingPopupClose: document.getElementById("viewingPopupClose"),
  menuNotificationsBtn: document.getElementById("menuNotificationsBtn"),
  notificationsLabel: document.getElementById("notificationsLabel"),
  mailboxesPopup: document.getElementById("mailboxesPopup"),
  mailboxesPopupBody: document.getElementById("mailboxesPopupBody"),
  mailboxesPopupClose: document.getElementById("mailboxesPopupClose"),
  selectModeBar: document.getElementById("selectModeBar"),
  selectBackBtn: document.getElementById("selectBackBtn"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  selectMarkUnreadBtn: document.getElementById("selectMarkUnreadBtn"),
  selectDeleteBtn: document.getElementById("selectDeleteBtn"),
  confirmDeleteThreadsModal: document.getElementById("confirmDeleteThreadsModal"),
  confirmDeleteThreadsTitle: document.getElementById("confirmDeleteThreadsTitle"),
  confirmDeleteThreadsYesBtn: document.getElementById("confirmDeleteThreadsYesBtn"),
  confirmDeleteThreadsNoBtn: document.getElementById("confirmDeleteThreadsNoBtn"),
  errorBox: document.getElementById("errorBox"),
  wrap: document.getElementById("messagesWrap"),
  composeFabBtn: document.getElementById("composeFabBtn"),
  composeModal: document.getElementById("composeModal"),
  composeTitle: document.getElementById("composeTitle"),
  composeError: document.getElementById("composeError"),
  composeFromRow: document.getElementById("composeFromRow"),
  composeFromSelect: document.getElementById("composeFromSelect"),
  composeToInput: document.getElementById("composeToInput"),
  composeCcInput: document.getElementById("composeCcInput"),
  composeSubjectInput: document.getElementById("composeSubjectInput"),
  composeToolbar: document.getElementById("composeToolbar"),
  composeBody: document.getElementById("composeBody"),
  composeAttachInput: document.getElementById("composeAttachInput"),
  composeAttachmentsList: document.getElementById("composeAttachmentsList"),
  composeSendBtn: document.getElementById("composeSendBtn"),
  composeCancelBtn: document.getElementById("composeCancelBtn"),
  composeCloseBtn: document.getElementById("composeCloseBtn"),
};

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let accounts = []; // every mailbox the signed-in account can see (RLS-scoped)
let mailboxGroups = []; // picker groups (see mailboxScope.buildGroups)
let unreadByAccount = new Map();
let seqBadges = new Map(); // counterpart address (lowercase) -> { label, replied }
const acctById = (id) => accounts.find((a) => a.id === id);
// Read-only = a mailbox someone else owns (a lead viewing an intern's inbox). Admins can still act on any mailbox.
const isReadOnlyAccount = (id) => { const a = acctById(id); return !!a && !a.mine && !isAdmin; };
const canWriteAccount = (id) => { const a = acctById(id); return !!a && (a.mine || isAdmin); };
let detailThreadId = null; // null = list view
let pendingCompose = null; // { attachments: [{filename, contentType, base64}] }
let threadListSelectMode = false;
// "received" | "sent" | "spam" | "trash" | "scheduled" — team leads/admins only
// (interns always see the one client-matched feed). Received is the synced
// inbox (threads, unread state, client links); every other view is read live
// from the real mailbox / the send queue — see loadLiveFolder below.
let folderView = "received";
const FOLDER_LABELS = { received: "Received", sent: "Sent", spam: "Spam", trash: "Trash", scheduled: "Scheduled" };
let selectedThreadIds = new Set();
let currentThreadRows = []; // the list currently rendered, for Select all / bulk actions

// ---------------------------------------------------------------------------
// Mailboxes (triangle menu → Mailboxes popup) + settings gear
// ---------------------------------------------------------------------------

async function loadAccounts() {
  try {
    accounts = await loadMailboxes(profile, { isAdmin, isTeamLead });
  } catch (error) {
    return showError(els.errorBox, error);
  }
  canManageMail = isAdmin || isTeamLead || accounts.some((a) => a.mine);
  mailboxGroups = buildGroups(accounts, { isAdmin });
}

async function refreshUnread() {
  if (!canManageMail) return;
  unreadByAccount = await loadUnreadCounts(accounts.map((a) => a.id));
}

// The label shown for one mailbox: its email address, with the owner's name for someone else's.
function mailboxLabel(a) {
  return a.mine ? a.email_address : `${a.email_address} (${a.ownerName})`;
}

function updateTitle() {
  els.messagesTitle.textContent = folderView === "received" || folderView === "sent" ? "Inbox" : `Inbox · ${FOLDER_LABELS[folderView]}`;
  const ids = canManageMail ? selectedMailboxIds(accounts) : [];
  els.mailboxesBtnLabel.textContent = ids.length === accounts.length ? `Mailboxes (${accounts.length})` : ids.length === 1 ? acctById(ids[0])?.email_address || "Mailboxes" : `${ids.length} of ${accounts.length} mailboxes`;
  document.querySelectorAll(".mail-tab").forEach((t) => t.classList.toggle("active", t.dataset.folder === folderView));
}

// One quiet line (never an error) when some of the selected mailboxes are Microsoft 365 ones we can't read yet.
function updateMailNote() {
  const pending = (accountIdsForQuery() || []).filter((id) => { const a = acctById(id); return a && isMsMailbox(a); }).length;
  const total = (accountIdsForQuery() || []).length;
  // Interns only hear about it when nothing at all can be read, in one line.
  const show = isIntern ? pending > 0 && pending === total : pending > 0;
  els.mailNote.textContent = isIntern ? "Your inbox can't be read yet. Ask your team lead." : pending > 1 ? `${pending} mailboxes can't be read yet (Microsoft sign-in pending)` : pending ? `${MS_PENDING_NOTE}` : "";
  els.mailNote.classList.toggle("hidden", !show);
}

wirePageHeaderMenu({ toggleBtn: els.pageSettingsBtn, menuEl: els.settingsMenu, extraCloseEl: els.mailboxesPopup });
wireNotificationsToggle(els.menuNotificationsBtn, els.notificationsLabel, profile);
const closePageHeaderMenu = closeAllPageHeaderMenus;

function setupInboxUi() {
  if (!canManageMail) return;
  els.mailToolbar.classList.remove("hidden");
  els.composeFabBtn.classList.remove("hidden");
  els.menuMailboxesBtn.classList.toggle("hidden", accounts.length < 2 || isIntern); // one mailbox = nothing to pick
  document.querySelectorAll(".mail-tab").forEach((t) => t.addEventListener("click", () => t.dataset.folder !== folderView && setFolderView(t.dataset.folder)));
  wireMailboxPicker({
    menuBtn: els.menuMailboxesBtn,
    popupEl: els.mailboxesPopup,
    bodyEl: els.mailboxesPopupBody,
    closeBtn: els.mailboxesPopupClose,
    closePageHeaderMenu,
    getAccounts: () => accounts,
    getGroups: () => mailboxGroups,
    getUnread: () => unreadByAccount,
    refreshUnread,
    onChange: () => {
      updateTitle();
      updateMailNote();
      exitDetail();
      loadThreadList();
    },
    escapeHtml,
  });
}

// Runs email-sync for the mailboxes this account can see, with the spinning
// icon next to the title for as long as it takes. One sync at a time — a
// second call while one is running (e.g. tapping Sync now during the
// automatic one on page open) just waits on the same run instead of
// stacking a duplicate. Resolves to true on success, false on failure.
let syncInFlight = null;
function runSync() {
  if (syncInFlight) return syncInFlight;
  els.syncSpinner.classList.remove("hidden");
  syncInFlight = (async () => {
    try {
      const {
        data: { session: authSession },
      } = await supabase.auth.getSession();
      const { data, error } = await supabase.functions.invoke("email-sync", {
        body: {},
        headers: { Authorization: `Bearer ${authSession?.access_token || ""}` },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    } finally {
      els.syncSpinner.classList.add("hidden");
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

// Only refreshes what's on screen if it's safe to: the list view, and not
// mid-Select — re-rendering under someone's selection (or an open thread they
// might be reading) would yank it away for no reason.
function refreshAfterSync() {
  if (detailThreadId || threadListSelectMode || folderView !== "received") return;
  loadThreadList();
}

els.menuSyncNowBtn.addEventListener("click", async () => {
  closePageHeaderMenu();
  const result = await runSync();
  if (!result.ok) return showError(els.errorBox, result.error);
  if (detailThreadId) openThread(detailThreadId);
  else if (!threadListSelectMode) loadThreadList();
});

// ---------------------------------------------------------------------------
// Thread list select mode — same shape as Dials' own (see enterSelectMode/
// exitSelectMode in js/dials.js): a header-menu button toggles it, a bar
// replaces the normal controls, tapping a row selects instead of opening it.
// ---------------------------------------------------------------------------

function enterThreadSelectMode() {
  threadListSelectMode = true;
  selectedThreadIds = new Set();
  closePageHeaderMenu();
  els.selectModeBar.classList.remove("hidden");
  renderThreadList();
}
function exitThreadSelectMode() {
  threadListSelectMode = false;
  selectedThreadIds = new Set();
  els.selectModeBar.classList.add("hidden");
  renderThreadList();
}
els.menuSelectBtn.addEventListener("click", enterThreadSelectMode);

function renderViewingPopup() {
  els.viewingPopup.querySelectorAll(".viewing-option").forEach((btn) => btn.classList.toggle("active", btn.dataset.folder === folderView));
}

function setFolderView(next) {
  folderView = next;
  els.menuFolderLabel.textContent = folderView === "spam" || folderView === "trash" || folderView === "scheduled" ? `Viewing: ${FOLDER_LABELS[folderView]}` : "Spam, Trash, Scheduled";
  // Select mode (mark unread / delete) only means something on the synced inbox.
  els.menuSelectBtn.classList.toggle("hidden", folderView !== "received");
  if (threadListSelectMode) exitThreadSelectMode();
  updateTitle();
  updateMailNote();
  exitDetail();
  loadThreadList();
}

els.menuFolderBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closePageHeaderMenu();
  renderViewingPopup();
  els.viewingPopup.classList.remove("hidden");
});
els.viewingPopupClose.addEventListener("click", () => els.viewingPopup.classList.add("hidden"));
els.viewingPopup.addEventListener("click", (e) => {
  if (e.target === els.viewingPopup) els.viewingPopupClose.click();
});
els.viewingPopup.querySelectorAll(".viewing-option").forEach((btn) => {
  btn.addEventListener("click", () => {
    els.viewingPopup.classList.add("hidden");
    if (btn.dataset.folder !== folderView) setFolderView(btn.dataset.folder);
  });
});
els.selectBackBtn.addEventListener("click", exitThreadSelectMode);
els.selectAllBtn.addEventListener("click", () => {
  if (selectedThreadIds.size === currentThreadRows.filter((t) => !isReadOnlyAccount(t.latest.account_id)).length) selectedThreadIds = new Set();
  else selectedThreadIds = new Set(currentThreadRows.filter((t) => !isReadOnlyAccount(t.latest.account_id)).map((t) => t.latest.thread_id));
  renderThreadList();
});

async function setSelectedThreadsReadState(isRead) {
  if (!selectedThreadIds.size) return;
  const { error } = await supabase
    .from("email_messages")
    .update({ is_read: isRead })
    .in("thread_id", [...selectedThreadIds])
    .eq("direction", "inbound");
  if (error) return showError(els.errorBox, error);
  exitThreadSelectMode();
  loadThreadList();
}
els.selectMarkUnreadBtn.addEventListener("click", () => setSelectedThreadsReadState(false));

els.selectDeleteBtn.addEventListener("click", () => {
  const count = selectedThreadIds.size;
  if (!count) return;
  els.confirmDeleteThreadsTitle.textContent = `Delete ${count} conversation${count === 1 ? "" : "s"}?`;
  els.confirmDeleteThreadsModal.classList.remove("hidden");
});
els.confirmDeleteThreadsNoBtn.addEventListener("click", () => els.confirmDeleteThreadsModal.classList.add("hidden"));
els.confirmDeleteThreadsYesBtn.addEventListener("click", async () => {
  els.confirmDeleteThreadsModal.classList.add("hidden");
  // Only deletes the local copy (email_messages/-attachments — RLS allows
  // this only for the mailbox's owner or an admin, same as who can reply/
  // compose). The actual email still exists in the mailbox; it just never
  // comes back, since email-sync's per-mailbox UID watermark only ever
  // looks for UIDs newer than the last one it already saw.
  const { error } = await supabase.from("email_messages").delete().in("thread_id", [...selectedThreadIds]);
  if (error) return showError(els.errorBox, error);
  exitThreadSelectMode();
  loadThreadList();
});

// ---------------------------------------------------------------------------
// Thread list
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100; // messages fetched per page; "Load more" pages back by sent_at

function accountIdsForQuery() {
  if (!canManageMail) return null; // intern without a mailbox: RLS alone scopes this to their own clients' messages
  return selectedMailboxIds(accounts);
}

// Accumulated paging state for the Received/feed list. Threads are derived from the fetched messages (newest first).
let listState = null; // { msgs: Map(id -> msg), oldest, hasMore, clientNames, loading }

const counterpart = (m) => (m.direction === "outbound" ? (m.to_addresses || [])[0]?.address : m.from_address) || "";

async function loadThreadList(loadMore = false) {
  // Sent is read live from the mailbox, except when every selected mailbox is a Microsoft one (nothing to read live):
  // then the copies the app itself saved when sending are shown instead.
  const liveReadable = (accountIdsForQuery() || []).some((id) => { const a = acctById(id); return !(a && isMsMailbox(a)); });
  if (canManageMail && folderView !== "received" && !(folderView === "sent" && !liveReadable)) return loadLiveFolder();
  els.errorBox.classList.add("hidden");
  const ids = accountIdsForQuery();
  if (ids && !ids.length) {
    els.wrap.innerHTML = `<div class="empty-state">No email connected yet — go to Profile → Edit to connect one.</div>`;
    return;
  }
  if (!loadMore || !listState) {
    els.wrap.innerHTML = `<div class="empty-state">Loading…</div>`;
    listState = { msgs: new Map(), oldest: null, hasMore: false, clientNames: {}, loading: false };
  }
  const state = listState;
  if (state.loading) return;
  state.loading = true;

  let query = supabase
    .from("email_messages")
    .select("id, thread_id, account_id, direction, from_address, from_name, to_addresses, subject, snippet, is_read, client_id, sent_at")
    .order("sent_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (ids) query = query.in("account_id", ids);
  if (canManageMail) query = query.eq("direction", folderView === "sent" ? "outbound" : "inbound");
  if (loadMore && state.oldest) query = query.lte("sent_at", state.oldest);
  const { data, error } = await query;
  state.loading = false;
  if (listState !== state) return; // selection/folder changed while loading
  if (error) {
    els.wrap.innerHTML = "";
    return showError(els.errorBox, error);
  }

  const fresh = (data || []).filter((m) => !state.msgs.has(m.id));
  fresh.forEach((m) => state.msgs.set(m.id, m));
  state.hasMore = (data || []).length === PAGE_SIZE && fresh.length > 0;
  if (data?.length) state.oldest = data[data.length - 1].sent_at;

  const clientIds = [...new Set(fresh.map((m) => m.client_id).filter((id) => id && !(id in state.clientNames)))];
  if (clientIds.length) {
    const { data: clients } = await supabase.from("clients").select("id, full_name").in("id", clientIds);
    for (const c of clients || []) state.clientNames[c.id] = c.full_name;
  }
  if (listState !== state) return;

  const threads = new Map(); // thread_id -> latest message (first seen, since sorted desc) + unread flag
  const ordered = [...state.msgs.values()].sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
  for (const m of ordered) {
    if (!threads.has(m.thread_id)) threads.set(m.thread_id, { latest: m, unread: false, clientName: m.client_id ? state.clientNames[m.client_id] : null });
    const t = threads.get(m.thread_id);
    if (m.direction === "inbound" && !m.is_read) t.unread = true;
  }
  currentThreadRows = [...threads.values()];
  renderThreadList();

  // Light enrichment after first paint: one dials query for the sequence badges, one count query for the picker.
  loadSequenceBadges(fresh.map(counterpart))
    .then((b) => {
      b.forEach((v, k) => seqBadges.set(k, v));
      if (listState === state && !detailThreadId && b.size) renderThreadList();
    })
    .catch(() => {});
  if (!loadMore) refreshUnread().catch(() => {});
}

// ---------------------------------------------------------------------------
// Live folders (Sent / Spam / Trash / Scheduled) — nothing here is stored in
// the app: every load asks the mailbox itself, over IMAP, through the
// email-live Edge Function (headers for the list, the full message only when
// one is opened). Scheduled also lists what Mass email has queued.
// ---------------------------------------------------------------------------

const LIVE_PAGE = 30;
let liveState = null; // { kind, items, accountState: Map(accountId -> {offset, hasMore}), scheduled: [] }

async function liveCall(body) {
  const {
    data: { session: authSession },
  } = await supabase.auth.getSession();
  const { data, error } = await supabase.functions.invoke("email-live", {
    body,
    headers: { Authorization: `Bearer ${authSession?.access_token || ""}` },
  });
  if (error) {
    // supabase-js hides the function's own message behind a generic "non-2xx" one; read the real text.
    let msg = "";
    try { msg = (await error.context.json())?.error || ""; } catch { /* keep generic */ }
    throw new Error(friendlyMailError(msg || error.message));
  }
  if (data?.error) throw new Error(friendlyMailError(data.error));
  return data;
}

// One short, plain line for a mailbox failure (never a raw IMAP/stack message).
function friendlyMailError(msg) {
  const m = String(msg || "");
  if (/basic authentication is disabled|office ?365|outlook/i.test(m)) return MS_PENDING_NOTE;
  if (/login failed|AUTHENTICATIONFAILED|invalid credentials/i.test(m)) return "The mailbox sign-in was refused";
  if (/timed? ?out|ECONN|network|connect/i.test(m)) return "The mailbox didn't respond";
  return "Couldn't read this mailbox right now";
}

// Downloads one attachment of a live-read message: asks email-live for the
// bytes and saves them through an <a download> click (same reasoning as the
// stored-attachment downloader in openThread).
async function downloadLiveAttachment(link, { accountId, kind, uid, index }) {
  if (link.dataset.busy) return;
  link.dataset.busy = "1";
  const original = link.textContent;
  link.textContent = "Opening…";
  try {
    const att = await liveCall({ action: "attachment", account_id: accountId, kind, uid, index });
    const bytes = Uint8Array.from(atob(att.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: att.content_type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = att.filename || "attachment";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    showError(els.errorBox, err);
  } finally {
    link.textContent = original;
    delete link.dataset.busy;
  }
}

function liveFormatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function mailboxEmail(accountId) {
  const a = acctById(accountId);
  return a ? (a.mine ? a.email_address : `${a.email_address} (${a.ownerName})`) : "";
}

async function loadLiveFolder(loadMore = false) {
  const kind = folderView;
  els.errorBox.classList.add("hidden");
  const all = accountIdsForQuery() || [];
  if (!all.length) {
    els.wrap.innerHTML = `<div class="empty-state">No email connected yet — go to Profile → Edit to connect one.</div>`;
    return;
  }
  // Microsoft 365 mailboxes can't be opened over IMAP yet: skip them (the note above the list says so once).
  const ids = all.filter((id) => { const a = acctById(id); return !(a && isMsMailbox(a)); });
  if (!ids.length && kind !== "scheduled") {
    liveState = null;
    els.wrap.innerHTML = `<div class="empty-state">${MS_PENDING_NOTE}.</div>`;
    return;
  }
  if (!loadMore) {
    els.wrap.innerHTML = `<div class="empty-state">Loading from the mailbox…</div>`;
    liveState = { kind, items: [], accountState: new Map(), scheduled: [], failures: [] };
  }
  const state = liveState;
  const targets = ids.filter((id) => !loadMore || state.accountState.get(id)?.hasMore);
  // A few mailboxes at a time (each is a live IMAP login), never all of them at once.
  const results = [];
  for (let i = 0; i < targets.length; i += 5) {
    results.push(
      ...(await Promise.all(
        targets.slice(i, i + 5).map(async (id) => {
          const offset = loadMore ? state.accountState.get(id).offset : 0;
          try {
            return { id, data: await liveCall({ action: "list", account_id: id, kind, offset, limit: LIVE_PAGE }) };
          } catch (e) {
            return { id, error: e };
          }
        })
      ))
    );
    if (folderView !== kind || liveState !== state) return;
  }
  if (folderView !== kind || liveState !== state) return; // user switched away while loading
  for (const r of results) {
    if (r.error) {
      state.failures.push(`${mailboxEmail(r.id)}: ${r.error.message || r.error}`);
      state.accountState.set(r.id, { offset: 0, hasMore: false });
      continue;
    }
    for (const it of r.data.items || []) state.items.push({ ...it, accountId: r.id });
    const prev = loadMore ? state.accountState.get(r.id).offset : 0;
    state.accountState.set(r.id, { offset: prev + (r.data.items || []).length, hasMore: !!r.data.has_more });
  }
  state.items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  if (kind === "scheduled") {
    const { data } = await supabase
      .from("scheduled_emails")
      .select("id, account_id, recipient_name, to_address, subject, send_at, status, error")
      .in("account_id", all)
      .in("status", ["pending", "sending", "failed"])
      .order("send_at", { ascending: true });
    state.scheduled = (data || []).filter((r) => r.status !== "failed" || Date.now() - new Date(r.send_at).getTime() < 3 * 86400000);
  }
  renderLiveFolder();
}

function renderLiveFolder() {
  const state = liveState;
  const multi = accountIdsForQuery().length > 1;
  const showTo = state.kind === "sent" || state.kind === "scheduled";
  const parts = [];
  if (state.failures.length) {
    const shown = state.failures.slice(0, 3).map(escapeHtml);
    if (state.failures.length > 3) shown.push(`and ${state.failures.length - 3} more mailboxes couldn't be read`);
    parts.push(`<div class="mail-note">${shown.join("<br>")}</div>`);
  }
  if (state.kind === "scheduled") {
    parts.push(
      state.scheduled
        .map(
          (r) => `
      <div class="mobile-card message-thread-row" data-scheduled-id="${escapeHtml(r.id)}">
        <div class="mc-main">
          <div class="mc-name">To: ${escapeHtml(r.recipient_name || r.to_address)}
            <span class="message-client-badge">${r.status === "failed" ? "Failed" : r.status === "sending" ? "Sending" : "Scheduled"}</span></div>
          <div class="mc-sub">${escapeHtml(r.subject || "(no subject)")}</div>
          <div class="mc-sub faint">${r.status === "failed" ? escapeHtml(r.error || "Send failed") : `Goes out ${escapeHtml(new Date(r.send_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}`}${multi ? ` · ${escapeHtml(mailboxEmail(r.account_id))}` : ""}</div>
        </div>
        ${r.status === "pending" && canWriteAccount(r.account_id) ? `<button type="button" class="btn secondary small" data-cancel-scheduled="${escapeHtml(r.id)}" style="flex-shrink:0;">Cancel</button>` : ""}
      </div>`
        )
        .join("")
    );
  }
  parts.push(
    state.items
      .map((m, i) => {
        const who = showTo
          ? `To: ${(m.to || []).map((a) => a.name || a.address).join(", ") || "(unknown)"}`
          : m.from.name || m.from.address;
        return `
      <div class="mobile-card message-thread-row ${m.seen ? "" : "unread"}" data-live-index="${i}">
        <div class="mc-main">
          <div class="mc-name">${!m.seen && state.kind !== "sent" ? `<span class="message-unread-dot"></span>` : ""}${escapeHtml(who)}</div>
          <div class="mc-sub">${escapeHtml(m.subject || "(no subject)")}</div>
          ${multi ? `<div class="mc-sub faint">${escapeHtml(mailboxEmail(m.accountId))}</div>` : ""}
        </div>
        <div class="mc-sub faint" style="flex-shrink:0;">${escapeHtml(liveFormatDate(m.date))}</div>
      </div>`;
      })
      .join("")
  );
  const empty = !state.items.length && !(state.kind === "scheduled" && state.scheduled.length);
  const hasMore = [...state.accountState.values()].some((s) => s.hasMore);
  els.wrap.innerHTML = empty
    ? `<div class="empty-state">${state.failures.length ? parts.join("") : `Nothing in ${FOLDER_LABELS[state.kind]}.`}</div>`
    : `<div class="team-member-list">${parts.join("")}${hasMore ? `<button type="button" class="btn secondary" id="liveLoadMoreBtn" style="margin:8px auto; display:block;">Load more</button>` : ""}</div>`;

  els.wrap.querySelectorAll("[data-live-index]").forEach((row) => {
    row.addEventListener("click", () => openLiveMessage(state.items[Number(row.dataset.liveIndex)]));
  });
  els.wrap.querySelectorAll("[data-cancel-scheduled]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      const { error } = await supabase.from("scheduled_emails").update({ status: "cancelled" }).eq("id", btn.dataset.cancelScheduled).eq("status", "pending");
      if (error) {
        btn.disabled = false;
        return showError(els.errorBox, error);
      }
      state.scheduled = state.scheduled.filter((r) => r.id !== btn.dataset.cancelScheduled);
      renderLiveFolder();
    });
  });
  const more = document.getElementById("liveLoadMoreBtn");
  if (more) {
    more.addEventListener("click", async () => {
      more.disabled = true;
      more.textContent = "Loading…";
      await loadLiveFolder(true);
    });
  }
}

async function openLiveMessage(item) {
  const state = liveState;
  els.errorBox.classList.add("hidden");
  els.wrap.innerHTML = `<div class="empty-state">Opening…</div>`;
  let msg;
  try {
    msg = (await liveCall({ action: "get", account_id: item.accountId, kind: state.kind, uid: item.uid })).message;
  } catch (e) {
    renderLiveFolder();
    return showError(els.errorBox, e);
  }
  const date = msg.date ? new Date(msg.date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const person = (p, clickable) =>
    `<span class="thread-participant-name"${clickable ? ` data-participant-address="${escapeHtml(p.address)}"` : ""}>${escapeHtml(p.name || p.address)}</span>`;
  const body = msg.html
    ? `<iframe class="thread-message-html" sandbox="allow-same-origin" srcdoc="${escapeHtml(msg.html)}"></iframe>`
    : `<div class="thread-message-text">${escapeHtml(msg.text || "").replace(/\n/g, "<br>")}</div>`;
  const atts = msg.attachments.length
    ? `<div class="thread-message-attachments">${msg.attachments
        .map((a) => `<a href="#" data-live-att="${a.index}" class="thread-attachment-chip">${escapeHtml(a.filename || "attachment")}</a>`)
        .join("")}</div>`
    : "";
  els.wrap.innerHTML = `
    <div class="thread-detail">
      <h2 class="thread-detail-subject">${escapeHtml(msg.subject || "(no subject)")}</h2>
      <div class="thread-message">
        <div class="thread-message-header">
          <span class="thread-message-from">${person(msg.from, state.kind !== "sent")}</span>
          <span class="thread-message-date">${escapeHtml(date)}</span>
        </div>
        <div class="thread-message-to">To: ${(msg.to || []).map((p) => person(p, state.kind === "sent")).join(", ")}</div>
        ${body}
        ${atts}
      </div>
      <div class="thread-detail-actions">
        <button type="button" class="btn secondary" id="liveBackBtn">Back</button>
      </div>
    </div>`;
  document.getElementById("liveBackBtn").addEventListener("click", renderLiveFolder);
  els.wrap.querySelectorAll("[data-participant-address]").forEach((el) => el.addEventListener("click", () => openParticipantRecord(el.dataset.participantAddress)));
  els.wrap.querySelectorAll(".thread-message-html").forEach((frame) => {
    frame.addEventListener("load", () => {
      try {
        frame.style.height = "0px";
        const doc = frame.contentDocument;
        frame.style.height = `${(doc?.body?.scrollHeight || doc?.documentElement?.scrollHeight || 80) + 4}px`;
      } catch {
        frame.style.height = "";
      }
    });
  });
  els.wrap.querySelectorAll("[data-live-att]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      downloadLiveAttachment(link, { accountId: item.accountId, kind: state.kind, uid: item.uid, index: Number(link.dataset.liveAtt) });
    });
  });
}

function renderThreadList() {
  const rows = currentThreadRows;
  if (!rows.length) {
    els.wrap.innerHTML = `<div class="empty-state">${folderView === "sent" && canManageMail ? "No sent messages yet." : "Your inbox is empty."}</div>`;
    return;
  }

  const formatDate = (iso) => {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const participantLabel = (m) => {
    if (m.direction === "outbound") {
      const to = (m.to_addresses || []).map((a) => a.name || a.address).filter(Boolean);
      return to.length ? `To: ${to.join(", ")}` : "To: (unknown)";
    }
    return m.from_name || m.from_address;
  };

  const multi = canManageMail && (accountIdsForQuery() || []).length > 1;
  const hasMore = !!listState?.hasMore;
  els.wrap.innerHTML = `<div class="team-member-list">${rows
    .map((t) => {
      const acct = acctById(t.latest.account_id);
      const ro = isReadOnlyAccount(t.latest.account_id);
      const seq = seqBadges.get(counterpart(t.latest).toLowerCase());
      t.readOnly = ro;
      return `
    <div class="mobile-card message-thread-row ${t.unread ? "unread" : ""} ${ro ? "readonly" : ""}" data-thread-id="${escapeHtml(t.latest.thread_id)}">
      <div class="mc-main">
        <div class="mc-name">
          ${t.unread ? `<span class="message-unread-dot"></span>` : ""}${escapeHtml(participantLabel(t.latest))}
          ${t.clientName ? `<span class="message-client-badge">${escapeHtml(t.clientName)}</span>` : ""}
        </div>
        <div class="mc-sub">${escapeHtml(t.latest.subject || "(no subject)")}</div>
        <div class="mc-sub faint">${escapeHtml(t.latest.snippet || "")}</div>
        ${(multi && acct) || seq ? `<div>${multi && acct ? `<span class="message-mailbox-chip">${escapeHtml(acct.email_address)}${acct.mine ? "" : ` · ${escapeHtml(ownerFirstName(acct))}`}</span>` : ""}${seq ? `<span class="message-seq-badge ${seq.replied ? "replied" : ""}">${escapeHtml(seq.label)}</span>` : ""}</div>` : ""}
      </div>
      ${
        threadListSelectMode
          ? `<div class="select-circle ${selectedThreadIds.has(t.latest.thread_id) ? "selected" : ""}"></div>`
          : `<div class="mc-sub faint" style="flex-shrink:0;">${escapeHtml(formatDate(t.latest.sent_at))}</div>`
      }
    </div>`;
    })
    .join("")}${hasMore ? `<button type="button" class="btn secondary" id="threadLoadMoreBtn" style="margin:8px auto; display:block;">Load more</button>` : ""}</div>`;
  const moreBtn = document.getElementById("threadLoadMoreBtn");
  if (moreBtn)
    moreBtn.addEventListener("click", async () => {
      moreBtn.disabled = true;
      moreBtn.textContent = "Loading…";
      await loadThreadList(true);
    });

  els.wrap.querySelectorAll(".message-thread-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.threadId;
      if (threadListSelectMode) {
        // Someone else's mailbox (a lead viewing an intern) is read-only: can't be marked unread or deleted.
        if (currentThreadRows.find((t) => t.latest.thread_id === id)?.readOnly) return;
        if (selectedThreadIds.has(id)) selectedThreadIds.delete(id);
        else selectedThreadIds.add(id);
        renderThreadList();
        return;
      }
      openThread(id);
    });
  });
}

// ---------------------------------------------------------------------------
// Thread detail
// ---------------------------------------------------------------------------

function exitDetail() {
  detailThreadId = null;
}

// Clicking a participant's name jumps straight to the Client or Dial record
// their address is attached to (clients checked first, then dials — see
// dials.html's own ?dial= deep link, added alongside clients.html's
// existing ?client= one). A brief live lookup rather than something baked
// into the message row at sync time, since most participants won't match
// anything at all and this only ever needs to run once, on click.
async function openParticipantRecord(address) {
  if (!address) return;
  const { data: client } = await supabase.from("clients").select("id").ilike("email", address).limit(1).maybeSingle();
  if (client) {
    window.location.href = `clients.html?client=${encodeURIComponent(client.id)}&tab=timeline`;
    return;
  }
  const { data: dial } = await supabase.from("dials").select("id").ilike("email", address).limit(1).maybeSingle();
  if (dial) {
    window.location.href = `dials.html?dial=${encodeURIComponent(dial.id)}`;
  }
}

// "Done" on a reply opened from the call sheet: complete that company's pending reply task, then back to Calls.
async function finishReplyTask(btn) {
  btn.disabled = true;
  try {
    const { data: ds } = await supabase.from("dials").select("id").ilike("email", replyFrom);
    const ids = (ds || []).map((d) => d.id);
    if (ids.length) {
      const { data: ts } = await supabase.from("sequence_tasks").select("id").eq("kind", "reply").in("dial_id", ids).not("status", "in", "(done,skipped)").limit(5);
      for (const t of ts || []) {
        const { error } = await supabase.rpc("complete_sequence_task", { p_task_id: t.id, p_outcome: "done", p_note: null, p_skip: false });
        if (error) throw error;
      }
    }
    window.location.href = "dials.html";
  } catch (e) {
    btn.disabled = false;
    showError(els.errorBox, e);
  }
}

async function openThread(threadId) {
  detailThreadId = threadId;
  els.errorBox.classList.add("hidden");
  els.wrap.innerHTML = `<div class="empty-state">Loading…</div>`;

  const { data: msgs, error } = await supabase
    .from("email_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("sent_at", { ascending: true });
  if (error) {
    els.wrap.innerHTML = "";
    return showError(els.errorBox, error);
  }
  if (!msgs?.length) {
    els.wrap.innerHTML = `<div class="empty-state">This conversation is empty.</div>`;
    return;
  }

  const msgIds = msgs.map((m) => m.id);
  const { data: attachments } = await supabase.from("email_attachments").select("*").in("message_id", msgIds);
  const attachmentsByMessage = {};
  for (const a of attachments || []) {
    (attachmentsByMessage[a.message_id] ||= []).push(a);
  }

  // Stored inbound mail is a preview only (no body, no attachment files) —
  // read the full message live from the mailbox by its IMAP UID. Falls back
  // to the stored snippet if the mailbox can't be reached or the message is
  // gone. Messages that still carry a stored body (older ones, and what this
  // app sent itself) render from that as before.
  const liveById = {};
  if (canManageMail) {
    await Promise.all(
      msgs
        .filter((m) => m.direction === "inbound" && !m.body_html && !m.body_text && m.imap_uid)
        .map(async (m) => {
          try {
            liveById[m.id] = (await liveCall({ action: "get", account_id: m.account_id, kind: "inbox", uid: m.imap_uid })).message;
          } catch (e) {
            liveById[m.id] = { error: e.message || String(e) };
          }
        })
    );
  }

  const last = msgs[msgs.length - 1];
  const readOnly = isReadOnlyAccount(last.account_id);
  const canReply = canManageMail && canWriteAccount(last.account_id);
  // An intern without a mailbox of their own replies through their team lead's mailbox (the same quick-send as the Email icon).
  const internQuickReply = !canReply && isIntern && !!getTeamLeadMailbox() && last.direction === "inbound";
  const acct = acctById(last.account_id);
  const showChip = canManageMail && acct && (accountIdsForQuery() || []).length > 1;
  const seqAddr = counterpart(last).toLowerCase();
  if (seqAddr && !seqBadges.has(seqAddr)) {
    const b = await loadSequenceBadges([seqAddr]).catch(() => new Map());
    b.forEach((v, k) => seqBadges.set(k, v));
  }
  const seq = seqBadges.get(seqAddr);

  els.wrap.innerHTML = `
    <div class="thread-detail">
      ${readOnly ? `<div class="readonly-banner">Viewing ${escapeHtml(ownerFirstName(acct))}'s inbox (read-only)</div>` : ""}
      ${showChip || seq ? `<div style="margin-bottom:6px;">${showChip ? `<span class="message-mailbox-chip">${escapeHtml(acct.email_address)}</span>` : ""}${seq ? `<span class="message-seq-badge ${seq.replied ? "replied" : ""}">${escapeHtml(seq.label)}</span>` : ""}</div>` : ""}
      <h2 class="thread-detail-subject">${escapeHtml(msgs.find((m) => m.subject)?.subject || "(no subject)")}</h2>
      ${msgs.map((m) => threadMessageHTML(m, attachmentsByMessage[m.id] || [], liveById[m.id])).join("")}
      <div class="thread-detail-actions">
        <button type="button" class="btn secondary" id="threadBackBtn">Back</button>
        ${canReply || internQuickReply ? `<button type="button" class="btn secondary" id="threadReplyBtn">Reply</button>` : ""}
        ${replyFrom && threadId === replyThreadId ? `<button type="button" class="btn" id="threadDoneBtn">Done</button>` : ""}
      </div>
    </div>
  `;

  document.getElementById("threadBackBtn").addEventListener("click", () => {
    exitDetail();
    loadThreadList();
  });
  const doneBtn = document.getElementById("threadDoneBtn");
  if (doneBtn) doneBtn.addEventListener("click", () => finishReplyTask(doneBtn));
  const replyBtn = document.getElementById("threadReplyBtn");
  if (replyBtn && internQuickReply) {
    replyBtn.addEventListener("click", () => {
      const subj = last.subject || "";
      openQuickSend({ accountId: getTeamLeadMailbox().accountId, to: last.from_address, subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`, body: "" });
    });
  } else if (replyBtn) {
    replyBtn.addEventListener("click", () => {
      const other = last.direction === "outbound" ? (last.to_addresses || [])[0]?.address : last.from_address;
      openCompose({
        mode: "reply",
        accountId: last.account_id,
        to: other ? [other] : [],
        subject: (last.subject || "").match(/^re:/i) ? last.subject : `Re: ${last.subject || ""}`,
        inReplyTo: last.message_id,
        threadId: last.thread_id,
      });
    });
  }

  // An iframe has no intrinsic content height, so a fixed CSS height either
  // clips a long email or leaves a wall of dead space under a short one —
  // resize each one to its own rendered content height once it's loaded.
  els.wrap.querySelectorAll(".thread-message-html").forEach((frame) => {
    frame.addEventListener("load", () => {
      try {
        // scrollHeight on an iframe at its normal (unset/min-height) size
        // just reports that existing viewport size back — short content
        // doesn't overflow it, so there's nothing for the browser to
        // consider "scrollable" and shrink-wrap. Collapsing to 0 first
        // forces the document to report its real content height instead
        // (a well-known iframe-autosize technique), then growing to that.
        frame.style.height = "0px";
        const doc = frame.contentDocument;
        const h = doc?.body?.scrollHeight || doc?.documentElement?.scrollHeight;
        frame.style.height = `${(h || 80) + 4}px`;
      } catch {
        // sandboxed cross-document access can still throw in some browsers
        // even for a same-content srcdoc frame — the min-height fallback
        // (see .thread-message-html in css/style.css) covers this case.
        frame.style.height = "";
      }
    });
  });

  // Attachment chips: download the file (the bucket is private, so it's
  // fetched with the signed-in session rather than linked). This used to
  // createSignedUrl() and then window.open() the result — but that open
  // happens after an await, outside the tap's own user gesture, so Safari/
  // iOS and installed (PWA) mode silently blocked the pop-up and nothing
  // ever appeared. Downloading the bytes and saving them through an <a
  // download> click works in every browser, and stays inside the app.
  els.wrap.querySelectorAll("[data-attachment-path]").forEach((link) => {
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      if (link.dataset.busy) return;
      link.dataset.busy = "1";
      const original = link.textContent;
      link.textContent = "Opening…";
      try {
        const { data: blob, error: dlErr } = await supabase.storage.from("email-attachments").download(link.dataset.attachmentPath);
        if (dlErr || !blob) throw dlErr || new Error("Could not open that attachment.");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = link.dataset.attachmentName || "attachment";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (err) {
        showError(els.errorBox, err);
      } finally {
        link.textContent = original;
        delete link.dataset.busy;
      }
    });
  });

  els.wrap.querySelectorAll("[data-live-account]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      downloadLiveAttachment(link, {
        accountId: link.dataset.liveAccount,
        kind: link.dataset.liveKind,
        uid: Number(link.dataset.liveUid),
        index: Number(link.dataset.liveAtt),
      });
    });
  });

  // Participant name → their Client/Dial record (see openParticipantRecord).
  els.wrap.querySelectorAll("[data-participant-address]").forEach((el) => {
    el.addEventListener("click", () => openParticipantRecord(el.dataset.participantAddress));
  });

  // Mark inbound unread messages in this thread as read.
  // (Skipped on someone else's mailbox: read-only for a lead, and RLS would reject the update anyway.)
  const unreadIds = readOnly ? [] : msgs.filter((m) => m.direction === "inbound" && !m.is_read).map((m) => m.id);
  if (unreadIds.length) {
    await supabase.from("email_messages").update({ is_read: true }).in("id", unreadIds);
    refreshUnread().catch(() => {});
  }
}

// Mail servers' delivery reports (and some senders) attach parts with no
// filename, which get stored as just "attachment" — give those a name and
// extension that matches what they are so the saved file opens properly.
function attachmentDisplayName(a) {
  if (a.filename && a.filename !== "attachment") return a.filename;
  const type = (a.content_type || "").toLowerCase();
  if (type === "message/rfc822") return "original-message.eml";
  if (type === "text/rfc822-headers") return "message-headers.txt";
  if (type === "message/delivery-status") return "delivery-status.txt";
  if (type.startsWith("text/")) return "attachment.txt";
  return "attachment";
}

function threadMessageHTML(m, atts, live) {
  const date = new Date(m.sent_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fromLabel = m.direction === "outbound" ? `${m.from_name || m.from_address} (you)` : m.from_name || m.from_address;
  const fromClickable = m.direction === "outbound" ? "" : ` data-participant-address="${escapeHtml(m.from_address)}"`;
  const toEntries = m.to_addresses || [];
  const toLabel = toEntries
    .map((a) => `<span class="thread-participant-name"${m.direction === "outbound" ? ` data-participant-address="${escapeHtml(a.address)}"` : ""}>${escapeHtml(a.name || a.address)}</span>`)
    .join(", ");
  // `live`: the message read straight from the mailbox (see openThread) —
  // { html, text, attachments } — or { error } if that failed.
  const html = m.body_html || (live && live.html);
  const text = m.body_text || (live && live.text);
  const bodyHTML = html
    ? // allow-same-origin without allow-scripts: still fully blocks any script
      // in the email HTML from running (that's what actually matters for
      // safety), but lets this page measure the iframe's own contentDocument
      // to resize it to its real content height (see the load listener
      // above) — a fully opaque sandbox="" origin blocks that measurement
      // too, not just script execution.
      `<iframe class="thread-message-html" sandbox="allow-same-origin" srcdoc="${escapeHtml(html)}"></iframe>`
    : text
      ? `<div class="thread-message-text">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`
      : `<div class="thread-message-text">${escapeHtml(m.snippet || "")}${live && live.error ? `<div class="help-text">Couldn't load the full message from the mailbox (${escapeHtml(live.error)}).</div>` : ""}</div>`;
  const liveAtts = live && live.attachments ? live.attachments : [];
  const liveAttsHTML = liveAtts.length
    ? `<div class="thread-message-attachments">${liveAtts
        .map(
          (a) =>
            `<a href="#" data-live-att="${a.index}" data-live-account="${escapeHtml(m.account_id)}" data-live-uid="${escapeHtml(m.imap_uid)}" data-live-kind="inbox" class="thread-attachment-chip">${escapeHtml(a.filename || "attachment")}</a>`
        )
        .join("")}</div>`
    : "";
  const attsHTML = liveAttsHTML || (atts.length
    ? `<div class="thread-message-attachments">${atts
        .map(
          (a) =>
            `<a href="#" data-attachment-path="${escapeHtml(a.storage_path)}" data-attachment-name="${escapeHtml(attachmentDisplayName(a))}" class="thread-attachment-chip">${escapeHtml(attachmentDisplayName(a))}</a>`
        )
        .join("")}</div>`
    : "");
  return `
    <div class="thread-message ${m.direction}">
      <div class="thread-message-header">
        <span class="thread-message-from thread-participant-name"${fromClickable}>${escapeHtml(fromLabel)}</span>
        <span class="thread-message-date">${escapeHtml(date)}</span>
      </div>
      <div class="thread-message-to">To: ${toLabel}</div>
      ${bodyHTML}
      ${attsHTML}
    </div>`;
}

// ---------------------------------------------------------------------------
// Compose / reply
// ---------------------------------------------------------------------------

function wireComposeToolbar() {
  els.composeToolbar.querySelectorAll("[data-cmd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.composeBody.focus();
      if (btn.dataset.cmd === "createLink") {
        const url = prompt("Link URL:");
        if (url) document.execCommand("createLink", false, url);
        return;
      }
      document.execCommand(btn.dataset.cmd, false);
    });
  });
}
wireComposeToolbar();

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

els.composeAttachInput.addEventListener("change", async () => {
  for (const file of els.composeAttachInput.files) {
    const base64 = await fileToBase64(file);
    pendingCompose.attachments.push({ filename: file.name, contentType: file.type || "application/octet-stream", base64 });
  }
  els.composeAttachInput.value = "";
  renderComposeAttachments();
});
function renderComposeAttachments() {
  els.composeAttachmentsList.innerHTML = (pendingCompose?.attachments || [])
    .map((a, i) => `<span class="compose-attachment-chip">${escapeHtml(a.filename)} <button type="button" data-idx="${i}">&times;</button></span>`)
    .join("");
  els.composeAttachmentsList.querySelectorAll("button[data-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingCompose.attachments.splice(Number(btn.dataset.idx), 1);
      renderComposeAttachments();
    });
  });
}

function openCompose({ mode, accountId, to, subject, body, inReplyTo, threadId }) {
  // Sending needs one of YOUR OWN connected mailboxes (Profile -> Edit).
  if (!accounts.some((a) => a.mine)) {
    showConnectEmailNotice();
    return;
  }
  pendingCompose = { mode, inReplyTo, threadId, accountId, attachments: [] };
  els.composeError.classList.add("hidden");
  els.composeTitle.textContent = mode === "reply" ? "Reply" : "New message";
  els.composeToInput.value = (to || []).join(", ");
  els.composeCcInput.value = "";
  els.composeSubjectInput.value = subject || "";
  els.composeBody.innerHTML = body ? escapeHtml(body).replace(/\n/g, "<br>") : "";
  renderComposeAttachments();

  // From: only mailboxes you own (an admin may also send from anyone's, listed after their own).
  const usable = accounts.filter((a) => a.mine || isAdmin).sort((x, y) => Number(y.mine) - Number(x.mine));
  els.composeFromSelect.innerHTML = usable.map((a) => `<option value="${a.id}">${escapeHtml(mailboxLabel(a))}</option>`).join("");
  // Default sender: the email at the top of your list (Profile -> Edit), if
  // it's connected; otherwise your first connected one.
  const topEmail = (profile.email || "").toLowerCase();
  const defaultAccountId =
    accountId ||
    usable.find((a) => a.mine && (a.email_address || "").toLowerCase() === topEmail)?.id ||
    usable.find((a) => a.mine && !(quotaCache.get(a.id) && quotaCache.get(a.id).left <= 0))?.id ||
    usable.find((a) => a.mine)?.id ||
    usable[0]?.id;
  if (defaultAccountId) els.composeFromSelect.value = defaultAccountId;
  els.composeFromRow.classList.toggle("hidden", mode === "reply");

  els.composeModal.classList.remove("hidden");
  lockPageScroll();
  els.composeToInput.focus();
  refreshComposeQuota(usable);
}

// Remaining sends today per mailbox (rpc mailbox_daily_quota). Cached per page load, dropped after each send.
let quotaCache = new Map();
function currentComposeAccountId() {
  return pendingCompose?.mode === "reply" && pendingCompose.accountId ? pendingCompose.accountId : els.composeFromSelect.value;
}
function renderComposeQuota() {
  const note = document.getElementById("composeQuotaNote");
  const id = currentComposeAccountId();
  const a = acctById(id);
  const q = quotaCache.get(id);
  let text = "";
  let full = false;
  if (q) {
    full = q.left <= 0;
    text = full
      ? `${a?.email_address || "This mailbox"} has reached its daily limit (${q.sent} sent${q.scheduled ? `, ${q.scheduled} scheduled` : ""} of ${q.daily_limit}). Pick another mailbox or try again later.`
      : `${q.left} of ${q.daily_limit} sends left today from ${a?.email_address || "this mailbox"}${q.scheduled ? ` (${q.scheduled} scheduled)` : ""}.`;
  }
  if (a?.send_paused_reason) text += `${text ? " " : ""}Sending is paused on this mailbox: ${a.send_paused_reason}`;
  note.textContent = text;
  note.classList.toggle("hidden", !text);
  note.classList.toggle("full", full);
  els.composeSendBtn.disabled = full;
  [...els.composeFromSelect.options].forEach((o) => {
    const oq = quotaCache.get(o.value);
    const base = mailboxLabel(acctById(o.value));
    o.textContent = oq ? `${base} — ${oq.left}/${oq.daily_limit} left today` : base;
    o.disabled = !!oq && oq.left <= 0 && o.value !== els.composeFromSelect.value;
  });
}
async function refreshComposeQuota(usable) {
  const own = usable.filter((a) => a.mine).map((a) => a.id);
  const ids = [...new Set([...own, currentComposeAccountId()].filter(Boolean))].slice(0, 12);
  quotaCache = new Map([...quotaCache].filter(([k]) => !ids.includes(k)));
  (await loadQuotas(ids)).forEach((v, k) => quotaCache.set(k, v));
  if (pendingCompose) renderComposeQuota();
}
els.composeFromSelect.addEventListener("change", async () => {
  const id = els.composeFromSelect.value;
  if (!quotaCache.has(id)) (await loadQuotas([id])).forEach((v, k) => quotaCache.set(k, v));
  if (pendingCompose) renderComposeQuota();
});
function closeCompose() {
  els.composeModal.classList.add("hidden");
  unlockPageScroll();
  pendingCompose = null;
  els.composeSendBtn.disabled = false;
}
els.composeCancelBtn.addEventListener("click", closeCompose);
els.composeCloseBtn.addEventListener("click", closeCompose);
els.composeFabBtn.addEventListener("click", () => openCompose({ mode: "new" }));

els.composeSendBtn.addEventListener("click", async () => {
  const accountId = currentComposeAccountId();
  const to = els.composeToInput.value.split(",").map((s) => s.trim()).filter(Boolean);
  const cc = els.composeCcInput.value.split(",").map((s) => s.trim()).filter(Boolean);
  const subject = els.composeSubjectInput.value.trim();
  const html = els.composeBody.innerHTML.trim();
  const text = els.composeBody.innerText.trim();

  els.composeError.classList.add("hidden");
  if (!accountId) return showError(els.composeError, new Error("Choose which mailbox to send from."));
  if (!to.length) return showError(els.composeError, new Error("Add at least one recipient."));
  if (!text && !html) return showError(els.composeError, new Error("Write a message first."));

  els.composeSendBtn.disabled = true;
  els.composeSendBtn.textContent = "Sending…";
  const {
    data: { session: authSession },
  } = await supabase.auth.getSession();
  const { data, error } = await supabase.functions.invoke("email-send", {
    body: {
      account_id: accountId,
      to,
      cc,
      subject,
      text,
      html,
      in_reply_to: pendingCompose.inReplyTo,
      thread_id: pendingCompose.threadId,
      attachments: pendingCompose.attachments,
    },
    headers: { Authorization: `Bearer ${authSession?.access_token || ""}` },
  });
  els.composeSendBtn.disabled = false;
  els.composeSendBtn.textContent = "Send";
  quotaCache.delete(accountId);

  if (error || data?.error) {
    return showError(els.composeError, error || new Error(data.error));
  }
  const openThreadId = data.thread_id;
  closeCompose();
  if (openThreadId) await openThread(openThreadId);
  else await loadThreadList();
  // The message went out, but say so plainly if anything about it wasn't
  // clean (a recipient the mail server refused, or no copy filed in the
  // mailbox's real Sent folder) rather than silently looking fine.
  const notes = [];
  if (data.warning) notes.push(data.warning);
  if (data.saved_to_sent === false) notes.push("A copy couldn't be saved to the mailbox's Sent folder.");
  if (notes.length) showError(els.errorBox, new Error(notes.join(" ")));
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

await loadAccounts();
setupInboxUi();
updateTitle();
updateMailNote();
await loadThreadList();
refreshUnread().catch(() => {});

// Auto-sync on opening the Messages tab (team leads/admins only — an intern
// has no mailboxes of their own, and email-sync rejects them anyway). Runs
// in the background after the list has already rendered from what's stored,
// so the page is usable immediately; the spinner by the title shows it's
// working, and the list refreshes itself when it finishes. A failure here is
// deliberately quiet (the 2-minute background sync keeps running regardless,
// and a manual "Sync now" still reports errors).
if (canManageMail && accounts.length) {
  runSync().then((result) => {
    if (result.ok) refreshAfterSync();
    else console.error("Auto-sync failed", result.error);
  });
}

// Deep link from the Clients/Dials email quick-action icon (team lead/admin
// only — see contactIcons.js's emailActionHTML): ?compose=1&to=&subject=&body=
// opens straight into a new-message compose, prefilled.
// ?from=<address>: open the newest email from that person (Dials "Read reply" button).
{
  const from = new URLSearchParams(window.location.search).get("from");
  if (from) {
    window.history.replaceState({}, "", "messages.html");
    const { data: hit } = await supabase.from("email_messages").select("thread_id")
      .eq("direction", "inbound").ilike("from_address", from.trim()).order("sent_at", { ascending: false }).limit(1);
    if (hit && hit[0]?.thread_id) { replyThreadId = hit[0].thread_id; await openThread(replyThreadId); }
    else {
      els.wrap.innerHTML = `<div class="empty-state">That reply isn't in the inbox yet.<div class="thread-detail-actions"><button type="button" class="btn" id="threadDoneBtn">Done</button></div></div>`;
      document.getElementById("threadDoneBtn").addEventListener("click", (e) => finishReplyTask(e.currentTarget));
    }
  }
}
if (canManageMail) {
  const params = new URLSearchParams(window.location.search);
  if (params.get("compose") === "1") {
    const to = params.get("to") || "";
    const subject = params.get("subject") || "";
    const body = params.get("body") || "";
    window.history.replaceState({}, "", "messages.html");
    // A "Re: …" subject here means Dials' Recommended SECOND email (the only
    // thing that builds such a link): thread it onto the first email already
    // sent to this address, from the same mailbox. If that first email was
    // never sent, fall back to a plain new message with the bare subject.
    const prior = isReplySubject(subject) ? await findPriorOutbound(to, subject) : null;
    if (prior) {
      openCompose({
        mode: "reply",
        accountId: prior.account_id,
        to: [to],
        subject: "Re: " + stripReplyPrefix(prior.subject),
        body,
        inReplyTo: prior.message_id,
        threadId: prior.thread_id,
      });
    } else {
      openCompose({ mode: "new", to: to ? [to] : [], subject: isReplySubject(subject) ? stripReplyPrefix(subject) : subject, body });
    }
  }
}
