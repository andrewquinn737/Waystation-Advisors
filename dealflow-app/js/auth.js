import { supabase } from "./supabaseClient.js";
import { setOwnEmail } from "./contactIcons.js";
import { subscribeToPush } from "./push.js";
import { cacheGet, cacheSet, isNetworkError } from "./offlineCache.js";
import { defaultTimezone } from "./eventTime.js";

function hidePageLoadingOverlay() {
  document.getElementById("pageLoadingOverlay")?.classList.add("hidden");
}

/**
 * Call at the top of every protected page. Redirects to login.html if
 * there's no session, otherwise returns { user, profile }.
 * (No page-level gating by role here — team_lead is a real role again (see
 * supabase/schema.sql), but every page (Profile/Clients/Dials) is open to
 * every role; it's individual buttons/features within a page that check
 * profile.role, not whole-page access.)
 */
export async function requireSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "login.html";
    return null;
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, phone, email, team_id, avatar_url, notifications_enabled, last_daily_notif_date, calendly_link, use_own_calendly_link, timezone")
    .eq("id", session.user.id)
    .single();

  // A plain network hiccup fetching the profile used to be treated exactly
  // like "not logged in" and forced a redirect straight to login.html, even
  // though the session itself was perfectly valid — that was the main
  // source of the app "glitching" on bad wifi (a real connection blip would
  // bounce someone clean out of the app). Now: on a network-shaped failure,
  // fall back to whichever profile was cached from the last successful load
  // (see cacheSet below) and keep going instead of redirecting. Only a
  // genuinely missing session, or a real (non-network) error with nothing
  // cached yet, still sends someone to login.
  let resolvedProfile = profile;
  if (error || !profile) {
    const cached = isNetworkError(error) ? cacheGet("profile_" + session.user.id) : null;
    if (!cached) {
      console.error("Could not load profile", error);
      window.location.href = "login.html";
      return null;
    }
    resolvedProfile = cached;
  } else {
    cacheSet("profile_" + session.user.id, profile);
  }

  // Keeps profiles.timezone in sync with this device's actual current zone
  // — daily "upcoming event" push notifications are generated server-side
  // with no live browser context of their own (see
  // run_daily_event_notifications()/format_upcoming_event_message() in
  // supabase/schema.sql), so the RECIPIENT's own timezone has to already be
  // on file for that text to be formatted in it rather than the event's own
  // stored timezone (whoever scheduled it, not necessarily who's reading the
  // notification). Fire-and-forget, same pattern as subscribeToPush below —
  // harmless to re-check every page load, and picks up a real device
  // move/DST change automatically next time the app is opened.
  const deviceTimezone = defaultTimezone();
  if (resolvedProfile.timezone !== deviceTimezone) {
    supabase.from("profiles").update({ timezone: deviceTimezone }).eq("id", session.user.id);
    resolvedProfile.timezone = deviceTimezone;
  }

  // Lets the shared "Email" instant-contact icon (js/contactIcons.js) try to
  // open under the signed-in user's own Gmail account instead of whichever
  // Google account the device/browser currently treats as default — see the
  // comment above setOwnEmail() for why this only ever helps Gmail addresses,
  // never phone numbers, and always falls back to a plain mailto: otherwise.
  setOwnEmail(resolvedProfile.email);

  renderNav(resolvedProfile);

  // Real push notifications (see js/push.js) — subscribes this browser/
  // device once (upserted by endpoint, so re-running here on every page
  // load is harmless) so it can receive pushes from the send-push Edge
  // Function even while the app is fully closed. The old in-app bell and
  // client-side daily check are gone — the daily "upcoming events" check
  // now runs server-side (see run_daily_event_notifications() /
  // push_notifications_infra migration).
  subscribeToPush(resolvedProfile);

  // Removes the full-page loading overlay (see profile.html/clients.html/
  // dials.html) now that there's real content to show instead of it —
  // covers the blank-white-screen gap that used to show while the session/
  // profile fetch was in flight, which was most of what read as "delay
  // between loading screens" on a slow connection.
  hidePageLoadingOverlay();

  return { user: session.user, profile: resolvedProfile };
}

// Used by the desktop top bar's Sign out button, and (imported directly)
// by profile.js for the mobile Sign out button under Teams.
export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = "login.html";
}

const NAV_ICONS = {
  person:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>',
  handshake:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l3.5-3 3 2 2.5-2 2.5 2 3-2 3.5 3"/><path d="M3 13v3l3.5 3.5"/><path d="M21 13v3l-3.5 3.5"/><path d="M9.5 12l2 2.3a1 1 0 0 0 1.5 0l.5-.6a1 1 0 0 0 0-1.4L12 10"/></svg>',
  phone:
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
};

export function renderNav(profile) {
  const mount = document.getElementById("topnav");
  if (!mount) return;

  const page = document.body.dataset.page || "";
  const link = (href, label) =>
    `<a href="${href}" class="${page === href ? "active" : ""}">${label}</a>`;
  const iconLink = (href, icon, label) =>
    `<a href="${href}" class="${page === href ? "active" : ""}" title="${label}">${icon}</a>`;

  // Finance was a team-lead-only page — team leads are on hold for now (see
  // is_team_lead() in supabase/schema.sql), so its nav links are removed
  // rather than gated. finance.html itself is left in place, unlinked, for
  // whenever that comes back.
  //
  // Two nav presentations share the same markup pattern: a full top bar
  // (desktop) and a fixed bottom tab bar (mobile — see the max-width:720px
  // media query in css/style.css, which hides one and shows the other).
  // The bottom bar has no Sign out button — that lives on the Profile page
  // instead (mobile-only design) — and uses icons instead of text labels.
  mount.innerHTML = `
    <div class="topnav-bar">
      <div class="brand">Waystation Advisors</div>
      <div class="links">
        ${link("profile.html", "Profile")}
        ${link("clients.html", "Clients")}
        ${link("dials.html", "Dials")}
      </div>
      <div class="who">
        <span>${profile.full_name}</span>
        <span class="role-badge">${profile.role === "admin" ? "Admin" : profile.role === "team_lead" ? "Team lead" : "Intern"}</span>
        <button class="btn danger small" id="signOutBtn">Log out</button>
      </div>
    </div>
    <div class="bottom-tabbar">
      ${iconLink("profile.html", NAV_ICONS.person, "Profile")}
      ${iconLink("clients.html", NAV_ICONS.handshake, "Clients")}
      ${iconLink("dials.html", NAV_ICONS.phone, "Dials")}
    </div>
  `;

  document.getElementById("signOutBtn").addEventListener("click", signOut);
}

export function showError(el, err) {
  if (!el) return;
  el.textContent = err?.message || String(err);
  el.classList.remove("hidden");
}
