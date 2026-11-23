// One helper for every dialog, popup, sheet and menu (round 5). Loaded by js/auth.js, so every signed-in page has it.
//  - Esc closes the topmost open layer (the same way its own Close/Cancel button would, so page logic such as saving notes still runs)
//  - Tab stays inside the topmost dialog (menus are not trapped)
//  - focus moves into a dialog when it opens and returns to whatever opened it when it closes
//  - dialogs get role="dialog" aria-modal="true" and a label
// It watches the page instead of being called from each dialog, so a new popup only has to use one of the classes below.
// Opt out of the Esc part with data-esc="own" (the dialog has its own Esc rules) or data-esc="none".
import { closeAllPageHeaderMenus } from "./pageHeaderMenu.js";

const MODAL_SEL = ".modal-backdrop, .fullscreen-modal, .ad-sheet-bd, .cr-panel";
const MENU_SEL = ".page-header-menu, .cp-menu, .timeline-add-menu";
const ALL_SEL = MODAL_SEL + ", " + MENU_SEL;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
// Close controls in priority order. The first one that exists and is visible is used; a disabled one means "not allowed right now".
const CLOSERS = ["[data-esc-close]", ".fs-close", "[id$='Close']", "[id$='CloseBtn']", "[id$='CancelBtn']", "[id$='Cancel']", "[id$='NoBtn']", "[data-n]", "[id$='OkBtn']", "[id$='Ok']", "[id$='Fill']"];

const stack = [];            // [{ el, opener, modal }] in the order they opened; last = topmost
let lastPointer = null;      // the control last pressed with a mouse/finger (Safari does not focus buttons on click)
let queued = false;
let restoreToken = 0;

const isModal = (el) => el.matches(MODAL_SEL);
const visible = (el) => !!el && el.getClientRects().length > 0;
const isOpen = (el) => el.isConnected && !el.classList.contains("hidden") && !el.hidden && visible(el);
const focusables = (layer) => [...layer.querySelectorAll(FOCUSABLE)].filter((e) => visible(e) && !e.closest("[inert]"));

function findOpener(layer) {
  const a = document.activeElement;
  if (a && a !== document.body && !layer.contains(a)) return a;
  const p = lastPointer;
  if (p && p.isConnected && !layer.contains(p)) return p.closest("button, a, [role='button'], summary, .dh-row, .mobile-card, tr, [tabindex], input, select") || p;
  return null;
}

function describe(layer) {
  if (!layer.hasAttribute("role")) layer.setAttribute("role", "dialog");
  layer.setAttribute("aria-modal", "true");
  if (!layer.hasAttribute("aria-label") && !layer.hasAttribute("aria-labelledby")) {
    const h = layer.querySelector("h1, h2, h3");
    const t = h && h.textContent.trim();
    if (t) layer.setAttribute("aria-label", t);
  }
}

function enter(el) {
  restoreToken++;
  const modal = isModal(el), opener = findOpener(el), entry = { el, opener, modal, locator: locatorFor(opener) };
  stack.push(entry);
  if (modal) describe(el);
  if (el.contains(document.activeElement)) return;
  if (modal) { if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true }); }
  else { const first = focusables(el)[0]; if (first) first.focus({ preventScroll: true }); }
}

// A way to find the opener again if the page re-draws its list while the dialog is open (the row is a new element then).
function locatorFor(el) {
  if (!el) return null;
  if (el.id) return "#" + CSS.escape(el.id);
  for (const a of ["data-d", "data-id", "data-dial-id", "data-event-id"]) if (el.hasAttribute(a)) return `${el.tagName.toLowerCase()}[${a}="${CSS.escape(el.getAttribute(a))}"]`;
  return null;
}

function focusEl(el) {
  el.focus({ preventScroll: true });
  if (document.activeElement !== el) { el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true }); }   // a row or card that is not natively focusable
}

function leave(entry) {
  let { opener } = entry;
  const a = document.activeElement;
  // only take focus back if it was lost with the layer; someone who clicked another field keeps it
  const lost = !a || a === document.body || entry.el.contains(a);
  if (!lost) return;
  if ((!opener || !opener.isConnected) && entry.locator) opener = document.querySelector(entry.locator);
  if (opener && opener.isConnected && visible(opener) && !opener.disabled) focusEl(opener);
  // the page may re-draw its list a moment after closing (Calls does, once its data comes back): for a few seconds, put focus back
  // on the re-drawn opener, but only while focus is still lost (anything the person focused meanwhile wins)
  const mine = ++restoreToken;   // a newer layer opening or closing cancels this
  if (entry.locator && entry.modal) {
    let tries = 0;
    const again = () => {
      if (mine !== restoreToken) return;
      const cur = document.activeElement;
      if (!cur || cur === document.body) { const el = document.querySelector(entry.locator); if (el && visible(el)) focusEl(el); }
      if (++tries < 12) setTimeout(again, 300);
    };
    setTimeout(again, 300);
  }
}

function scan() {
  queued = false;
  const open = [...document.querySelectorAll(ALL_SEL)].filter(isOpen);
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!open.includes(stack[i].el)) leave(stack.splice(i, 1)[0]);
  }
  for (const el of open) if (!stack.some((s) => s.el === el)) enter(el);
}
const schedule = () => { if (!queued) { queued = true; queueMicrotask(scan); } };

function closeLayer(entry) {
  const { el } = entry;
  if (!entry.modal) {
    if (el.classList.contains("page-header-menu")) closeAllPageHeaderMenus();
    if (isOpen(el)) el.classList.add("hidden");
    return;
  }
  for (const sel of CLOSERS) {
    const btn = [...el.querySelectorAll(sel)].find((b) => b.tagName === "BUTTON" || b.tagName === "A" ? visible(b) : false);
    if (!btn) continue;
    if (!btn.disabled) btn.click();   // a disabled close control means closing is not allowed right now
    return;
  }
  el.click();                         // backdrop click (most popups close on it)
  if (isOpen(el) && el.matches(".ad-sheet-bd, .cr-panel")) el.remove();
}

function trap(e, entry) {
  const items = focusables(entry.el), a = document.activeElement;
  if (!items.length) { e.preventDefault(); entry.el.focus({ preventScroll: true }); return; }
  const first = items[0], last = items[items.length - 1];
  if (!entry.el.contains(a) || a === entry.el) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}

function onKey(e) {
  if (e.defaultPrevented || e.isComposing || !stack.length) return;
  if (e.key !== "Escape" && e.key !== "Tab") return;
  scan();                                   // be sure the stack matches the screen before acting on it
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === "Tab") { if (top.modal) trap(e, top); return; }
  const mode = top.el.dataset.esc;
  if (mode === "own" || mode === "none") return;
  e.preventDefault();
  closeLayer(top);
}

export function installLayers() {
  if (window.__wsLayers) return;
  window.__wsLayers = true;
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", (e) => { lastPointer = e.target instanceof Element ? e.target : null; }, true);
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden"] });
  schedule();
}
installLayers();
