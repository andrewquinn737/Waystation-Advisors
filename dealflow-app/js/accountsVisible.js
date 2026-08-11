// Shared admin-only "Accounts visible" selection — ONE cross-page setting
// now (Clients, Dials, and Profile all read/write the same value), replacing
// what used to be two separate per-page selections. null = every account
// ("Select all"); otherwise a Set of profile ids to show. Mirrors
// js/dealSide.js's shared-localStorage-key pattern.
//
// The very first time this is ever touched (tracked separately by an
// "initialized" key, since "Select all" is itself stored as an absent KEY —
// see persist() — which would otherwise be indistinguishable from "never
// touched"), it defaults to "just me" instead of "Select all" — see
// initDefaultToSelf(). Every launch/page load after that first
// initialization leaves whatever was last explicitly chosen alone, including
// an explicit "Select all".
//
// Every exported function takes an optional storageKey, defaulting to the
// original shared key above — every existing caller (Profile/Clients/Dials)
// passes none and keeps today's exact behavior untouched. This exists so the
// Reports popup can have its own independent selection (a different
// storageKey) instead of sharing state with the app-wide "Accounts visible"
// setting everywhere else.

const KEY = "waystation_visible_accounts";
const INIT_KEY = "waystation_visible_accounts_initialized";

// Virtual group keys for admin-only team grouping (see wireAccountsVisiblePopup's
// getTeams option) — mirrors js/profile.js's Teams popup grouping (ADMINS_KEY/
// UNASSIGNED_KEY there) without importing from it, matching this app's existing
// pattern of small duplication over cross-module imports.
const ADMIN_GROUP_KEY = "__admins__";
const UNASSIGNED_GROUP_KEY = "__unassigned__";

// Per-storageKey state, so more than one independent instance can be wired
// up at once within the same page (e.g. Profile's own global picker AND the
// Reports popup's separately-scoped one).
const state = new Map(); // storageKey -> { visibleAccountIds, loaded }

function stateFor(storageKey) {
  let s = state.get(storageKey);
  if (!s) {
    s = { visibleAccountIds: null, loaded: false };
    state.set(storageKey, s);
  }
  return s;
}

function load(storageKey) {
  const s = stateFor(storageKey);
  if (s.loaded) return;
  s.loaded = true;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr)) s.visibleAccountIds = new Set(arr);
    }
  } catch {
    // ignore (private browsing / storage disabled)
  }
}

function persist(storageKey, initKey) {
  const s = stateFor(storageKey);
  try {
    if (s.visibleAccountIds === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify([...s.visibleAccountIds]));
    localStorage.setItem(initKey, "1");
  } catch {
    // ignore
  }
}

// Call once per page, right after the signed-in profile is known (see
// clients.js/dials.js/profile.js) — a no-op every time except the very first
// time this shared setting is ever touched across the whole app, when it
// narrows the default down to just the signed-in account instead of
// everyone.
export function initDefaultToSelf(myProfileId, storageKey = KEY) {
  const initKey = storageKey === KEY ? INIT_KEY : `${storageKey}_initialized`;
  const s = stateFor(storageKey);
  load(storageKey);
  try {
    if (localStorage.getItem(initKey)) {
      // Already initialized before — but as a safety net, if the persisted
      // state resolves to zero visible accounts (e.g. the tab was closed or
      // navigated away from mid-selection before the "at least one" guard in
      // wireAccountsVisiblePopup could catch it), fall back to "just me"
      // rather than leaving every page showing nothing on open.
      if (s.visibleAccountIds && s.visibleAccountIds.size === 0) {
        s.visibleAccountIds = new Set([myProfileId]);
        persist(storageKey, initKey);
      }
      return;
    }
  } catch {
    return;
  }
  s.visibleAccountIds = new Set([myProfileId]);
  persist(storageKey, initKey);
}

// null = no filter (every account passes).
export function getVisibleAccountIds(storageKey = KEY) {
  load(storageKey);
  return stateFor(storageKey).visibleAccountIds;
}

