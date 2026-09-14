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
// know to specifically guard — plausible given a documented WebKit quirk:
// the very visibilitychange event this fix listens for is itself
// unreliable on the "became visible again" edge in iOS WKWebView, so
// EXACTLY which fetch a resume leaves hanging is genuinely not something
// any one timeout can guarantee catching.
//
// So instead of guessing at another specific spot, this only ever does one
// simple, safe thing: if the page is STILL sitting on the initial loading
// overlay by the time the app becomes visible again, something upstream of
// first render never finished — reload outright instead of continuing to
// wait on it. This is safe specifically because there's nothing to lose at
// that point: no real content has rendered yet and no input has been
// entered anywhere (compare a full "reload any time the app resumes from
// background" policy, which would risk discarding in-progress work in an
// open form — this never fires once #pageLoadingOverlay has already been
// hidden, see hidePageLoadingOverlay() in js/auth.js). A plain reload gets
// a fresh WKWebView network session instead of whatever got stuck. No-op
// on any page without the overlay (login.html, etc.).
function reloadIfStillStuckLoading() {
  const overlay = document.getElementById("pageLoadingOverlay");
  if (overlay && !overlay.classList.contains("hidden")) {
    window.location.reload();
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") reloadIfStillStuckLoading();
});
// pageshow (bfcache restores) and focus are both included alongside
// visibilitychange, not instead of it, specifically because of that same
// "unreliable on resume" quirk above — belt and suspenders, whichever one
// actually fires first wins; reloadIfStillStuckLoading() itself is a no-op
// once the real one has already run (the overlay's hidden by then either
// way), so firing more than once here is harmless.
window.addEventListener("pageshow", reloadIfStillStuckLoading);
window.addEventListener("focus", reloadIfStillStuckLoading);
