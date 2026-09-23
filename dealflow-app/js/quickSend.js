// Small, non-navigating "quick send" modal used only by an intern's email
// quick-action icon (see contactIcons.js/wireQuickSendButtons) — sends from
// their team lead's primary connected mailbox via the email-send Edge
// Function, without leaving the Clients/Dials page they're on. Team leads/
// admins never see this: their email icon navigates straight to Messages'
// own compose instead (see contactIcons.js's buildEmailHref).
//
// Injected into document.body on first use rather than declared in every
// page's own HTML — this is the one contact-action popup needed on both
// Clients and Dials, and a JS-built modal keeps it in exactly one place
// instead of two copies that could drift.

import { supabase } from "./supabaseClient.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { showError } from "./auth.js";

let modalEl, toEl, subjectEl, bodyEl, errorEl, sendBtn, cancelBtn, closeBtn;
let pendingAccountId = null;

function ensureModal() {
  if (modalEl) return;
  modalEl = document.createElement("div");
  modalEl.className = "modal-backdrop hidden";
  modalEl.id = "quickSendModal";
  modalEl.innerHTML = `
    <div class="modal">
      <h2>New email</h2>
      <div id="quickSendError" class="error-msg hidden"></div>
      <label for="quickSendTo">To</label>
      <input id="quickSendTo" placeholder="name@example.com" />
      <label for="quickSendSubject">Subject</label>
      <input id="quickSendSubject" />
      <label for="quickSendBody">Message</label>
      <textarea id="quickSendBody" rows="8" style="width:100%; resize:vertical; font-family:inherit; font-size:14px; padding:8px; border:1px solid var(--border); border-radius:6px; box-sizing:border-box;"></textarea>
      <div class="form-actions">
        <button type="button" class="btn" id="quickSendSendBtn">Send</button>
        <button type="button" class="btn secondary" id="quickSendCancelBtn">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modalEl);
  toEl = modalEl.querySelector("#quickSendTo");
  subjectEl = modalEl.querySelector("#quickSendSubject");
  bodyEl = modalEl.querySelector("#quickSendBody");
  errorEl = modalEl.querySelector("#quickSendError");
  sendBtn = modalEl.querySelector("#quickSendSendBtn");
  cancelBtn = modalEl.querySelector("#quickSendCancelBtn");
  cancelBtn.addEventListener("click", closeQuickSend);
  sendBtn.addEventListener("click", doSend);
}

function closeQuickSend() {
  if (!modalEl) return;
  modalEl.classList.add("hidden");
  unlockPageScroll();
  pendingAccountId = null;
}

// opts: { accountId, to, subject, body }
export function openQuickSend(opts) {
  ensureModal();
  errorEl.classList.add("hidden");
  toEl.value = opts.to || "";
  subjectEl.value = opts.subject || "";
  bodyEl.value = opts.body || "";
  pendingAccountId = opts.accountId;
  modalEl.classList.remove("hidden");
  lockPageScroll();
  toEl.focus();
}

async function doSend() {
  if (!pendingAccountId) return;
  errorEl.classList.add("hidden");
  const to = toEl.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!to.length) return showError(errorEl, new Error("Add at least one recipient."));

  sendBtn.disabled = true;
  sendBtn.textContent = "Sending…";
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const { data, error } = await supabase.functions.invoke("email-send", {
    body: { account_id: pendingAccountId, to, subject: subjectEl.value.trim(), text: bodyEl.value },
    headers: { Authorization: `Bearer ${session?.access_token || ""}` },
  });
  sendBtn.disabled = false;
  sendBtn.textContent = "Send";
  if (error || data?.error) return showError(errorEl, error || new Error(data.error));
  closeQuickSend();
}
