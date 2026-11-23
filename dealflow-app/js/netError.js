// Friendly wording for failed requests, and the full-page "can't reach the server" screen (round 5).
// A failed fetch is not a sign-out: only a real auth rejection (401 / no session) may send someone to the login page.
import { isNetworkError } from "./offlineCache.js";

export const NET_MESSAGE = "Couldn't reach the server. Check your connection and try again.";
export const BUSY_MESSAGE = "The server is busy right now. Try again in a moment.";

// 401 / expired or invalid token: the sign-in itself is no good.
export function isAuthFailure(err) {
  if (!err) return false;
  const s = Number(err.status);
  return s === 401 || s === 403 || err.code === "PGRST301" || err.code === "PGRST302" || /\bjwt\b|not authenticated|invalid refresh token/i.test(String(err.message || ""));
}
// The server answered but is down or overloaded (the free tier does this): worth a Retry, not a sign-out.
export function isServerBusy(err) {
  if (!err) return false;
  const s = Number(err.status);
  return s >= 500 || err.code === "PGRST002" || /schema cache|service unavailable|bad gateway|gateway time/i.test(String(err.message || ""));
}
export const isTransient = (err) => isNetworkError(err) || isServerBusy(err);

// The text to show someone for an error: never "TypeError: Failed to fetch".
export function friendlyMessage(err, fallback) {
  if (isNetworkError(err)) return navigator.onLine === false ? "You're offline. Check your connection and try again." : NET_MESSAGE;
  if (isServerBusy(err)) return BUSY_MESSAGE;
  const m = String(err?.message ?? err ?? "").trim();
  return m || fallback || "Something went wrong. Try again.";
}

// Adds a Retry button to an error element (the element's own text stays as it is).
export function addRetry(el, onRetry) {
  if (!el || !onRetry) return;
  const b = document.createElement("button");
  b.type = "button"; b.className = "btn small secondary retry-btn"; b.textContent = "Retry";
  b.addEventListener("click", () => { b.disabled = true; try { onRetry(); } catch { /* ignore */ } });
  el.appendChild(document.createTextNode(" ")); el.appendChild(b);
}

// Replaces the loading skeleton with a message and a Retry button (used when the app cannot even load the signed-in profile).
export function showFatalScreen(message, onRetry) {
  document.getElementById("pageLoadingOverlay")?.classList.add("hidden");
  document.getElementById("netFatal")?.remove();
  const d = document.createElement("div");
  d.id = "netFatal"; d.className = "net-fatal"; d.setAttribute("role", "alert");
  d.innerHTML = `<div class="net-fatal-card"><h2>Can't load right now</h2><p></p><button type="button" class="btn">Retry</button></div>`;
  d.querySelector("p").textContent = message;
  d.querySelector("button").addEventListener("click", onRetry || (() => location.reload()));
  document.body.appendChild(d);
  d.querySelector("button").focus();
}