export function isAccountVisible(id, storageKey = KEY) {
  load(storageKey);
  const s = stateFor(storageKey);
  return !s.visibleAccountIds || s.visibleAccountIds.has(id);
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
//   storageKey - optional, defaults to the shared app-wide key. Pass a
//     distinct value to give this instance its own independent selection,
//     persisted and read separately from every other instance.
//   getTeams - optional async () => [{id, name}], sorted in display order.
//     When provided, the account list is grouped under section labels the
//     same way the Teams popup groups members — Admins first (accounts with
//     role "admin"), then each real team in order, then "Unassigned interns"
//     last for anyone whose team_id is null or points at a deleted team.
//     Requires each account object from getAllAccounts to also carry `role`/
//     `team_id` (harmless to include for callers that don't pass getTeams —
//     they're simply ignored). Omit entirely to keep today's flat list (e.g.
//     for a team lead, whose own pool is already small enough not to need
//     grouping).
export function wireAccountsVisiblePopup({ menuBtn, popupEl, bodyEl, closeBtn, closePageHeaderMenu, myProfileId, getAllAccounts, getTeams, onChange, escapeHtml, storageKey = KEY }) {
  const initKey = storageKey === KEY ? INIT_KEY : `${storageKey}_initialized`;
  let allAccounts = [];
  let accountsLoaded = false;
  let teams = [];
  let teamsLoaded = false;

  function groupKeyFor(a) {
    if (a.role === "admin") return ADMIN_GROUP_KEY;
    if (a.team_id && teams.some((t) => t.id === a.team_id)) return a.team_id;
    return UNASSIGNED_GROUP_KEY;
  }

  function buildGroupDefs() {
    return [{ key: ADMIN_GROUP_KEY, label: "Admins" }, ...teams.map((t) => ({ key: t.id, label: t.name })), { key: UNASSIGNED_GROUP_KEY, label: "Unassigned interns" }];
  }

  // Zero accounts selected would leave every page showing nothing, so the
  // popup can't be closed in that state (see closeBtn handler below) — the
  // close button is visually disabled and a hint is shown instead.
  function hasAnySelected() {
    const s = stateFor(storageKey);
    return !s.visibleAccountIds || s.visibleAccountIds.size > 0;
  }

  function accountRowHTML(a) {
    return `
          <button type="button" class="accounts-visible-row" data-id="${a.id}">
            <input type="checkbox" ${isAccountVisible(a.id, storageKey) ? "checked" : ""} tabindex="-1" />
            ${escapeHtml(a.full_name)}${a.id === myProfileId ? " (you)" : ""}
          </button>`;
  }

  function render() {
    load(storageKey);
    const s = stateFor(storageKey);
    const allSelected = !s.visibleAccountIds;
    let rowsHTML;
    if (!allAccounts.length) {
      rowsHTML = `<div class="accounts-visible-empty">No accounts found.</div>`;
    } else if (getTeams && teams.length) {
      const byGroup = new Map();
      buildGroupDefs().forEach((g) => byGroup.set(g.key, []));
      allAccounts.forEach((a) => byGroup.get(groupKeyFor(a)).push(a));
      rowsHTML = buildGroupDefs()
        .map((g) => {
          const members = byGroup.get(g.key) || [];
          if (!members.length) return "";
          return `<div class="accounts-visible-group-label">${escapeHtml(g.label)}</div>${members.map(accountRowHTML).join("")}`;
        })
        .join("");
    } else {
      rowsHTML = allAccounts.map(accountRowHTML).join("");
    }

    const anySelected = hasAnySelected();
    bodyEl.innerHTML = `
      <div class="accounts-visible-list">
        <button type="button" class="accounts-visible-row select-all" id="accountsSelectAllBtn">
          <input type="checkbox" ${allSelected ? "checked" : ""} tabindex="-1" />
          Select all
        </button>
        ${rowsHTML}
      </div>
      ${anySelected ? "" : `<div class="accounts-visible-warning">Select at least one account to continue.</div>`}
    `;

    closeBtn.disabled = !anySelected;
    closeBtn.classList.toggle("disabled", !anySelected);

    bodyEl.querySelector("#accountsSelectAllBtn").addEventListener("click", (e) => {
      // render() below replaces bodyEl's innerHTML synchronously, which
      // detaches e.target from the DOM before this click finishes bubbling
      // up to document — pageHeaderMenu.js's outside-click listener then
      // sees a detached target, misreads it as "outside," and closes the
      // whole dropdown (and this popup along with it, since callers like
      // Reports register it as an extraCloseEl). Stopping propagation here
      // keeps the click from ever reaching that listener.
      e.stopPropagation();
      // If everything is currently selected, clicking again clears the
      // selection entirely instead of being a no-op; otherwise (partial or
      // empty selection) it selects everyone, same as before.
      s.visibleAccountIds = s.visibleAccountIds === null ? new Set() : null;
      persist(storageKey, initKey);
      render();
      onChange();
    });
    bodyEl.querySelectorAll(".accounts-visible-row[data-id]").forEach((row) => {
      row.addEventListener("click", (e) => {
        e.stopPropagation(); // see the comment on #accountsSelectAllBtn's handler above
        const id = row.dataset.id;
        // Narrowing down from "all" for the first time starts from the full
        // set of accounts (everything stays visible except the one just
        // unchecked), rather than jumping straight to "only this one".
        if (s.visibleAccountIds === null) s.visibleAccountIds = new Set(allAccounts.map((a) => a.id));
        if (s.visibleAccountIds.has(id)) s.visibleAccountIds.delete(id);
        else s.visibleAccountIds.add(id);
        persist(storageKey, initKey);
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
    if (getTeams && !teamsLoaded) {
      teams = await getTeams();
      teamsLoaded = true;
    }
    render();
  });
  closeBtn.addEventListener("click", () => {
    if (!hasAnySelected()) return; // guarded — see render()
    popupEl.classList.add("hidden");
  });
}
