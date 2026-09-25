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
import { findPriorOutbound, isReplySubject, stripReplyPrefix } from "./followUp.js";
import { requireSession, showError } from "./auth.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus as closePageHeaderMenu } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { wireNotificationsToggle } from "./notifications.js";
import { wireAccountsVisiblePopup, getVisibleAccountIds } from "./accountsVisible.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;

const isAdmin = profile?.role === "admin";
const isTeamLead = profile?.role === "team_lead";
const canManageMail = isAdmin || isTeamLead;

// Independent from the shared app-wide "Accounts visible" key used
// elsewhere — this page's mailbox selection has nothing to do with which
// ACCOUNTS' dials/clients are visible on other pages.
const MAILBOX_STORAGE_KEY = "waystation_messages_mailboxes";

const els = {
  pageMenuToggle: document.getElementById("pageMenuToggle"),
  pageHeaderMenu: document.getElementById("pageHeaderMenu"),
  menuMailboxesBtn: document.getElementById("menuMailboxesBtn"),
  messagesTitle: document.getElementById("messagesTitle"),
  pageSettingsBtn: document.getElementById("pageSettingsBtn"),
  settingsMenu: document.getElementById("settingsMenu"),
  menuSyncNowBtn: document.getElementById("menuSyncNowBtn"),
  syncSpinner: document.getElementById("syncSpinner"),
  menuSelectBtn: document.getElementById("menuSelectBtn"),
  menuFolderBtn: document.getElementById("menuFolderBtn"),
  menuFolderLabel: document.getElementById("menuFolderLabel"),
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
let accountOwnerNames = {}; // owner_id -> full_name, admin-only
let detailThreadId = null; // null = list view
let pendingCompose = null; // { attachments: [{filename, contentType, base64}] }
let threadListSelectMode = false;
let folderView = "received"; // "received" | "sent" — team leads/admins only (interns always see the one client-matched feed)
let selectedThreadIds = new Set();
let currentThreadRows = []; // the list currently rendered, for Select all / bulk actions

// ---------------------------------------------------------------------------
// Mailboxes (triangle menu → Mailboxes popup) + settings gear
// ---------------------------------------------------------------------------

async function loadAccounts() {
  if (!canManageMail) return;
  const { data, error } = await supabase.from("email_accounts").select("*").order("owner_id").order("email_address");
  if (error) return showError(els.errorBox, error);
  accounts = data || [];
  if (isAdmin) {
    const ids = [...new Set(accounts.map((a) => a.owner_id))];
    if (ids.length) {
      const { data: owners } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      accountOwnerNames = Object.fromEntries((owners || []).map((p) => [p.id, p.full_name]));
    }
  }
}

// The label shown for one mailbox — its actual email address (per spec:
// "instead of having names have the emails listed"), with the owning
// account's name in parentheses for an admin viewing someone else's box.
function mailboxLabel(a) {
  const ownerSuffix = isAdmin ? ` (${accountOwnerNames[a.owner_id] || "Unknown"})` : "";
  return `${a.email_address}${ownerSuffix}`;
}

function updateTitle() {
  const visible = getVisibleAccountIds(MAILBOX_STORAGE_KEY);
  const suffix = folderView === "sent" ? " · Sent" : "";
  if (!visible || visible.size !== 1) {
    els.messagesTitle.textContent = `Messages${suffix}`;
    return;
  }
  const acct = accounts.find((a) => visible.has(a.id));
  els.messagesTitle.textContent = `${acct ? acct.email_address : "Messages"}${suffix}`;
}

if (canManageMail) {
  els.pageMenuToggle.classList.remove("hidden");
  els.composeFabBtn.classList.remove("hidden");
}

wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu, extraCloseEl: els.mailboxesPopup });
wirePageHeaderMenu({ toggleBtn: els.pageSettingsBtn, menuEl: els.settingsMenu });
wireNotificationsToggle(els.menuNotificationsBtn, els.notificationsLabel, profile);

