// The in-call bar (bottom of the screen): who's being called, state + timer, live captions,
// mute / open the dial / hang up, and — once the call is over — its summary. It never blocks the
// page, so the dial can be opened (and its category changed) while the call is running.
import { escapeHtml } from "./clientForm.js";

let el = null;

const OUTCOMES = [["no_response", "No answer"], ["unable_to_contact", "Wrong number"], ["not_interested", "Not interested"], ["busy_callback", "Call back"], ["callback_interested", "Interested"]];

export function openCallPanel({ name, company, onHangup, onMute, onDtmf, onOutcome, onNext }) {
  el?.remove();
  el = document.createElement("div");
  el.className = "call-panel";
  el.innerHTML = `
    <div class="call-keypad hidden">
      <div class="call-keypad-digits"></div>
      <div class="call-keypad-grid">${[["1",""],["2","ABC"],["3","DEF"],["4","GHI"],["5","JKL"],["6","MNO"],["7","PQRS"],["8","TUV"],["9","WXYZ"],["*",""],["0",""],["#",""]].map(([k, l]) => `<button type="button" class="call-key" data-key="${k}"><span class="call-key-num">${k}</span><span class="call-key-letters">${l || "&nbsp;"}</span></button>`).join("")}</div>
    </div>
    <div class="call-panel-top">
      <div class="call-panel-who"><strong>${escapeHtml(name || "Call")}</strong>${company ? `<span>${escapeHtml(company)}</span>` : ""}</div>
      <div class="call-panel-meta"><span class="call-panel-state">Preparing…</span><span class="call-panel-timer"></span></div>
    </div>
    <div class="call-panel-captions"></div>
    <div class="call-panel-summary hidden"></div>
    <div class="call-panel-warn hidden"></div>
    <div class="call-panel-outcome hidden"></div>
    <div class="call-panel-actions">
      <button type="button" class="btn secondary" data-act="mute">Mute</button>
      <button type="button" class="btn secondary" data-act="keypad">Keypad</button>
      <button type="button" class="btn call-hangup" data-act="hangup">Hang up</button>
    </div>`;
  document.body.appendChild(el);
  const $ = (s) => el.querySelector(s);
  const caps = $(".call-panel-captions");
  let timer = null, startedAt = 0, muted = false, lines = [];

  // Fire on the finger lifting (pointerup) as well as on click: the page-wide double-tap-zoom
  // blocker (noZoom.js) cancels the click of any tap that comes within 300 ms of another, which on a
  // phone could swallow a button. The click that follows a touch is skipped so nothing fires twice.
  const onTap = (btn, fn) => {
    let lastTouch = 0;
    btn.addEventListener("pointerup", (e) => { if (e.pointerType === "touch") { lastTouch = Date.now(); fn(); } });
    btn.addEventListener("click", () => { if (Date.now() - lastTouch > 700) fn(); });
  };
  onTap(el.querySelector('[data-act="hangup"]'), () => onHangup?.());

  // Keypad (for phone menus / extensions): sits attached to the top of the bar; each key sends a tone.
  const pad = $(".call-keypad"), typed = $(".call-keypad-digits"), padBtn = el.querySelector('[data-act="keypad"]');
  let digits = "";
  onTap(padBtn, () => {
    const show = pad.classList.contains("hidden");
    pad.classList.toggle("hidden", !show);
    padBtn.classList.toggle("active", show);
  });
  pad.querySelectorAll(".call-key").forEach((k) => onTap(k, () => {
    digits = (digits + k.dataset.key).slice(-24);
    typed.textContent = digits;
    onDtmf?.(k.dataset.key);
  }));
  const muteBtn = el.querySelector('[data-act="mute"]');
  const showMuted = () => {
    muteBtn.textContent = muted ? "Unmute" : "Mute";
    muteBtn.classList.toggle("is-muted", muted);
    el.classList.toggle("is-muted", muted);
  };
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    showMuted();
    onMute?.(muted);
  });

  const drawCaptions = (interim) => {
    const shown = lines.slice(-3).map((l) => `<div><b>${l.speaker === "intern" ? "You" : "Them"}:</b> ${escapeHtml(l.text)}</div>`);
    if (interim) shown.push(`<div class="interim"><b>${interim.speaker === "intern" ? "You" : "Them"}:</b> ${escapeHtml(interim.text)}</div>`);
    caps.innerHTML = shown.join("");
  };

  return {
    // A red line above the buttons (e.g. the phone interrupted the microphone); '' clears it.
    warn(text) { const w = $(".call-panel-warn"); w.textContent = text || ""; w.classList.toggle("hidden", !text); },
    state(text) { $(".call-panel-state").textContent = text; },
    startTimer() {
      startedAt = Date.now();
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt) / 1000);
        $(".call-panel-timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      }, 1000);
    },
    addLine(l) { lines.push(l); drawCaptions(); },
    interim(i) { drawCaptions(i); },
    note(text) { caps.innerHTML = `<div class="interim">${escapeHtml(text)}</div>`; },
    ended(text) {
      clearInterval(timer);
      $(".call-panel-state").textContent = text || "Call ended";
      el.querySelector('[data-act="mute"]').remove();
      const h = el.querySelector('[data-act="hangup"]');
      h.textContent = "Close"; h.classList.remove("call-hangup");
      h.onclick = () => this.close();
      // One tap logs the outcome (written to the dial AND linked to this call by the database), another moves to the next company.
      const box = $(".call-panel-outcome");
      if (onOutcome || onNext) {
        box.classList.remove("hidden");
        box.innerHTML = (onOutcome ? `<div class="call-outcome-label">How did it go?</div><div class="call-outcome-chips">${OUTCOMES.map(([v, l]) => `<button type="button" class="btn secondary call-outcome-chip" data-v="${v}">${l}</button>`).join("")}</div><div class="call-outcome-msg help-text"></div>` : "") +
          (onNext ? `<button type="button" class="btn call-next" data-act="next">Next company</button>` : "");
        box.querySelectorAll(".call-outcome-chip").forEach((b) => onTap(b, async () => {
          const ok = await onOutcome(b.dataset.v);
          box.querySelectorAll(".call-outcome-chip").forEach((x) => x.classList.toggle("active", ok && x === b));
          box.querySelector(".call-outcome-msg").textContent = ok ? "Saved to this call." : "Open the company card to set the outcome.";
        }));
        const nx = box.querySelector('[data-act="next"]');
        if (nx) onTap(nx, () => { this.close(); onNext(); });
      }
    },
    summary(text) {
      const s = $(".call-panel-summary");
      s.textContent = text; s.classList.remove("hidden");
    },
    close() { clearInterval(timer); el?.remove(); el = null; },
  };
}
