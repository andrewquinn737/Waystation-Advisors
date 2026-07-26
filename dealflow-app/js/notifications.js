import { supabase } from "./supabaseClient.js";

// ---------------------------------------------------------------------------
// Notifications feature — an in-app bell/badge/dropdown inbox, mounted into
// the shared top nav (see auth.js's requireSession(), which calls
// mountNotificationsBell(profile) right after renderNav(profile) on every
// page) plus a Notifications on/off toggle in each page's settings-gear menu
// (see wireNotificationsToggle, wired from profile.js/dials.js/clients.js).
//
// Two triggers currently create a notification (both server-side, via the
// create_notification() Postgres RPC — see the migration that added the
// `notifications` table): transferring a dial tab to someone (js/dials.js's
// completeTransfer()) and the once-daily "upcoming events today" check
// (checkDailyEventNotifications() below, called once per page load from
// auth.js — deduped server-side via profiles.last_daily_notif_date so it
// only actually fires once per calendar day per account no matter how many
// devices/tabs are open).
//
// The on/off toggle is honored at the DB layer: create_notification() looks
// up the recipient's profiles.notifications_enabled and no-ops (skips the
// insert) if it's false, rather than trusting the client.
// ---------------------------------------------------------------------------

const BELL_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

export async function createNotification(userId, message, type = null) {
  const { error } = await supabase.rpc("create_notification", {
    p_user_id: userId,
    p_message: message,
    p_type: type,
  });
  if (error) console.error("createNotification failed", error);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtWhen(iso) {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// One shared bell instance per page (Profile/Clients/Dials each mount their
// own copy of the nav, but only ever one at a time) — state kept module-level
// so refreshBellBadgeOnly() (called once at mount) and the click-to-open
// handler (which does a full refreshBell()) can both reach the same DOM refs.
let bellState = null;

async function fetchNotifications(profileId) {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, message, type, read, created_at")
    .eq("user_id", profileId)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) {
    console.error("fetchNotifications failed", error);
    return [];
  }
  return data || [];
}

function renderBadge(count) {
  if (!bellState) return;
  if (count > 0) {
    bellState.badge.textContent = count > 99 ? "99+" : String(count);
    bellState.badge.classList.remove("hidden");
  } else {
    bellState.badge.classList.add("hidden");
  }
}

async function refreshBellBadgeOnly() {
  if (!bellState) return;
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", bellState.profile.id)
    .eq("read", false);
  if (error) {
    console.error("refreshBellBadgeOnly failed", error);
    return;
  }
  renderBadge(count || 0);
}

async function refreshBell() {
  if (!bellState) return;
  const rows = await fetchNotifications(bellState.profile.id);
  const unreadCount = rows.filter((r) => !r.read).length;
  renderBadge(unreadCount);

  if (!rows.length) {
    bellState.list.innerHTML = `<div class="notifications-empty">No notifications yet.</div>`;
    return;
  }
  bellState.list.innerHTML = rows
    .map(
      (r) => `
      <div class="notification-item ${r.read ? "" : "unread"}" data-id="${r.id}">
        <div class="notification-message">${escapeHtml(r.message)}</div>
        <div class="notification-when">${fmtWhen(r.created_at)}</div>
      </div>`
    )
    .join("");

  // Tapping a notification marks it read (no navigation target for now —
  // both notification types are informational only).
  bellState.list.querySelectorAll(".notification-item[data-id]").forEach((el) => {
    el.addEventListener("click", async () => {
      if (!el.classList.contains("unread")) return;
      el.classList.remove("unread");
      const id = el.dataset.id;
      const { error } = await supabase.from("notifications").update({ read: true }).eq("id", id);
      if (error) console.error("mark read failed", error);
      refreshBellBadgeOnly();
    });
  });
}

// Mounts the bell button + dropdown panel into the shared top nav, right
// before the "who" block (name/role badge/Log out) that renderNav() already
// rendered — see js/auth.js. No-ops harmlessly if .topnav .who isn't found
// (shouldn't happen on any page that calls requireSession()).
export function mountNotificationsBell(profile) {
  const mount = document.querySelector(".topnav .who");
  if (!mount) return;

  const wrap = document.createElement("div");
  wrap.className = "notifications-bell-wrap";
  wrap.innerHTML = `
    <button type="button" class="notifications-bell-btn" aria-label="Notifications">
      ${BELL_SVG}
      <span class="notifications-badge hidden"></span>
    </button>
    <div class="notifications-panel hidden">
      <div class="notifications-panel-title">Notifications</div>
      <div class="notifications-list"></div>
    </div>`;
  mount.parentElement.insertBefore(wrap, mount);

  bellState = {
    profile,
    wrap,
    badge: wrap.querySelector(".notifications-badge"),
    panel: wrap.querySelector(".notifications-panel"),
    list: wrap.querySelector(".notifications-list"),
  };

  const btn = wrap.querySelector(".notifications-bell-btn");
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const opening = bellState.panel.classList.contains("hidden");
    document.querySelectorAll(".notifications-panel").forEach((p) => p.classList.add("hidden"));
    if (opening) {
      bellState.panel.classList.remove("hidden");
      await refreshBell();
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest(".notifications-bell-wrap")) return;
    bellState.panel.classList.add("hidden");
  });

  refreshBellBadgeOnly();
}

