// Shared "triangle dropdown" behavior for the page header on Profile,
// Clients, and Dials. Tapping the triangle button flips it to point down and
// reveals a menu of page-specific options below it (contents differ per
// page — wired up in each page's own js file). Tapping the triangle again,
// or anywhere outside the menu, closes it.
//
// Only one of these menus is ever open at a time (there's only one per
// page), so this module just tracks that single open state at module scope.

let openState = null; // { toggleBtn, menuEl, extraCloseEl }

// Normalizes extraCloseEl to an array — callers may pass a single element
// (original API, still used by Dials' lone Categories submenu) or an array
// of elements (Clients now has both a Categories AND a Progress submenu that
// need the same "close me when the main menu closes / don't count clicks
// inside me as outside" treatment — see clients.js).
function asExtraCloseEls(extraCloseEl) {
  if (!extraCloseEl) return [];
  return Array.isArray(extraCloseEl) ? extraCloseEl : [extraCloseEl];
}

function onOutsideClick(e) {
  if (!openState) return;
  const { toggleBtn, menuEl, extraCloseEl } = openState;
  if (menuEl.contains(e.target) || toggleBtn.contains(e.target) || asExtraCloseEls(extraCloseEl).some((el) => el.contains(e.target))) {
    return;
  }
  closeAllPageHeaderMenus();
}

/**
 * Wires the triangle toggle button for a page header.
 * @param {Object} opts
 * @param {HTMLElement} opts.toggleBtn - the triangle button.
 * @param {HTMLElement} opts.menuEl - the dropdown menu it reveals.
 * @param {HTMLElement|HTMLElement[]} [opts.extraCloseEl] - one or more
 *   additional elements (e.g. submenus positioned elsewhere in the DOM) that
 *   should also be hidden whenever this menu closes, and that clicks inside
 *   should NOT count as "outside" clicks.
 */
export function wirePageHeaderMenu({ toggleBtn, menuEl, extraCloseEl }) {
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = menuEl.classList.contains("hidden");
    closeAllPageHeaderMenus();
    if (opening) {
      menuEl.classList.remove("hidden");
      toggleBtn.classList.add("open");
      openState = { toggleBtn, menuEl, extraCloseEl };
      document.addEventListener("click", onOutsideClick);
    }
  });
}

export function closeAllPageHeaderMenus() {
  if (openState) {
    openState.menuEl.classList.add("hidden");
    openState.toggleBtn.classList.remove("open");
    asExtraCloseEls(openState.extraCloseEl).forEach((el) => el.classList.add("hidden"));
  }
  openState = null;
  document.removeEventListener("click", onOutsideClick);
}
