// Best-effort page-zoom blocker. The viewport meta tag's maximum-scale=1 /
// user-scalable=no (see every page's <head>) is what actually stops pinch
// zoom on mobile Safari/Chrome. This file covers the desktop gestures that
// meta tag doesn't touch:
//   - Ctrl/Cmd + mouse wheel (the standard "zoom the page" trackpad/mouse
//     gesture in Chrome/Edge/Firefox)
//   - Trackpad pinch on Safari/macOS, which fires as "gesturestart" /
//     "gesturechange" / "gestureend" events instead of wheel events
//   - Double-tap-to-zoom on mobile browsers that don't fully honor
//     user-scalable=no (older WebKit)
// Note: this can't block the browser's own keyboard shortcuts (Ctrl/Cmd +
// "+"/"-"/"0") — those are handled by the browser chrome itself before the
// page ever sees the keypress, and browsers deliberately don't let pages
// intercept them (it's an accessibility escape hatch users always keep).
(function () {
  document.addEventListener(
    "wheel",
    function (e) {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false }
  );

  ["gesturestart", "gesturechange", "gestureend"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      e.preventDefault();
    });
  });

  let lastTouchEnd = 0;
  document.addEventListener(
    "touchend",
    function (e) {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false }
  );
})();
