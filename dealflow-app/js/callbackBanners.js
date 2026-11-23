// Callback banners: a stack at the top of every page for today's scheduled callbacks (dials.callback_at, set from the
// dial's "Callback" button). On the first open of each day it lists every callback still ahead today; after that a
// banner appears when one is within 5 minutes. Each has an × (dismissed for good) and tapping it opens the dial
// (dials.html?dial=ID). The push notification for the same reminder is sent server-side (run_callback_reminders()).
import { supabase } from "./supabaseClient.js";
import { markOpenedNotificationsRead } from "./notifications.js";

const DAY_KEY = (id) => `cb_banner_day_${id}`;
const DISMISS_KEY = (id) => `cb_banner_dismissed_${id}`;
const SOON_MS = 5 * 60 * 1000;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayStr = () => new Date().toDateString();

function readDismissed(profileId) {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY(profileId)) || "[]")); } catch { return new Set(); }
}
function writeDismissed(profileId, set) {
  try { localStorage.setItem(DISMISS_KEY(profileId), JSON.stringify([...set].slice(-200))); } catch { /* storage blocked */ }
}

// Today's callbacks plus any still-open overdue ones (up to 14 days late, dial still in a callback category). Overdue rows carry
// `overdue: true`.
export async function loadTodaysCallbacks(userIds) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const past = new Date(start); past.setDate(past.getDate() - 14);
  const { data, error } = await supabase
    .from("dials")
    .select("id, full_name, company_name, callback_at, contact_status, dial_lists!inner(deleted_at)")
    .in("callback_user_id", userIds)
    .is("dial_lists.deleted_at", null)
    .gte("callback_at", past.toISOString())
    .lt("callback_at", end.toISOString())
    .order("callback_at", { ascending: true });
  if (error) return [];
  // Overdue = the callback time is more than half an hour gone (earlier today counts, not only yesterday and before).
  const lateMs = Date.now() - 30 * 60 * 1000;
  return (data || [])
    .map((r) => ({ ...r, overdue: new Date(r.callback_at).getTime() < lateMs }))
    .filter((r) => !r.overdue || ["busy_callback", "callback_interested"].includes(r.contact_status));
}

export function initCallbackBanners(profile) {
  if (!profile?.id || window.__callbackBannersStarted) return;
  window.__callbackBannersStarted = true;
  markOpenedNotificationsRead(profile.id);

  const box = document.createElement("div");
  box.id = "callbackBanners";
  box.className = "callback-banners";
  const nav = document.getElementById("topnav");
  if (nav && nav.parentNode) nav.insertAdjacentElement("afterend", box);
  else document.body.prepend(box);

  let callbacks = [];
  let firstOpen = false;
  try { firstOpen = localStorage.getItem(DAY_KEY(profile.id)) !== todayStr(); } catch { /* storage blocked */ }
  const shown = new Map(); // key -> callback put on screen this page load (listed in the one summary line)
  let loadedAt = 0, expanded = false;

  const key = (c) => `${c.id}|${c.callback_at}`;
  const timeLabel = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const who = (c) => esc([c.full_name, c.company_name].filter(Boolean).join(" · ") || "a prospect");
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  // ONE compact line ("3 overdue callbacks · 2 today · View"); tapping it lists them, each opens its dial. The x dismisses all listed.
  function render() {
    const rows = [...shown.values()].filter((c) => callbacks.some((x) => key(x) === key(c)));
    box.innerHTML = "";
    if (!rows.length || document.body.dataset.page === "profile.html") return; // Profile has its own Callbacks box right there
    const overdue = rows.filter((c) => c.overdue), today = rows.filter((c) => !c.overdue);
    const soon = today.find((c) => { const d = new Date(c.callback_at) - Date.now(); return d <= SOON_MS && d > -30 * 60 * 1000; });
    const bits = [];
    if (soon) { const m = Math.max(0, Math.ceil((new Date(soon.callback_at) - Date.now()) / 60000)); bits.push(m <= 0 ? "Callback now" : `Callback in ${m} min`); }
    if (overdue.length) bits.push(`${plural(overdue.length, "overdue callback")}`);
    const rest = today.length - (soon ? 1 : 0);
    if (rest > 0) bits.push(`${rest} today`);
    const el = document.createElement("div");
    el.className = `callback-banner${soon ? " soon" : ""}`;
    el.innerHTML = `<button type="button" class="callback-banner-main" aria-expanded="${expanded}"><span class="callback-banner-title">${esc(bits.join(" · "))}</span><span class="callback-banner-view">${expanded ? "Hide" : "View"}</span></button>
      <button type="button" class="callback-banner-x" aria-label="Dismiss">&times;</button>
      ${expanded ? `<div class="callback-banner-list">${rows.map((c) => `<button type="button" class="callback-banner-item" data-id="${esc(c.id)}"><span class="callback-banner-when">${c.overdue && new Date(c.callback_at).toDateString() !== todayStr() ? esc(new Date(c.callback_at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })) : esc(timeLabel(c.callback_at))}</span><span class="callback-banner-who">${who(c)}</span></button>`).join("")}</div>` : ""}`;
    el.querySelector(".callback-banner-main").addEventListener("click", () => { expanded = !expanded; render(); });
    el.querySelector(".callback-banner-x").addEventListener("click", (e) => {
      e.stopPropagation();
      const d = readDismissed(profile.id);
      rows.forEach((c) => { d.add(key(c)); shown.delete(key(c)); });
      writeDismissed(profile.id, d);
      render();
    });
    el.querySelectorAll(".callback-banner-item").forEach((b) => b.addEventListener("click", () => { window.location.href = `dials.html?dial=${encodeURIComponent(b.dataset.id)}`; }));
    box.appendChild(el);
  }

  function evaluate() {
    const dismissed = readDismissed(profile.id);
    const now = Date.now();
    for (const k of [...shown.keys()]) if (!callbacks.some((c) => key(c) === k)) shown.delete(k); // callback changed or cleared
    for (const c of callbacks) {
      const at = new Date(c.callback_at).getTime();
      const k = key(c);
      if (dismissed.has(k)) continue;
      if (shown.has(k)) { shown.set(k, c); continue; } // keep the latest copy (a callback missed since the page opened turns overdue)
      const soon = at - now <= SOON_MS && at - now > -30 * 60 * 1000;
      if (c.overdue) { if (firstOpen) shown.set(k, c); continue; } // listed once per day, never re-raised
      if ((firstOpen && at > now - 30 * 60 * 1000) || soon) shown.set(k, c);
    }
    render();
  }

  async function refresh() {
    callbacks = await loadTodaysCallbacks([profile.id]);
    loadedAt = Date.now();
    evaluate();
    // Profile shows no banner, so it must not use up the day's first-open listing (it would never appear on Calls).
    if (firstOpen && document.body.dataset.page !== "profile.html") {
      firstOpen = false; // only the first load of the day lists everything; later ones only add "coming up" banners
      try { localStorage.setItem(DAY_KEY(profile.id), todayStr()); } catch { /* storage blocked */ }
    }
  }

  refresh();
  setInterval(() => { if (Date.now() - loadedAt > 5 * 60 * 1000) refresh(); else evaluate(); }, 30 * 1000);
  window.addEventListener("callbacks-changed", () => refresh());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
}
