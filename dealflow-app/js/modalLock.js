// Shared "full/near-full-screen popup is open" lock — used by the Dials
// detail popup, the Clients detail popup, and the Teams popup (profile.js).
// Small centered confirm/info dialogs (delete confirmation, required-fields,
// new-list, intro-call) don't use this — they're compact enough that
// background scroll was never an issue for them.
//
// Two things happen while locked:
//  1. The page behind the popup can't scroll. Pinning <body> to
//     position:fixed at its current scroll offset handles the common case
//     (and is what stops iOS Safari's rubber-band scroll from moving the
//     page behind a fixed-position overlay), but it only works if <body> is
//     actually the scrolling element. In standards mode (this app has a
//     <!DOCTYPE html>), the *real* scrolling element is <html>, so a wheel
//     scroll over a popup whose own content is short enough to need no
//     internal scrolling would otherwise "fall through" straight to
//     <html>'s scroll, bypassing the body-position trick entirely — that's
//     why a short dial/client popup could still scroll the list behind it
//     even though a long one (which scrolls internally) couldn't. Also
//     setting overflow:hidden on <html> removes that fallback scroll target
//     completely, so there's nothing left for the gesture to fall through
//     to, regardless of the popup's own content height.
//  2. The top nav (desktop top bar / mobile bottom tab bar — both live
//     inside #topnav) is hidden, since a full-screen popup already covers
//     that area and its Profile/Clients/Dials links shouldn't be usable
//     (or visible) until the popup closes.
let savedScrollY = 0;
let locked = false;

export function lockPageScroll() {
  if (locked) return;
  locked = true;
  savedScrollY = window.scrollY || window.pageYOffset || 0;
  document.documentElement.style.overflow = "hidden";
  document.body.style.position = "fixed";
  document.body.style.top = `-${savedScrollY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
  const nav = document.getElementById("topnav");
  if (nav) nav.classList.add("hidden");
}

export function unlockPageScroll() {
  if (!locked) return;
  locked = false;
  document.documentElement.style.overflow = "";
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  window.scrollTo(0, savedScrollY);
  const nav = document.getElementById("topnav");
  if (nav) nav.classList.remove("hidden");
}
