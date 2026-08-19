// ---------------------------------------------------------------------------
// Small localStorage-backed cache + a shared "offline" banner, used to make
// the app show the last loaded data (instead of glitching/going blank or
// bouncing to login) when wifi is bad or gone. See:
// - requireSession() in js/auth.js (falls back to a cached profile instead
//   of redirecting to login on a network error)
// - loadClients()/loadLists()/loadDials() in clients.js/dials.js
// - loadCallsChart()/loadIntroCallsChart()/loadUpcomingEvents() in profile.js
// ---------------------------------------------------------------------------

const PREFIX = "waystation_cache_";

export function cacheSet(key, data) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch {
    // Storage full/unavailable (private browsing, quota) — caching is a
    // nice-to-have, never worth breaking the app over.
  }
}

export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Supabase-js surfaces a lost connection as a plain failed fetch, not a
// Postgres/PostgREST error shape — browsers phrase it slightly differently
// ("Failed to fetch" / "NetworkError..." / "Load failed"), hence the OR. A
// real server-side error (bad RLS policy, bad query, a 4xx from PostgREST)
// always comes back as a normal Supabase {error} with a Postgres code/
// message, never one of these — so this never masks an actual bug behind a
// generic "offline" message.
export function isNetworkError(err) {
  if (!err) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("load failed") || msg.includes("network request failed");
}

// One shared banner per page (id="offlineNotice", present in profile.html/
// clients.html/dials.html right next to #errorBox) rather than one per list,
// since only one is ever likely to be showing at a time and it keeps every
// page's "you're offline" messaging identical.
export function showOfflineNotice(stale) {
  const el = document.getElementById("offlineNotice");
  if (!el) return;
  el.textContent = stale ? "You're offline — showing the last loaded data." : "No internet connection.";
  el.classList.remove("hidden");
}

export function hideOfflineNotice() {
  document.getElementById("offlineNotice")?.classList.add("hidden");
}

// A request landing right as a PWA resumes from being backgrounded can fail
// even though the connection is completely fine — a known iOS Safari/WKWebView
// quirk (and the navigator.onLine read above isn't perfectly reliable either)
// — and isNetworkError() has no way to tell that apart from an actual outage,
// since the browser hands back the exact same "Failed to fetch"/"Load failed"
// text either way. Real, confirmed symptom: "instant contact" reporting "No
// internet connection" on a device that was definitely online. One silent
// retry after a short pause absorbs a one-off blip like that before ever
// bothering the user with it — only a SECOND consecutive failure is treated
// as an actual connectivity problem. `fn` is a thunk returning a Supabase
// call's `{data, error}` result (never throws on a network failure — see
// isNetworkError's own comment on that).
export async function withNetworkRetry(fn) {
  const first = await fn();
  if (!first.error || !isNetworkError(first.error)) return first;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return fn();
}
