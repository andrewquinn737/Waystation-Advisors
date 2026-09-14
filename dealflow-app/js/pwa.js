// Registers the service worker so the app is installable on Android/iOS
// home screens. Safe to include on every page; no-op if unsupported.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}

// ---------------------------------------------------------------------------
// Backstop for real, confirmed reports of the app "not loading until I
// force-quit and reopen": requireSession() (js/auth.js) and the service
// worker's own fetch handler already race their network calls against a
// timeout for exactly this reason, but a report surviving that fix means
// there's some OTHER stuck point on the way to first render this doesn't
// know to specifically guard.
//
// CAUSED A REAL PRODUCTION INCIDENT once already (app broken for everyone,
// on every device, as a "perpetual glitching skeleton screen") — an earlier
// version of this also listened for `pageshow` and `focus`, alongside
// `visibilitychange`, reasoning (wrongly) that more signals meant better
// coverage of iOS's own unreliable resume events. Both fire on a completely
// NORMAL fresh page load too, not just a resume: `pageshow` fires right
// after `load`, and `focus` whenever the tab/window gains focus, which a
// brand new tab does almost immediately — both fire before requireSession()'s
// own async session/profile fetch has necessarily finished hiding the
// overlay, so EVERY single page load was re-triggering a reload before the
// overlay could ever be hidden. Infinite loop, confirmed by reproducing it
// directly, not guessed at after the fact.
//
// `visibilitychange` alone doesn't have that flaw — structurally, it only
// ever fires on a genuine hidden -> visible TRANSITION of a document that's
// already been sitting there; a fresh load has no prior state to transition
// FROM, so it never fires spuriously on first load the way pageshow/focus
// do. Left as the only trigger here. A minimum "was actually hidden for a
// little while" gate (HIDDEN_MS_THRESHOLD) additionally avoids reload-
// bombing a merely-slow-but-still-progressing load if someone glances away
// and back quickly while it's still finishing on its own.
const HIDDEN_MS_THRESHOLD = 5000;
let hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  if (document.visibilityState !== "visible" || hiddenAt === null) return;
  const wasHiddenForMs = Date.now() - hiddenAt;
  hiddenAt = null;
  if (wasHiddenForMs < HIDDEN_MS_THRESHOLD) return;
  const overlay = document.getElementById("pageLoadingOverlay");
  // Safe specifically because there's nothing to lose at this point: no
  // real content has rendered yet and no input has been entered anywhere
  // (this never fires once #pageLoadingOverlay has already been hidden —
  // see hidePageLoadingOverlay() in js/auth.js). No-op on any page without
  // the overlay (login.html, etc.).
  if (overlay && !overlay.classList.contains("hidden")) {
    window.location.reload();
  }
});
