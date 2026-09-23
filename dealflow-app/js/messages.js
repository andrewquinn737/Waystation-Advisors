// Messages page — a small in-app email client (see supabase migrations for
// email_accounts/email_messages/email_attachments and the email-sync/
// email-send Edge Functions this reads/writes).
//
// Visible to everyone (interns included), but scoped very differently by
// role — same "team leads/admins see broadly, interns see only their own"
// shape as the rest of the app (Accounts visible on Profile/Clients/Dials):
//   - Team lead: the mailbox picker (triangle) lists their own connected
//     accounts (up to 3) + "All mailboxes". Can read, reply, and compose.
//   - Admin: same, but the picker lists EVERY connected mailbox across every
//     team lead (RLS already scopes email_accounts/email_messages this way
//     — this file just renders whatever comes back).
//   - Intern: no mailbox picker, no compose/reply — a read-only feed of
//     whatever messages are matched (by address) to clients THEY own (or,
//     for a team lead viewing an intern's own scope — not applicable here,
//     interns only ever see their own). Enforced server-side by
//     email_messages' own RLS; this file just doesn't render controls an
//     intern's requests would be rejected for anyway.

import { supabase } from "./supabaseClient.js";
import { requireSession, showError } from "./auth.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus as closePageHeaderMenu } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { wireNotificationsToggle } from "./notifications.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;

const isAdmin = profile?.role === "admin";
const isTeamLead = profile?.role === "team_lead";
const canManageMail = isAdmin || isTeamLead;

const els = {
  pageMenuToggle: document.getElementById("pageMenuToggle"),
  pageHeaderMenu: document.getElementById("pageHeaderMenu"),
  mailboxMenuList: document.getElementById("mailboxMenuList"),
  messagesTitle: document.getElementById("messagesTitle"),
  pageSettingsBtn: document.getElementById("pageSettingsBtn"),
  settingsMenu: document.getElementById("settingsMenu"),
  menuSyncNowBtn: document.getElementById("menuSyncNowBtn"),
  menuManageMailboxesBtn: document.getElementById("menuManageMailboxesBtn"),
  menuNotificationsBtn: document.getElementById("menuNotificationsBtn"),
  notificationsLabel: document.getElementById("notificationsLabel"),
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
let selectedAccountId = null; // null = "All mailboxes"
let detailThreadId = null; // null = list view
let pendingCompose = null; // { attachments: [{filename, contentType, base64}] }

// ---------------------------------------------------------------------------
// Mailbox picker (triangle) + settings gear
// ---------------------------------------------------------------------------

async function loadAccounts() {
  if (!canManageMail) return;
  const { data, error } = await supabase.from("email_accounts").select("*").order("owner_id").order("label");
  if (error) return showError(els.errorBox, error);
  accounts = data || [];
}

function renderMailboxMenu() {
  const rows = [
    `<button type="button" class="page-header-menu-item mailbox-option ${selectedAccountId === null ? "active" : ""}" data-account-id="">
      <span class="menu-item-label">All mailboxes</span>
    </button>`,
    ...accounts.map((a) => {
      const ownerLabel = isAdmin && a.owner_id !== profile.id ? ` — ${escapeHtml(ownerNameFor(a.owner_id))}` : "";
      return `<button type="button" class="page-header-menu-item mailbox-option ${selectedAccountId === a.id ? "active" : ""}" data-account-id="${a.id}">
        <span class="menu-item-label">${escapeHtml(a.label)}${ownerLabel}</span>
      </button>`;
    }),
  ];
  els.mailboxMenuList.innerHTML = rows.join("");
  els.mailboxMenuList.querySelectorAll(".mailbox-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedAccountId = btn.dataset.accountId || null;
      closePageHeaderMenu();
      updateTitle();
      exitDetail();
      loadThreadList();
    });
  });
}

let accountOwnerNames = {}; // owner_id -> full_name, admin-only (see loadOwnerNames)
function ownerNameFor(ownerId) {
  return accountOwnerNames[ownerId] || "Unknown";
}
async function loadOwnerNames() {
  if (!isAdmin) return;
  const ids = [...new Set(accounts.map((a) => a.owner_id))];
  if (!ids.length) return;
  const { data } = await supabase.from("profiles").select("id, full_name").in("id", ids);
  accountOwnerNames = Object.fromEntries((data || []).map((p) => [p.id, p.full_name]));
}

function updateTitle() {
  if (selectedAccountId === null) {
    els.messagesTitle.textContent = "Messages";
  } else {
    const acct = accounts.find((a) => a.id === selectedAccountId);
    els.messagesTitle.textContent = acct ? acct.label : "Messages";
  }
}

if (canManageMail) {
  els.pageMenuToggle.classList.remove("hidden");
  els.menuManageMailboxesBtn.classList.remove("hidden");
  els.composeFabBtn.classList.remove("hidden");
}

wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu });
wirePageHeaderMenu({ toggleBtn: els.pageSettingsBtn, menuEl: els.settingsMenu });
wireNotificationsToggle(els.menuNotificationsBtn, els.notificationsLabel, profile);

els.menuSyncNowBtn.addEventListener("click", async () => {
  closePageHeaderMenu();
  els.menuSyncNowBtn.querySelector(".menu-item-label").textContent = "Syncing…";
  const {
    data: { session: authSession },
  } = await supabase.auth.getSession();
  const { error } = await supabase.functions.invoke("email-sync", {
    body: {},
    headers: { Authorization: `Bearer ${authSession?.access_token || ""}` },
  });
  els.menuSyncNowBtn.querySelector(".menu-item-label").textContent = "Sync now";
  if (error) return showError(els.errorBox, error);
  if (detailThreadId) openThread(detailThreadId);
  else loadThreadList();
});
els.menuManageMailboxesBtn.addEventListener("click", () => {
  window.location.href = "profile.html#manage-mailboxes";
});

