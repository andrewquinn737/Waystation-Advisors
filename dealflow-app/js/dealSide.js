// Shared "Sellers / Buyers" admin-only data-side toggle — exposed from the
// settings gear icon (top right) on both Clients and Dials. Buyer-side data
// is a fully separate parallel dataset from seller-side data (see the
// clients.client_type / dial_lists.dial_type columns in supabase/schema.sql,
// which have existed since the original design — see the "ADMIN-ONLY
// SELLERS/BUYERS TOGGLE" comment there). This module just tracks + persists
// which side is currently being viewed/created into, and wires the toggle
// button in each page's settings dropdown.
//
// Only admins can ever switch to Buyers — interns never see the toggle at
// all (the caller only invokes wireDealSideToggle when isAdmin is true; see
// js/clients.js / js/dials.js), so getDealSide() always resolves to "seller"
// for them regardless of whatever an admin last picked on their own browser
// (this is deliberately per-browser/localStorage, not a shared server-side
// setting).
const KEY = "waystation_deal_side";

export function getDealSide() {
  return localStorage.getItem(KEY) === "buyer" ? "buyer" : "seller";
}

function setDealSide(v) {
  try {
    localStorage.setItem(KEY, v === "buyer" ? "buyer" : "seller");
  } catch {
    // ignore (private browsing / storage disabled)
  }
}

// toggleBtn: the settings-menu button that shows "Sellers"/"Buyers" and
// flips between the two when clicked.
// labelEl: the <span> inside it whose text gets updated to match.
// onChange: called (no args) right after the stored side flips, so the
// caller can re-load + re-render whichever list it's showing.
export function wireDealSideToggle(toggleBtn, labelEl, onChange) {
  const render = () => {
    labelEl.textContent = getDealSide() === "buyer" ? "Buyers" : "Sellers";
  };
  render();
  toggleBtn.addEventListener("click", () => {
    setDealSide(getDealSide() === "buyer" ? "seller" : "buyer");
    render();
    onChange();
  });
}
