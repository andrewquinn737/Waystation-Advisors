// Shared "Sellers / Buyers / Brokers" data-side picker — exposed from the
// settings gear icon (top right) on Clients, Dials and Profile. Buyer-side
// data is a fully separate parallel dataset from seller-side data (see the
// clients.client_type / dial_lists.dial_type columns in supabase/schema.sql,
// which have existed since the original design — see the "ADMIN-ONLY
// SELLERS/BUYERS TOGGLE" comment there). This module just tracks + persists
// which side is currently being viewed/created into, and wires the button in
// each page's settings dropdown — which now opens a small popup to choose
// from (it used to flip between two sides on every tap).
//
// "Brokers" is a third kind of CLIENT (admin-only, Clients page only —
// dials and call stats have no broker side). So there are two readers:
//  - getClientSide(): seller | buyer | broker — used by the Clients page.
//  - getDealSide():   seller | buyer — everywhere else (Dials, Profile). A
//    stored "broker" reads as "seller" there, without losing the stored pick
//    for when the admin is back on Clients.
//
// Only admins/team leads can ever switch sides — interns never see the
// control at all (the caller only invokes wireDealSideToggle for them; see
// js/clients.js / js/dials.js), so both readers always resolve to "seller"
// for them regardless of whatever an admin last picked on their own browser
// (this is deliberately per-browser/localStorage, not a shared server-side
// setting). Only admins are offered Brokers (allowBroker below).
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { closeAllPageHeaderMenus } from "./pageHeaderMenu.js";

const KEY = "waystation_deal_side";

const SIDE_LABELS = { seller: "Sellers", buyer: "Buyers", broker: "Brokers" };

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === "buyer" || v === "broker" ? v : "seller";
  } catch {
    return "seller";
  }
}

// Brokers are admin-only. The Clients page calls allowBrokerSide(isAdmin)
// once at load; until then (and for every other role) a stored "broker" pick
// — e.g. left behind by an admin on the same browser — reads as "seller".
let brokerAllowed = false;
export function allowBrokerSide(flag) {
  brokerAllowed = !!flag;
}

export function getClientSide() {
  const v = stored();
  return v === "broker" && !brokerAllowed ? "seller" : v;
}

export function getDealSide() {
  return stored() === "buyer" ? "buyer" : "seller";
}

function setSide(v) {
  try {
    localStorage.setItem(KEY, v === "buyer" || v === "broker" ? v : "seller");
  } catch {
    // ignore (private browsing / storage disabled)
  }
}

let popupEl = null;

function ensurePopup() {
  if (popupEl) return;
  popupEl = document.createElement("div");
  popupEl.className = "modal-backdrop hidden";
  popupEl.id = "dealSidePopup";
  popupEl.innerHTML = `
    <div class="modal">
      <h2>Viewing</h2>
      <div class="advanced-settings-list" id="dealSideOptions"></div>
      <div class="form-actions">
        <button type="button" class="btn secondary" id="dealSidePopupClose">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(popupEl);
  popupEl.addEventListener("click", (e) => {
    if (e.target === popupEl) closePopup();
  });
  popupEl.querySelector("#dealSidePopupClose").addEventListener("click", closePopup);
}

function closePopup() {
  popupEl.classList.add("hidden");
  unlockPageScroll();
}

// toggleBtn: the settings-menu button that shows the current side's name and
// opens the picker when clicked.
// labelEl: the <span> inside it whose text gets updated to match.
// onChange: called (no args) right after a DIFFERENT side is picked, so the
//   caller can re-load + re-render whichever list it's showing.
// opts.allowBroker: offer the Brokers option (admins on the Clients page).
export function wireDealSideToggle(toggleBtn, labelEl, onChange, { allowBroker = false } = {}) {
  if (allowBroker) allowBrokerSide(true);
  const current = () => (allowBroker ? getClientSide() : getDealSide());
  const render = () => {
    labelEl.textContent = SIDE_LABELS[current()];
  };
  render();
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllPageHeaderMenus();
    ensurePopup();
    const sides = allowBroker ? ["seller", "buyer", "broker"] : ["seller", "buyer"];
    const optionsEl = popupEl.querySelector("#dealSideOptions");
    optionsEl.innerHTML = sides
      .map(
        (s) => `
      <button type="button" class="advanced-settings-row viewing-option ${s === current() ? "active" : ""}" data-side="${s}">
        <span class="advanced-settings-row-label">${SIDE_LABELS[s]}</span><span class="viewing-check">&#10003;</span>
      </button>`
      )
      .join("");
    optionsEl.querySelectorAll("[data-side]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = btn.dataset.side;
        const changed = next !== current();
        closePopup();
        if (changed) {
          setSide(next);
          render();
          onChange();
        }
      });
    });
    popupEl.classList.remove("hidden");
    lockPageScroll();
  });
}