// ---------------------------------------------------------------------------
// Thread list
// ---------------------------------------------------------------------------

const PAGE_SIZE = 300; // messages fetched to derive the thread list from

function accountIdsForQuery() {
  if (selectedAccountId) return [selectedAccountId];
  if (canManageMail) return accounts.map((a) => a.id);
  return null; // intern: no account filter — RLS alone scopes this to their own clients' messages
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
      els.wrap.innerHTML = `<div class="empty-state">No mailboxes connected yet.${canManageMail ? " Add one from Manage mailboxes." : ""}</div>`;
      return;
    }
    query = query.in("account_id", ids);
  }
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

  const rows = [...threads.values()];
  if (!rows.length) {
    els.wrap.innerHTML = `<div class="empty-state">No messages yet.</div>`;
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
      <div class="mc-sub faint" style="flex-shrink:0;">${escapeHtml(formatDate(t.latest.sent_at))}</div>
    </div>`
    )
    .join("")}</div>`;

  els.wrap.querySelectorAll(".message-thread-row").forEach((row) => {
    row.addEventListener("click", () => openThread(row.dataset.threadId));
  });
}

// ---------------------------------------------------------------------------
// Thread detail
// ---------------------------------------------------------------------------

function exitDetail() {
  detailThreadId = null;
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
      <button type="button" class="select-mode-btn" id="threadBackBtn" style="margin-bottom:12px;">Back</button>
      <h2 class="thread-detail-subject">${escapeHtml(msgs.find((m) => m.subject)?.subject || "(no subject)")}</h2>
      ${msgs.map((m) => threadMessageHTML(m, attachmentsByMessage[m.id] || [])).join("")}
      ${
        canReply
          ? `<div class="thread-reply-box">
              <button type="button" class="btn secondary" id="threadReplyBtn">Reply</button>
            </div>`
          : ""
      }
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

  // Wire attachment download links (signed URLs, generated on demand rather
  // than stored — the bucket is private, see supabase migrations).
  els.wrap.querySelectorAll("[data-attachment-path]").forEach((link) => {
    link.addEventListener("click", async (e) => {
      e.preventDefault();
      const { data, error: signErr } = await supabase.storage.from("email-attachments").createSignedUrl(link.dataset.attachmentPath, 60);
      if (signErr || !data?.signedUrl) return showError(els.errorBox, signErr || new Error("Could not open that attachment."));
      window.open(data.signedUrl, "_blank", "noopener");
    });
  });

  // Mark inbound unread messages in this thread as read.
  const unreadIds = msgs.filter((m) => m.direction === "inbound" && !m.is_read).map((m) => m.id);
  if (unreadIds.length) {
    await supabase.from("email_messages").update({ is_read: true }).in("id", unreadIds);
  }
}

function threadMessageHTML(m, atts) {
  const date = new Date(m.sent_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const fromLabel = m.direction === "outbound" ? `${m.from_name || m.from_address} (you)` : m.from_name || m.from_address;
  const toLabel = (m.to_addresses || []).map((a) => a.name || a.address).join(", ");
  // allow-same-origin without allow-scripts: still fully blocks any script
  // in the email HTML from running (that's what actually matters for
  // safety), but lets this page measure the iframe's own contentDocument to
  // resize it to its real content height (see the load listener in
  // openThread below) — a fully opaque sandbox=\"\" origin blocks that
  // measurement too, not just script execution, which is why that stricter
  // setting left every HTML message stuck at min-height regardless of how
  // short or long it actually was.
  const bodyHTML = m.body_html
    ? `<iframe class="thread-message-html" sandbox="allow-same-origin" srcdoc="${escapeHtml(m.body_html)}"></iframe>`
    : `<div class="thread-message-text">${escapeHtml(m.body_text || "").replace(/\n/g, "<br>")}</div>`;
  const attsHTML = atts.length
    ? `<div class="thread-message-attachments">${atts
        .map(
          (a) =>
            `<a href="#" data-attachment-path="${escapeHtml(a.storage_path)}" class="thread-attachment-chip">${escapeHtml(a.filename)}</a>`
        )
        .join("")}</div>`
    : "";
  return `
    <div class="thread-message ${m.direction}">
      <div class="thread-message-header">
        <span class="thread-message-from">${escapeHtml(fromLabel)}</span>
        <span class="thread-message-date">${escapeHtml(date)}</span>
      </div>
      <div class="thread-message-to">To: ${escapeHtml(toLabel)}</div>
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

function openCompose({ mode, accountId, to, subject, inReplyTo, threadId }) {
  pendingCompose = { mode, inReplyTo, threadId, attachments: [] };
  els.composeError.classList.add("hidden");
  els.composeTitle.textContent = mode === "reply" ? "Reply" : "New message";
  els.composeToInput.value = (to || []).join(", ");
  els.composeCcInput.value = "";
  els.composeSubjectInput.value = subject || "";
  els.composeBody.innerHTML = "";
  renderComposeAttachments();

  const usable = accounts.filter((a) => isAdmin || a.owner_id === profile.id);
  els.composeFromSelect.innerHTML = usable.map((a) => `<option value="${a.id}">${escapeHtml(a.label)} (${escapeHtml(a.email_address)})</option>`).join("");
  if (accountId) els.composeFromSelect.value = accountId;
  else if (selectedAccountId) els.composeFromSelect.value = selectedAccountId;
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
  if (openThreadId) openThread(openThreadId);
  else loadThreadList();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

await loadAccounts();
await loadOwnerNames();
renderMailboxMenu();
updateTitle();
await loadThreadList();
