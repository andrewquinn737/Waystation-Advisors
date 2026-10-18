// The in-call bar (bottom of the screen): who's being called, state + timer, live captions,
// mute / open the dial / hang up, and — once the call is over — its summary. It never blocks the
// page, so the dial can be opened (and its category changed) while the call is running.
import { escapeHtml } from "./clientForm.js";

let el = null;

export function openCallPanel({ name, company, onHangup, onMute, onOpenDial }) {
  el?.remove();
  el = document.createElement("div");
  el.className = "call-panel";
  el.innerHTML = `
    <div class="call-panel-top">
      <div class="call-panel-who"><strong>${escapeHtml(name || "Call")}</strong>${company ? `<span>${escapeHtml(company)}</span>` : ""}</div>
      <div class="call-panel-meta"><span class="call-panel-state">Preparing…</span><span class="call-panel-timer"></span></div>
    </div>
    <div class="call-panel-captions"></div>
    <div class="call-panel-summary hidden"></div>
    <div class="call-panel-actions">
      <button type="button" class="btn secondary" data-act="mute">Mute</button>
      <button type="button" class="btn secondary" data-act="dial">Open dial</button>
      <button type="button" class="btn call-hangup" data-act="hangup">Hang up</button>
    </div>`;
  document.body.appendChild(el);
  const $ = (s) => el.querySelector(s);
  const caps = $(".call-panel-captions");
  let timer = null, startedAt = 0, muted = false, lines = [];

  el.querySelector('[data-act="hangup"]').addEventListener("click", () => onHangup?.());
  el.querySelector('[data-act="dial"]').addEventListener("click", () => onOpenDial?.());
  el.querySelector('[data-act="mute"]').addEventListener("click", (e) => {
    muted = !muted;
    e.currentTarget.textContent = muted ? "Unmute" : "Mute";
    onMute?.(muted);
  });

  const drawCaptions = (interim) => {
    const shown = lines.slice(-3).map((l) => `<div><b>${l.speaker === "intern" ? "You" : "Owner"}:</b> ${escapeHtml(l.text)}</div>`);
    if (interim) shown.push(`<div class="interim"><b>${interim.speaker === "intern" ? "You" : "Owner"}:</b> ${escapeHtml(interim.text)}</div>`);
    caps.innerHTML = shown.join("");
  };

  return {
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
    },
    summary(text) {
      const s = $(".call-panel-summary");
      s.textContent = text; s.classList.remove("hidden");
    },
    close() { clearInterval(timer); el?.remove(); el = null; },
  };
}
