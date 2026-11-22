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
  const startMs = start.getTime();
  return (data || [])
    .map((r) => ({ ...r, overdue: new Date(r.callback_at).getTime() < startMs }))
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
  const shown = new Set(); // banners already put on screen this page load
  let loadedAt = 0;

  const key = (c) => `${c.id}|${c.callback_at}`;
  const timeLabel = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const who = (c) => esc([c.full_name, c.company_name].filter(Boolean).join(" · ") || "a prospect");

  function addBanner(c, soon) {
    const k = key(c);
    if (shown.has(k)) return;
    shown.add(k);
    const mins = Math.max(0, Math.ceil((new Date(c.callback_at) - Date.now()) / 60000));
    const el = document.createElement("div");
    el.className = `callback-banner${soon ? " soon" : ""}`;
    el.dataset.key = k;
    el.innerHTML = `<button type="button" class="callback-banner-main">
        <span class="callback-banner-title">${c.overdue ? `Overdue callback (${esc(new Date(c.callback_at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))})` : soon ? (mins <= 0 ? "Callback now" : `Callback in ${mins} min`) : `Callback today at ${esc(timeLabel(c.callback_at))}`}</span>
        <span class="callback-banner-who">${who(c)}</span>
      </button>
      <button type="button" class="callback-banner-x" aria-label="Dismiss">&times;</button>`;
    el.querySelector(".callback-banner-main").addEventListener("click", () => {
      window.location.href = `dials.html?dial=${encodeURIComponent(c.id)}`;
    });
    el.querySelector(".callback-banner-x").addEventListener("click", (e) => {
      e.stopPropagation();
      const d = readDismissed(profile.id);
      d.add(k);
      writeDismissed(profile.id, d);
      el.remove();
    });
    box.appendChild(el);
  }

  function evaluate() {
    const dismissed = readDismissed(profile.id);
    const now = Date.now();
    // drop banners whose callback was changed or cleared
    box.querySelectorAll(".callback-banner").forEach((el) => { if (el.dataset.key !== "overdue-more" && !callbacks.some((c) => key(c) === el.dataset.key)) { shown.delete(el.dataset.key); el.remove(); } });
    let overdueShown = 0, overdueExtra = 0;
    for (const c of callbacks) {
      const at = new Date(c.callback_at).getTime();
      const k = key(c);
      if (dismissed.has(k) || shown.has(k)) continue;
      const soon = at - now <= SOON_MS && at - now > -30 * 60 * 1000;
      if (c.overdue) { // listed once per day, never re-raised; at most 3 shown, the rest summarized in one banner
        if (firstOpen) { if (++overdueShown <= 3) addBanner(c, false); else overdueExtra++; }
        continue;
      }
      if (firstOpen && at > now - 30 * 60 * 1000) addBanner(c, soon);
      else if (soon) addBanner(c, true);
    }
    if (overdueExtra && !shown.has("overdue-more") && !dismissed.has("overdue-more")) {
      shown.add("overdue-more");
      const el = document.createElement("div");
      el.className = "callback-banner"; el.dataset.key = "overdue-more";
      el.innerHTML = `<button type="button" class="callback-banner-main"><span class="callback-banner-title">${overdueExtra} more overdue callback${overdueExtra === 1 ? "" : "s"}</span><span class="callback-banner-who">Open Profile to see them all</span></button><button type="button" class="callback-banner-x" aria-label="Dismiss">&times;</button>`;
      el.querySelector(".callback-banner-main").addEventListener("click", () => { window.location.href = "profile.html"; });
      el.querySelector(".callback-banner-x").addEventListener("click", (e) => { e.stopPropagation(); el.remove(); });
      box.appendChild(el);
    }
  }

  async function refresh() {
    callbacks = await loadTodaysCallbacks([profile.id]);
    loadedAt = Date.now();
    evaluate();
    if (firstOpen) {
      firstOpen = false; // only the first load of the day lists everything; later ones only add "coming up" banners
      try { localStorage.setItem(DAY_KEY(profile.id), todayStr()); } catch { /* storage blocked */ }
    }
  }

  refresh();
  setInterval(() => { if (Date.now() - loadedAt > 5 * 60 * 1000) refresh(); else evaluate(); }, 30 * 1000);
  window.addEventListener("callbacks-changed", () => refresh());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
}