// Settings-gear "Notifications: On/Off" toggle — wired from profile.js/
// dials.js/clients.js's settings-gear block, available to every role
// (unlike Sellers/Buyers + Accounts visible, which stay admin/team-lead-only).
export function wireNotificationsToggle(toggleBtn, labelEl, profile) {
  if (!toggleBtn || !labelEl) return;
  const render = () => {
    labelEl.textContent = profile.notifications_enabled === false ? "Notifications: Off" : "Notifications: On";
  };
  render();
  toggleBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = !(profile.notifications_enabled !== false);
    profile.notifications_enabled = next;
    render();
    const { error } = await supabase.from("profiles").update({ notifications_enabled: next }).eq("id", profile.id);
    if (error) {
      console.error("Failed to update notifications_enabled", error);
      profile.notifications_enabled = !next;
      render();
    }
  });
}

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Once-per-calendar-day "upcoming events today" check — called once from
// auth.js's requireSession() on every page load. Dedupes server-side via
// profiles.last_daily_notif_date (claimed BEFORE the notifications_enabled
// check below, so a disabled account doesn't re-check every page load for
// the rest of the day either) so it fires exactly once per account per day
// regardless of how many devices/tabs that person has open.
export async function checkDailyEventNotifications(profile) {
  const todayStr = localDateStr(new Date());
  if (profile.last_daily_notif_date === todayStr) return;

  // Claim today's run first (optimistic — a race between two tabs loading
  // at the same instant could in theory both pass the check above before
  // either writes, but this is a low-stakes, informational feature, so a
  // rare duplicate isn't worth adding a DB-level unique-claim mechanism for).
  const { error: claimErr } = await supabase.from("profiles").update({ last_daily_notif_date: todayStr }).eq("id", profile.id);
  if (claimErr) {
    console.error("Failed to claim daily notification check", claimErr);
    return;
  }
  profile.last_daily_notif_date = todayStr;

  if (profile.notifications_enabled === false) return;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

  const { data, error } = await supabase
    .from("client_events")
    .select("id, event_type, event_date, confirmed, client_id, clients!inner(id, first_name, last_name, created_by)")
    .gte("event_date", startOfToday.toISOString())
    .lt("event_date", startOfTomorrow.toISOString())
    .eq("clients.created_by", profile.id);
  if (error) {
    console.error("checkDailyEventNotifications fetch failed", error);
    return;
  }

  const rows = (data || []).filter((r) => r.event_type !== "created" && !r.confirmed);
  for (const r of rows) {
    const c = r.clients;
    const name = `${c.first_name} ${c.last_name}`.trim();
    await createNotification(profile.id, `Upcoming event today: ${name}.`, "upcoming_event");
  }
}
