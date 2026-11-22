// Shared helpers for the email-sequence UI (copyReview.js, copyReviewScreen.js, claudeConnect.js).
import { escapeHtml } from "./clientForm.js";

export const $ = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
// Never show raw SQL / server wording to a person: timeouts and database errors get a plain sentence.
export const msg = (e) => {
  const t = String((e && (e.message || e.details || e.hint)) || e || "");
  if (/statement timeout|canceling statement|timeout|timed out/i.test(t)) return "That took longer than the server allows. Nothing was lost. Press Retry to continue.";
  if (/failed to fetch|networkerror|load failed|network request/i.test(t)) return "No connection to the server. Check your internet and press Retry.";
  if (/violates|syntax error|relation .* does not exist|column .* does not exist|permission denied|\bpgrst\d+|\bselect\b.*\bfrom\b/i.test(t)) return "The server could not finish that. Press Retry; if it keeps failing, tell an admin.";
  return t || "Something went wrong";
};
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
export const denverToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());
const parseYMD = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const isWeekday = (dt) => { const w = dt.getUTCDay(); return w !== 0 && w !== 6; };
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const prettyDay = (s) => { const d = parseYMD(s); return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
export const prettyDate = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${MON[d.getMonth()]} ${d.getDate()}`; };

// Business-day number of today in the sequence (day 1 = seq_day0). Weekends only; holidays ignored (display only).
export function seqDayNumber(day0, today = denverToday()) {
  const a = parseYMD(day0), b = parseYMD(today);
  if (b < a) return 0;
  let n = 0;
  for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) if (isWeekday(d)) n++;
  return Math.max(n, 1);
}

// ---------------------------------------------------------------------------
// Small modals
// ---------------------------------------------------------------------------
export function modal(inner) {
  const el = $(`<div class="modal-backdrop cr-modal-bd" style="z-index:400"><div class="modal">${inner}</div></div>`);
  document.body.appendChild(el);
  return el;
}
export function confirmBox({ title, body, yes, danger }) {
  return new Promise((resolve) => {
    const el = modal(`<h2>${escapeHtml(title)}</h2><p class="help-text" style="font-size:14px;">${escapeHtml(body)}</p>
      <div class="form-actions"><button type="button" class="btn ${danger ? "danger" : ""}" data-y>${escapeHtml(yes)}</button><button type="button" class="btn secondary" data-n>Cancel</button></div>`);
    const done = (v) => { el.remove(); resolve(v); };
    el.querySelector("[data-y]").onclick = () => done(true);
    el.querySelector("[data-n]").onclick = () => done(false);
    el.addEventListener("click", (e) => { if (e.target === el) done(false); });
  });
}
export function infoBox(title, body) {
  return new Promise((resolve) => {
    const el = modal(`<h2>${escapeHtml(title)}</h2><p class="help-text" style="font-size:14px;">${escapeHtml(body)}</p>
      <div class="form-actions"><button type="button" class="btn" data-n>OK</button></div>`);
    const done = () => { el.remove(); resolve(); };
    el.querySelector("[data-n]").onclick = done;
    el.addEventListener("click", (e) => { if (e.target === el) done(); });
  });
}

