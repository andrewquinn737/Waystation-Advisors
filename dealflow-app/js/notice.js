// A small blocking "notice" popup for errors that need the user's attention
// (e.g. trying to send email before connecting one). Injected on first use so
// every page can call it without carrying its own markup.

import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

let modalEl, titleEl, messageEl, actionBtn;

function ensureModal() {
  if (modalEl) return;
  modalEl = document.createElement("div");
  modalEl.className = "modal-backdrop hidden";
  modalEl.id = "noticeModal";
  modalEl.style.zIndex = "300";
  modalEl.innerHTML = `
    <div class="modal">
      <h2 id="noticeTitle">Heads up</h2>
      <p class="help-text" id="noticeMessage" style="font-size:14px;"></p>
      <div class="form-actions">
        <button type="button" class="btn hidden" id="noticeActionBtn"></button>
        <button type="button" class="btn secondary" id="noticeCloseBtn">OK</button>
      </div>
    </div>`;
  document.body.appendChild(modalEl);
  titleEl = modalEl.querySelector("#noticeTitle");
  messageEl = modalEl.querySelector("#noticeMessage");
  actionBtn = modalEl.querySelector("#noticeActionBtn");
  modalEl.querySelector("#noticeCloseBtn").addEventListener("click", closeNotice);
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) closeNotice();
  });
}

function closeNotice() {
  modalEl.classList.add("hidden");
  unlockPageScroll();
}

// opts: { title?, actionLabel?, onAction? }
export function showNotice(message, opts = {}) {
  ensureModal();
  titleEl.textContent = opts.title || "Heads up";
  messageEl.textContent = message;
  actionBtn.classList.toggle("hidden", !opts.actionLabel);
  if (opts.actionLabel) {
    actionBtn.textContent = opts.actionLabel;
    actionBtn.onclick = () => {
      closeNotice();
      if (opts.onAction) opts.onAction();
    };
  }
  modalEl.classList.remove("hidden");
  lockPageScroll();
}

export const CONNECT_EMAIL_MESSAGE =
  "You need to connect an email to the app before you can send email. Go to Profile → Edit, then add your email account under your emails.";

export function showConnectEmailNotice() {
  showNotice(CONNECT_EMAIL_MESSAGE, {
    title: "Connect an email first",
    actionLabel: "Go to Profile",
    onAction: () => {
      window.location.href = "profile.html";
    },
  });
}
