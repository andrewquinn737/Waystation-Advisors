// Profile -> Edit for team leads and admins: instead of email text boxes, each
// of the (up to 3) emails is a button-shaped box. Tap one to edit its mail
// account details, connect it (red outline = listed but not connected), or
// remove it; the last box adds a new one. Drag the || grip to reorder — the top
// email is bold and is the default sender (profiles.email, shown on Profile and
// Teams). Accounts are verified against the real mail server before saving
// (email-account-manage Edge Function); passwords never come back to the page.

import { supabase } from "./supabaseClient.js";
import { setOwnEmail, setOwnHasMailbox } from "./contactIcons.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

const MAX_EMAILS = 3;
const ACCOUNT_COLUMNS = "id, owner_id, label, email_address, username, imap_host, imap_port, smtp_host, smtp_port";

function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const same = (a, b) => (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();

let state = null; // { profile, host, accounts, onChanged }
let popupEl = null;
let confirmEl = null;
let popupCtx = null; // { account|null, slotEmail|null }

function slots() {
  const p = state.profile;
  return [p.email, p.email_2, p.email_3].map((s) => (s || "").trim()).filter(Boolean);
}
function accountFor(address) {
  return state.accounts.find((a) => same(a.email_address, address)) || null;
}

async function loadAccounts() {
  const { data } = await supabase.from("email_accounts").select(ACCOUNT_COLUMNS).eq("owner_id", state.profile.id).order("created_at");
  state.accounts = data || [];
  setOwnHasMailbox(state.accounts.length > 0);
}

function applySlots(list) {
  state.profile.email = list[0] || null;
  state.profile.email_2 = list[1] || null;
  state.profile.email_3 = list[2] || null;
  setOwnEmail(state.profile.email);
}

async function callManage(body) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const { data, error } = await supabase.functions.invoke("email-account-manage", {
    body,
    headers: { Authorization: `Bearer ${session?.access_token || ""}` },
  });
  if (error) {
    // supabase-js hides the JSON error body of a non-2xx reply inside error.context.
    let msg = error.message;
    try {
      const j = await error.context.json();
      if (j && j.error) msg = j.error;
    } catch { /* keep generic message */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

// ---------------------------------------------------------------------------
// The list of email boxes
// ---------------------------------------------------------------------------

function render() {
  const list = slots();
  const boxes = list
    .map((addr, i) => {
      const connected = !!accountFor(addr);
      return `
      <div class="profile-mail-box ${connected ? "" : "unconnected"} ${i === 0 ? "first" : ""}" data-address="${escapeHtml(addr)}" role="button" tabindex="0"
           title="${connected ? "Edit this email" : "Not connected — tap to connect"}">
        <span class="profile-mail-grip" title="Drag to reorder">||</span>
        <span class="profile-mail-addr">${escapeHtml(addr)}</span>
      </div>`;
    })
    .join("");
  const add =
    list.length < MAX_EMAILS
      ? `<div class="profile-mail-box profile-mail-add" data-add="1" role="button" tabindex="0"><span class="profile-mail-addr">+ Add email</span></div>`
      : "";
  state.host.innerHTML = `${boxes}${add}<div class="help-text profile-mail-help">The top email is your default sender. A red outline means it isn't connected to the app yet — tap it to connect. Drag || to reorder.</div>`;

  state.host.querySelectorAll(".profile-mail-box[data-address]").forEach((box) => {
    box.addEventListener("click", () => {
      const addr = box.dataset.address;
      const account = accountFor(addr);
      openPopup({ account, slotEmail: account ? null : addr });
    });
    wireDrag(box);
  });
  const addBtn = state.host.querySelector("[data-add]");
  if (addBtn) addBtn.addEventListener("click", () => openPopup({ account: null, slotEmail: null }));
}

function wireDrag(box) {
  const grip = box.querySelector(".profile-mail-grip");
  let dragging = false;
  grip.addEventListener("click", (e) => e.stopPropagation());
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    box.classList.add("dragging");
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const others = [...state.host.querySelectorAll(".profile-mail-box[data-address]")].filter((b) => b !== box);
    const after = others.find((b) => {
      const r = b.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (after) after.before(box);
    else if (others.length) others[others.length - 1].after(box);
  });
  const finish = async () => {
    if (!dragging) return;
    dragging = false;
    box.classList.remove("dragging");
    const order = [...state.host.querySelectorAll(".profile-mail-box[data-address]")].map((b) => b.dataset.address);
    if (order.join("|") !== slots().join("|")) {
      const before = slots();
      applySlots(order);
      const { error } = await supabase.from("profiles").update({ email: order[0] || null, email_2: order[1] || null, email_3: order[2] || null }).eq("id", state.profile.id);
      if (error) applySlots(before);
      else if (state.onChanged) state.onChanged();
    }
    render();
  };
  grip.addEventListener("pointerup", finish);
  grip.addEventListener("pointercancel", finish);
}

// ---------------------------------------------------------------------------
// Add / edit / connect popup + remove confirmation
// ---------------------------------------------------------------------------

function ensurePopups() {
  if (popupEl) return;
  popupEl = document.createElement("div");
  popupEl.className = "modal-backdrop hidden";
  popupEl.id = "mailAccountPopup";
  popupEl.style.zIndex = "200";
  popupEl.innerHTML = `
    <div class="modal">
      <h2 id="mailPopupTitle">Edit email</h2>
      <p class="help-text" id="mailPopupIntro"></p>
      <div id="mailPopupError" class="error-msg hidden"></div>
      <label for="mailFieldAddress">Email address</label>
      <input id="mailFieldAddress" type="email" autocomplete="off" />
      <label for="mailFieldUsername">Username</label>
      <input id="mailFieldUsername" autocomplete="off" />
      <label for="mailFieldPassword">Password</label>
      <input id="mailFieldPassword" type="password" autocomplete="new-password" />
      <label for="mailFieldImapHost">Incoming server (IMAP)</label>
      <input id="mailFieldImapHost" autocomplete="off" placeholder="mail.example.com" />
      <label for="mailFieldImapPort">IMAP port</label>
      <input id="mailFieldImapPort" inputmode="numeric" />
      <label for="mailFieldSmtpHost">Outgoing server (SMTP)</label>
      <input id="mailFieldSmtpHost" autocomplete="off" placeholder="mail.example.com" />
      <label for="mailFieldSmtpPort">SMTP port</label>
      <input id="mailFieldSmtpPort" inputmode="numeric" />
      <div class="form-actions">
        <button type="button" class="btn" id="mailPopupSave">Save</button>
        <button type="button" class="btn danger hidden" id="mailPopupRemove">Remove email</button>
        <button type="button" class="btn secondary" id="mailPopupCancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(popupEl);

  confirmEl = document.createElement("div");
  confirmEl.className = "modal-backdrop hidden";
  confirmEl.id = "mailRemoveConfirm";
  confirmEl.style.zIndex = "210";
  confirmEl.innerHTML = `
    <div class="modal">
      <h2>Remove this email?</h2>
      <p class="help-text" id="mailRemoveText"></p>
      <div id="mailRemoveError" class="error-msg hidden"></div>
      <div class="form-actions">
        <button type="button" class="btn danger" id="mailRemoveYes">Remove</button>
        <button type="button" class="btn secondary" id="mailRemoveNo">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(confirmEl);

  const $ = (id) => popupEl.querySelector("#" + id);
  $("mailPopupCancel").addEventListener("click", closePopup);
  popupEl.addEventListener("click", (e) => {
    if (e.target === popupEl) closePopup();
  });
  $("mailPopupSave").addEventListener("click", savePopup);
  $("mailPopupRemove").addEventListener("click", () => {
    const addr = popupCtx.account ? popupCtx.account.email_address : popupCtx.slotEmail;
    confirmEl.querySelector("#mailRemoveText").textContent = popupCtx.account
      ? `${addr} will be disconnected and removed from your emails. You won't be able to send from it or see it in Messages, and the message previews the app stored for it will be deleted. The emails themselves stay in the mailbox.`
      : `${addr} will be removed from your emails.`;
    confirmEl.querySelector("#mailRemoveError").classList.add("hidden");
    confirmEl.classList.remove("hidden");
  });
  confirmEl.querySelector("#mailRemoveNo").addEventListener("click", () => confirmEl.classList.add("hidden"));
  confirmEl.querySelector("#mailRemoveYes").addEventListener("click", confirmRemove);
}

function closePopup() {
  popupEl.classList.add("hidden");
  confirmEl.classList.add("hidden");
  unlockPageScroll();
  popupCtx = null;
}

function setPopupError(msg) {
  const el = popupEl.querySelector("#mailPopupError");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function openPopup({ account, slotEmail }) {
  ensurePopups();
  popupCtx = { account, slotEmail };
  const $ = (id) => popupEl.querySelector("#" + id);
  const adding = !account && !slotEmail;
  // New/unconnected emails start from the same server settings as the user's
  // first connected mailbox (they're usually all on one provider).
  const template = account || state.accounts[0] || {};
  $("mailPopupTitle").textContent = adding ? "Add email" : account ? "Edit email" : "Connect email";
  $("mailPopupIntro").textContent = adding
    ? "Enter the mailbox's login details. They're checked against the mail server before anything is saved."
    : account
      ? "Leave the password blank to keep the current one."
      : "This email is listed but not connected to the app yet. Enter its login details to connect it.";
  $("mailFieldAddress").value = account ? account.email_address : slotEmail || "";
  $("mailFieldUsername").value = account ? account.username : slotEmail || "";
  $("mailFieldPassword").value = "";
  $("mailFieldPassword").placeholder = account ? "Unchanged" : "";
  $("mailFieldImapHost").value = template.imap_host || "";
  $("mailFieldImapPort").value = template.imap_port || 993;
  $("mailFieldSmtpHost").value = template.smtp_host || "";
  $("mailFieldSmtpPort").value = template.smtp_port || 465;
  $("mailPopupSave").textContent = adding ? "Add" : account ? "Save" : "Connect";
  $("mailPopupRemove").classList.toggle("hidden", adding);
  setPopupError("");
  popupEl.classList.remove("hidden");
  lockPageScroll();
  $("mailFieldAddress").focus();
}

async function savePopup() {
  const $ = (id) => popupEl.querySelector("#" + id);
  const btn = $("mailPopupSave");
  const label = btn.textContent;
  setPopupError("");
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const res = await callManage({
      action: "save",
      account_id: popupCtx.account ? popupCtx.account.id : undefined,
      slot_email: popupCtx.slotEmail || undefined,
      email_address: $("mailFieldAddress").value,
      username: $("mailFieldUsername").value,
      password: $("mailFieldPassword").value,
      imap_host: $("mailFieldImapHost").value,
      imap_port: $("mailFieldImapPort").value,
      smtp_host: $("mailFieldSmtpHost").value,
      smtp_port: $("mailFieldSmtpPort").value,
    });
    applySlots(res.slots);
    await loadAccounts();
    closePopup();
    render();
    if (state.onChanged) state.onChanged();
  } catch (e) {
    setPopupError(e.message || "Couldn't save that email.");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function confirmRemove() {
  const yes = confirmEl.querySelector("#mailRemoveYes");
  yes.disabled = true;
  try {
    const res = await callManage({
      action: "remove",
      account_id: popupCtx.account ? popupCtx.account.id : undefined,
      slot_email: popupCtx.slotEmail || undefined,
    });
    applySlots(res.slots);
    await loadAccounts();
    closePopup();
    render();
    if (state.onChanged) state.onChanged();
  } catch (e) {
    const el = confirmEl.querySelector("#mailRemoveError");
    el.textContent = e.message || "Couldn't remove that email.";
    el.classList.remove("hidden");
  } finally {
    yes.disabled = false;
  }
}

// ---------------------------------------------------------------------------

// host: an (empty) element the boxes render into while editing.
export async function mountEmailList({ profile, host, onChanged }) {
  state = { profile, host, accounts: [], onChanged };
  render(); // boxes right away (all shown as connected until the account list arrives)
  await loadAccounts();
  render();
}

export function unmountEmailList() {
  if (popupEl && !popupEl.classList.contains("hidden")) closePopup();
  state = null;
}