if (canManageMail) {
  wireAccountsVisiblePopup({
    menuBtn: els.menuMailboxesBtn,
    popupEl: els.mailboxesPopup,
    bodyEl: els.mailboxesPopupBody,
    closeBtn: els.mailboxesPopupClose,
    closePageHeaderMenu,
    myProfileId: profile.id,
    storageKey: MAILBOX_STORAGE_KEY,
    // One synthetic "account" row per connected MAILBOX, not per person —
    // id is the email_accounts row's own id, so the shared popup's
    // selection Set ends up holding mailbox ids, which is exactly what
    // accountIdsForQuery() below needs.
    getAllAccounts: async () => accounts.map((a) => ({ id: a.id, full_name: mailboxLabel(a) })),
    onChange: () => {
      updateTitle();
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
  if (detailThreadId || threadListSelectMode) return;
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

els.menuFolderBtn.addEventListener("click", () => {
  folderView = folderView === "received" ? "sent" : "received";
  els.menuFolderLabel.textContent = folderView === "sent" ? "Viewing: Sent" : "Viewing: Received";
  closePageHeaderMenu();
  if (threadListSelectMode) exitThreadSelectMode();
  updateTitle();
  exitDetail();
  loadThreadList();
});
els.selectBackBtn.addEventListener("click", exitThreadSelectMode);
els.selectAllBtn.addEventListener("click", () => {
  if (selectedThreadIds.size === currentThreadRows.length) selectedThreadIds = new Set();
  else selectedThreadIds = new Set(currentThreadRows.map((t) => t.latest.thread_id));
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

const PAGE_SIZE = 300; // messages fetched to derive the thread list from

function accountIdsForQuery() {
  if (!canManageMail) return null; // intern: RLS alone scopes this to their own clients' messages
  const visible = getVisibleAccountIds(MAILBOX_STORAGE_KEY);
  if (!visible) return accounts.map((a) => a.id); // "select all" (default) — every mailbox this user can see
  return accounts.filter((a) => visible.has(a.id)).map((a) => a.id);
}

async function loadThreadList() {
  els.errorBox.classList.add("hidden");
  els.wrap.innerHTML = `<div class="empty-state">Loading…</div>`;

  let query = supabase
    .from("email_messages")
    .select("id, thread_id, account_id, direction, from_address, from_name, to_addresses, subject, snippet, is_read, client_id, sent_at")
    .order("sent_at", { ascending: false })
    .limit(PAGE_SIZE);
  const ids = accountIdsForQuery();
  if (ids) {
    if (!ids.length) {
      els.wrap.innerHTML = `<div class="empty-state">No mailboxes connected yet.</div>`;
      return;
    }
    query = query.in("account_id", ids);
  }
  if (canManageMail) query = query.eq("direction", folderView === "sent" ? "outbound" : "inbound");
  const { data, error } = await query;
  if (error) {
    els.wrap.innerHTML = "";
    return showError(els.errorBox, error);
  }

  const clientIds = [...new Set((data || []).map((m) => m.client_id).filter(Boolean))];
  let clientNames = {};
  if (clientIds.length) {
    const { data: clients } = await supabase.from("clients").select("id, full_name").in("id", clientIds);
    clientNames = Object.fromEntries((clients || []).map((c) => [c.id, c.full_name]));
  }

  const threads = new Map(); // thread_id -> latest message (first one seen, since sorted desc) + unread flag
  for (const m of data || []) {
    if (!threads.has(m.thread_id)) {
      threads.set(m.thread_id, { latest: m, unread: false, clientName: m.client_id ? clientNames[m.client_id] : null });
    }
    const t = threads.get(m.thread_id);
    if (m.direction === "inbound" && !m.is_read) t.unread = true;
  }

  currentThreadRows = [...threads.values()];
  renderThreadList();
}

function renderThreadList() {
  const rows = currentThreadRows;
  if (!rows.length) {
    els.wrap.innerHTML = `<div class="empty-state">${folderView === "sent" && canManageMail ? "No sent messages yet." : "No messages yet."}</div>`;
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

  els.wrap.innerHTML = `<div class="team-member-list">${rows
    .map(
      (t) => `
    <div class="mobile-card message-thread-row ${t.unread ? "unread" : ""}" data-thread-id="${escapeHtml(t.latest.thread_id)}">
      <div class="mc-main">
        <div class="mc-name">
          ${t.unread ? `<span class="message-unread-dot"></span>` : ""}${escapeHtml(participantLabel(t.latest))}
          ${t.clientName ? `<span class="message-client-badge">${escapeHtml(t.clientName)}</span>` : ""}
        </div>
        <div class="mc-sub">${escapeHtml(t.latest.subject || "(no subject)")}</div>
        <div class="mc-sub faint">${escapeHtml(t.latest.snippet || "")}</div>
      </div>
      ${
        threadListSelectMode
          ? `<div class="select-circle ${selectedThreadIds.has(t.latest.thread_id) ? "selected" : ""}"></div>`
          : `<div class="mc-sub faint" style="flex-shrink:0;">${escapeHtml(formatDate(t.latest.sent_at))}</div>`
      }
    </div>`
    )
    .join("")}</div>`;

  els.wrap.querySelectorAll(".message-thread-row").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.threadId;
      if (threadListSelectMode) {
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

  const last = msgs[msgs.length - 1];
  const canReply = canManageMail && accounts.some((a) => a.id === last.account_id);

  els.wrap.innerHTML = `
    <div class="thread-detail">
      <h2 class="thread-detail-subject">${escapeHtml(msgs.find((m) => m.subject)?.subject || "(no subject)")}</h2>
      ${msgs.map((m) => threadMessageHTML(m, attachmentsByMessage[m.id] || [])).join("")}
      <div class="thread-detail-actions">
        <button type="button" class="btn secondary" id="threadBackBtn">Back</button>
        ${canReply ? `<button type="button" class="btn secondary" id="threadReplyBtn">Reply</button>` : ""}
      </div>
    </div>
  `;

  document.getElementById("threadBackBtn").addEventListener("click", () => {
    exitDetail();
    loadThreadList();
  });
  const replyBtn = document.getElementById("threadReplyBtn");
  if (replyBtn) {
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

  // Participant name → their Client/Dial record (see openParticipantRecord).
  els.wrap.querySelectorAll("[data-participant-address]").forEach((el) => {
    el.addEventListener("click", () => openParticipantRecord(el.dataset.participantAddress));
  });

  // Mark inbound unread messages in this thread as read.
  const unreadIds = msgs.filter((m) => m.direction === "inbound" && !m.is_read).map((m) => m.id);
  if (unreadIds.length) {
    await supabase.from("email_messages").update({ is_read: true }).in("id", unreadIds);
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

function threadMessageHTML(m, atts) {
  const date = new Date(m.sent_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fromLabel = m.direction === "outbound" ? `${m.from_name || m.from_address} (you)` : m.from_name || m.from_address;
  const fromClickable = m.direction === "outbound" ? "" : ` data-participant-address="${escapeHtml(m.from_address)}"`;
  const toEntries = m.to_addresses || [];
  const toLabel = toEntries
    .map((a) => `<span class="thread-participant-name"${m.direction === "outbound" ? ` data-participant-address="${escapeHtml(a.address)}"` : ""}>${escapeHtml(a.name || a.address)}</span>`)
    .join(", ");
  const bodyHTML = m.body_html
    ? // allow-same-origin without allow-scripts: still fully blocks any script
      // in the email HTML from running (that's what actually matters for
      // safety), but lets this page measure the iframe's own contentDocument
      // to resize it to its real content height (see the load listener
      // above) — a fully opaque sandbox="" origin blocks that measurement
      // too, not just script execution.
      `<iframe class="thread-message-html" sandbox="allow-same-origin" srcdoc="${escapeHtml(m.body_html)}"></iframe>`
    : `<div class="thread-message-text">${escapeHtml(m.body_text || "").replace(/\n/g, "<br>")}</div>`;
  const attsHTML = atts.length
    ? `<div class="thread-message-attachments">${atts
        .map(
          (a) =>
            `<a href="#" data-attachment-path="${escapeHtml(a.storage_path)}" data-attachment-name="${escapeHtml(attachmentDisplayName(a))}" class="thread-attachment-chip">${escapeHtml(attachmentDisplayName(a))}</a>`
        )
        .join("")}</div>`
    : "";
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
  pendingCompose = { mode, inReplyTo, threadId, attachments: [] };
  els.composeError.classList.add("hidden");
  els.composeTitle.textContent = mode === "reply" ? "Reply" : "New message";
  els.composeToInput.value = (to || []).join(", ");
  els.composeCcInput.value = "";
  els.composeSubjectInput.value = subject || "";
  els.composeBody.innerHTML = body ? escapeHtml(body).replace(/\n/g, "<br>") : "";
  renderComposeAttachments();

  const usable = accounts.filter((a) => isAdmin || a.owner_id === profile.id);
  els.composeFromSelect.innerHTML = usable.map((a) => `<option value="${a.id}">${escapeHtml(mailboxLabel(a))}</option>`).join("");
  const visible = getVisibleAccountIds(MAILBOX_STORAGE_KEY);
  const defaultAccountId = accountId || (visible && visible.size === 1 ? [...visible][0] : usable[0]?.id);
  if (defaultAccountId) els.composeFromSelect.value = defaultAccountId;
  els.composeFromRow.classList.toggle("hidden", mode === "reply");

  els.composeModal.classList.remove("hidden");
  lockPageScroll();
  els.composeToInput.focus();
}
function closeCompose() {
  els.composeModal.classList.add("hidden");
  unlockPageScroll();
  pendingCompose = null;
}
els.composeCancelBtn.addEventListener("click", closeCompose);
els.composeCloseBtn.addEventListener("click", closeCompose);
els.composeFabBtn.addEventListener("click", () => openCompose({ mode: "new" }));

els.composeSendBtn.addEventListener("click", async () => {
  const accountId = els.composeFromSelect.value;
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
updateTitle();
await loadThreadList();

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
