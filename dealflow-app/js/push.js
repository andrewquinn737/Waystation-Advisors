import { supabase } from "./supabaseClient.js";
import { VAPID_PUBLIC_KEY } from "./config.js";

// ---------------------------------------------------------------------------
// Real OS-level push notifications — replaces the old in-app bell/dropdown
// inbox (js/notifications.js used to own this; that file now only keeps
// createNotification() + the on/off toggle). Called once from js/auth.js's
// requireSession() on every page, same as the old bell mount used to be.
//
// Every user has this PWA added to their home screen, so a real
// subscription is possible everywhere (iOS requires 16.4+ and "added to
// home screen" for Web Push — a bare Safari tab can't do it, but nothing
// here breaks if that's the case; it just silently no-ops below).
//
// Server side: create_notification() (supabase/schema.sql) is unchanged and
// still the single insert point into `notifications`, still honored by
// profiles.notifications_enabled — see wireNotificationsToggle() in
// js/notifications.js. A trigger on that table (send_push_trigger(), added
// by the push_notifications_infra migration) fires the send-push Edge
// Function for every insert, which reads this user's rows from
// push_subscriptions (populated below) and delivers the actual push.
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function subscribeToPush(profile) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

  try {
    const registration = await navigator.serviceWorker.ready;

    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const json = subscription.toJSON();
    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: profile.id,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      },
      { onConflict: "endpoint" }
    );
    if (error) console.error("Failed to save push subscription", error);
  } catch (err) {
    // Not fatal — e.g. permission denied, or a browser/OS that doesn't
    // support Web Push at all. The app works fine without it.
    console.error("subscribeToPush failed", err);
  }
}
