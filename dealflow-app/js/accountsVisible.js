// Shared admin-only "Accounts visible" selection — ONE cross-page setting
// now (Clients, Dials, and Profile all read/write the same value), replacing
// what used to be two separate per-page selections. null = every account
// ("Select all"); otherwise a Set of profile ids to show. Mirrors
// js/dealSide.js's shared-localStorage-key pattern.
//
// The very first time this is ever touched (tracked separately by INIT_KEY,
// since "Select all" is itself stored as an absent KEY — see persist() —
// which would otherwise be indistinguishable from "never touched"), it
// defaults to "just me" instead of "Select all" — see initDefaultToSelf().
// Every launch/page load after that first initialization leaves whatever was
// last explicitly chosen alone, including an explicit "Select all".

const KEY = "waystation_visible_accounts";
const INIT_KEY = "waystation_visible_accounts_initialized";

let visibleAccountIds = null;
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr)) visibleAccountIds = new Set(arr);
    }
  } catch {
    // ignore (private browsing / storage disabled)
  }
}

function persist() {
  try {
    if (visibleAccountIds === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify([...visibleAccountIds]));
    localStorage.setItem(INIT_KEY, "1");
  } catch {
    // ignore
  }
}

// Call once per page, right after the signed-in profile is known (see
// clients.js/dials.js/profile.js) — a no-op every time except the very first
// time this shared setting is ever touched across the whole app, when it
// narrows the default down to just the signed-in account instead of
// everyone.
export function initDefaultToSelf(myProfileId) {
  load();
  try {
    if (localStorage.getItem(INIT_KEY)) return;
  } catch {
    return;
  }
  visibleAccountIds = new Set([myProfileId]);
  persist();
}

// null = no filter (every account passes).
export function getVisibleAccountIds() {
  load();
  return visibleAccountIds;
}

export function isAccountVisible(id) {
  load();
  return !visibleAccountIds || visibleAccountIds.has(id);
}

// Wires the shared "Accounts visible" popup for whichever page calls this.
// opts:
//   menuBtn, popupEl, bodyEl, closeBtn - the page's own elements (each page
//     has its own popup markup, all following the same shell/classes).
//   closePageHeaderMenu - optional, closes whatever triangle/gear menu is
//     currently open before showing the popup (see js/pageHeaderMenu.js).
//   myProfileId - the signed-in profile's id, so their own row reads "(you)".
//   getAllAccounts - async () => [{id, full_name}], called once the first
//     time the popup is opened on this page load.
//   onChange - called after every change (Select all, or an individual
//     toggle) so the calling page can re-run its own filtered render.
//   escapeHtml - the caller's own escapeHtml helper (kept a plain param so
//     this module doesn't need its own copy or a shared import for it).
export function wireAccountsVisiblePopup({ menuBtn, popupEl, bodyEl, closeBtn, closePageHeaderMenu, myProfileId, getAllAccounts, onChange, escapeHtml }) {
  let allAccounts = [];
  let accountsLoaded = false;

  function render() {
    load();
    const allSelected = !visibleAccountIds;
    const rowsHTML = allAccounts.length
      ? allAccounts
          .map(
            (a) => `
          <button type="button" class="accounts-visible-row" data-id="${a.id}">
            <input type="checkbox" ${isAccountVisible(a.id) ? "checked" : ""} tabindex="-1" />
            ${escapeHtml(a.full_name)}${a.id === myProfileId ? " (you)" : ""}
          </button>`
          )
          .join("")
      : `<div class="accounts-visible-empty">No accounts found.</div>`;

    bodyEl.innerHTML = `
      <div class="accounts-visible-list">
        <button type="button" class="accounts-visible-row select-all" id="accountsSelectAllBtn">
          <input type="checkbox" ${allSelected ? "checked" : ""} tabindex="-1" />
          Select all
        </button>
        ${rowsHTML}
      </div>
    `;

    bodyEl.querySelector("#accountsSelectAllBtn").addEventListener("click", () => {
      visibleAccountIds = null;
      persist();
      render();
      onChange();
    });
    bodyEl.querySelectorAll(".accounts-visible-row[data-id]").forEach((row) => {
      row.addEventListener("click", () => {
        const id = row.dataset.id;
        // Narrowing down from "all" for the first time starts from the full
        // set of accounts (everything stays visible except the one just
        // unchecked), rather than jumping straight to "only this one".
        if (visibleAccountIds === null) visibleAccountIds = new Set(allAccounts.map((a) => a.id));
        if (visibleAccountIds.has(id)) visibleAccountIds.delete(id);
        else visibleAccountIds.add(id);
        persist();
        render();
        onChange();
      });
    });
  }

  menuBtn.addEventListener("click", async () => {
    if (closePageHeaderMenu) closePageHeaderMenu();
    popupEl.classList.remove("hidden");
    bodyEl.innerHTML = `<div class="accounts-visible-empty">Loading…</div>`;
    if (!accountsLoaded) {
      allAccounts = await getAllAccounts();
      accountsLoaded = true;
    }
    render();
  });
  closeBtn.addEventListener("click", () => popupEl.classList.add("hidden"));
}
