import { supabase } from "./supabaseClient.js";

// ---------------------------------------------------------------------------
// Notifications — server-side creation + the on/off preference. The actual
// delivery is now a real OS-level push notification (see js/push.js for the
// client-side subscribe, and the send-push Edge Function for the send side)
// instead of the old in-app bell/dropdown inbox, which has been removed.
//
// createNotification() calls the create_notification() Postgres RPC, which
// still does the only insert into `notifications` and still honors the
// recipient's profiles.notifications_enabled server-side. A trigger on that
// table (added by the push_notifications_infra migration) fires the
// send-push Edge Function for every insert — this file doesn't need to know
// anything about that.
//
// Two triggers create a notification (both server-side, both unchanged from
// before): transferring a dial tab to someone (js/dials.js's
// completeTransfer()) and the once-daily "upcoming events today" check,
// which now runs server-side via pg_cron (run_daily_event_notifications())
// instead of client-side on page load.
// ---------------------------------------------------------------------------

export async function createNotification(userId, message, type = null) {
  const { error } = await supabase.rpc("create_notification", {
    p_user_id: userId,
    p_message: message,
    p_type: type,
  });
  if (error) console.error("createNotification failed", error);
}

// Settings-gear "Notifications: On/Off" toggle — wired from profile.js/
// dials.js/clients.js's settings-gear block, available to every role
// (unlike Sellers/Buyers + Accounts visible, which stay admin/team-lead-only).
// Same on/off preference as before; it now gates real push sends instead of
// in-app ones, but the mechanism (profiles.notifications_enabled, checked
// server-side in create_notification()) is unchanged.
export function wireNotificationsToggle(toggleBtn, labelEl, profile) {
  if (!toggleBtn || !labelEl) return;
  const render = () => {
    const isOff = profile.notifications_enabled === false;
    labelEl.textContent = isOff ? "Notifications: Off" : "Notifications: On";
    // Draws a diagonal slash through the bell icon when off — see the
    // .notif-slash <line> in profile.html/dials.html/clients.html and its
    // CSS rule in css/style.css.
    toggleBtn.classList.toggle("notif-off", isOff);
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
