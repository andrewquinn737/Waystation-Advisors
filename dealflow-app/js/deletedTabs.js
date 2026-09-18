// "Deleted tabs" popup on the Profile page (admin-only — the menu button
// starts hidden in profile.html and profile.js only unhides/wires it for
// admins). Deleting a dial tab on the Dials page is a soft delete
// (trash_dial_list RPC → dial_lists.deleted_at), so the tab and every dial in
// it land here instead of vanishing:
//
//  - List view: one row per deleted tab, with its buyer attachment and last
//    account owner under the title (get_deleted_dial_lists RPC).
//  - Tap a row: detail view listing every dial in that tab, plus Back.
//  - Select (header button): pick tabs, then Restore (back to the last owner),
//    Reassign (restore under a different account — the tab's dials move with
//    it), or Delete (permanent, dials included — purge_dial_lists RPC).
//
// Non-admins can't see trashed tabs at all (dial_lists RLS), and the three
// write RPCs are admin-only server-side too, so this is UI gating on top of
// real enforcement, not instead of it.

import { supabase } from "./supabaseClient.js";
import { showError } from "./auth.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

// Same status → tint mapping the Dials page rows use (CONTACT_STATUSES in
// js/dials.js), via the shared CSS variables.
const STATUS_TINTS = {
  uncontacted: { bg: "var(--status-uncontacted-bg)", border: "var(--status-uncontacted-border)" },
  unable_to_contact: { bg: "var(--status-unable-bg)", border: "var(--status-unable-border)" },
  not_interested: { bg: "var(--status-not-interested-bg)", border: "var(--status-not-interested-border)" },
  no_response: { bg: "var(--status-no-response-bg)", border: "var(--status-no-response-border)" },
  callback_interested: { bg: "var(--status-callback-bg)", border: "var(--status-callback-border)" },
  intro_call_scheduled: { bg: "var(--status-scheduled-bg)", border: "var(--status-scheduled-border)" },
};

const DIAL_PAGE_SIZE = 1000;

export function wireDeletedTabsPopup({ menuBtn, closePageHeaderMenu, escapeHtml }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    modal: $("deletedTabsModal"),
    title: $("deletedTabsTitle"),
    subtitle: $("deletedTabsSubtitle"),
    backBtn: $("deletedTabsBackBtn"),
    selectBtn: $("deletedTabsSelectBtn"),
    closeBtn: $("deletedTabsCloseBtn"),
    errorBox: $("deletedTabsErrorBox"),
    selectBar: $("deletedTabsSelectBar"),
    exitSelectBtn: $("deletedTabsExitSelectBtn"),
    selectAllBtn: $("deletedTabsSelectAllBtn"),
    restoreBtn: $("deletedTabsRestoreBtn"),
    reassignBtn: $("deletedTabsReassignBtn"),
    purgeBtn: $("deletedTabsPurgeBtn"),
    hint: $("deletedTabsSelectHint"),
    wrap: $("deletedTabsWrap"),
    reassignModal: $("deletedTabsReassignModal"),
    reassignHelp: $("deletedTabsReassignHelp"),
    reassignSelect: $("deletedTabsReassignSelect"),
    reassignYesBtn: $("deletedTabsReassignYesBtn"),
    reassignNoBtn: $("deletedTabsReassignNoBtn"),
    purgeModal: $("deletedTabsPurgeModal"),
    purgeTitle: $("deletedTabsPurgeTitle"),
    purgeHelp: $("deletedTabsPurgeHelp"),
    purgeYesBtn: $("deletedTabsPurgeYesBtn"),
    purgeNoBtn: $("deletedTabsPurgeNoBtn"),
  };

  let tabs = [];
  let detailTabId = null; // null = list view
  let selectMode = false;
  let selectedIds = new Set();
  let hintTimer = null;
  let loading = false;
  let loadToken = 0; // drops a stale response if the popup was closed/reopened mid-fetch

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const formatDate = (iso) =>
    new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  function buyerLabel(t) {
    if (t.dial_type === "buyer") return "Buyer-side tab (no buyer attached)";
    if (!t.buyer_id) return "No buyer attached";
    return `Buyer: ${t.buyer_name || "Unknown buyer"}`;
  }
  const ownerLabel = (t) => `Last owner: ${t.owner_name || "Unknown account"}`;

  function showTransientHint(text) {
    clearTimeout(hintTimer);
    el.hint.textContent = text;
    el.hint.classList.remove("hidden");
    hintTimer = setTimeout(() => {
      if (!selectMode) el.hint.classList.add("hidden");
    }, 4000);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function render() {
    const inDetail = detailTabId !== null;
    const detailTab = tabs.find((t) => t.id === detailTabId);
    el.backBtn.hidden = !inDetail;
    el.selectBtn.hidden = inDetail || !tabs.length || selectMode;
    el.selectBar.classList.toggle("hidden", inDetail || !selectMode);
    if (inDetail && detailTab) {
      el.title.textContent = detailTab.name;
      el.subtitle.textContent = `${buyerLabel(detailTab)} · ${ownerLabel(detailTab)}`;
      el.subtitle.classList.remove("hidden");
    } else {
      el.title.textContent = "Deleted tabs";
      el.subtitle.classList.add("hidden");
    }
    if (!inDetail) renderList();
  }

  function updateSelectionUI() {
    const n = selectedIds.size;
    el.restoreBtn.disabled = el.reassignBtn.disabled = el.purgeBtn.disabled = n === 0;
    el.selectAllBtn.textContent = tabs.length && n === tabs.length ? "Select none" : "Select all";
    if (selectMode) {
      clearTimeout(hintTimer);
      el.hint.textContent = n ? `${plural(n, "tab")} selected.` : "Tap tabs to select them.";
      el.hint.classList.remove("hidden");
    }
  }

  function renderList() {
    if (loading) {
      el.wrap.innerHTML = `<div class="empty-state">Loading…</div>`;
      return;
    }
    if (!tabs.length) {
      el.wrap.innerHTML = `<div class="empty-state">No deleted tabs.</div>`;
      return;
    }
    el.wrap.innerHTML = `<div class="team-member-list">${tabs
      .map(
        (t) => `
      <div class="mobile-card deleted-tab-row" data-id="${escapeHtml(t.id)}">
        <div class="mc-main">
          <div class="mc-name">${escapeHtml(t.name)}</div>
          <div class="mc-sub">${escapeHtml(buyerLabel(t))}</div>
          <div class="mc-sub">${escapeHtml(ownerLabel(t))}</div>
          <div class="mc-sub faint">Deleted ${escapeHtml(formatDate(t.deleted_at))}${t.deleted_by_name ? ` by ${escapeHtml(t.deleted_by_name)}` : ""} · ${escapeHtml(plural(Number(t.dial_count), "dial"))}</div>
        </div>
        ${selectMode ? `<div class="select-circle ${selectedIds.has(t.id) ? "selected" : ""}"></div>` : ""}
      </div>`
      )
      .join("")}</div>`;
    el.wrap.querySelectorAll(".deleted-tab-row").forEach((row) => {
      row.addEventListener("click", () => {
        const id = row.dataset.id;
        if (selectMode) {
          if (selectedIds.has(id)) selectedIds.delete(id);
          else selectedIds.add(id);
          renderList();
          updateSelectionUI();
          return;
        }
        openDetail(id);
      });
    });
    updateSelectionUI();
  }

  async function openDetail(tabId) {
    detailTabId = tabId;
    el.errorBox.classList.add("hidden");
    el.hint.classList.add("hidden");
    el.wrap.innerHTML = `<div class="empty-state">Loading…</div>`;
    render();
    const token = ++loadToken;
    const dials = [];
    for (let from = 0; ; from += DIAL_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("dials")
        .select("id, full_name, company_name, city, state, mobile_phone, company_phone, contact_status")
        .eq("list_id", tabId)
        .order("full_name", { ascending: true })
        .range(from, from + DIAL_PAGE_SIZE - 1);
      if (token !== loadToken || detailTabId !== tabId) return;
      if (error) {
        el.wrap.innerHTML = "";
        return showError(el.errorBox, error);
      }
      dials.push(...(data || []));
      if ((data || []).length < DIAL_PAGE_SIZE) break;
    }
    if (!dials.length) {
      el.wrap.innerHTML = `<div class="empty-state">This tab has no dials.</div>`;
      return;
    }
    el.wrap.innerHTML = `<div class="team-member-list">${dials
      .map((d) => {
        const tint = STATUS_TINTS[d.contact_status] || STATUS_TINTS.uncontacted;
        const sub = [d.company_name, [d.city, d.state].filter(Boolean).join(", ")].filter(Boolean).join(", ");
        const phone = d.mobile_phone || d.company_phone || "";
        return `
      <div class="mobile-card" style="background:${tint.bg}; border-color:${tint.border};">
        <div class="mc-main">
          <div class="mc-name">${escapeHtml(d.full_name || "Unnamed dial")}</div>
          <div class="mc-sub">${escapeHtml(sub || "—")}</div>
        </div>
        ${phone ? `<div class="mc-sub">${escapeHtml(phone)}</div>` : ""}
      </div>`;
      })
      .join("")}</div>`;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async function loadTabs() {
    el.errorBox.classList.add("hidden");
    const token = ++loadToken;
    const { data, error } = await supabase.rpc("get_deleted_dial_lists");
    if (token !== loadToken) return;
    loading = false;
    if (error) {
      tabs = [];
      el.wrap.innerHTML = "";
      showError(el.errorBox, error);
      return render();
    }
    tabs = data || [];
    // Anything selected that no longer exists (restored/purged elsewhere) drops out.
    selectedIds = new Set([...selectedIds].filter((id) => tabs.some((t) => t.id === id)));
    if (!tabs.length) selectMode = false;
    render();
  }

  // -------------------------------------------------------------------------
  // Select mode + actions
  // -------------------------------------------------------------------------

  function setSelectMode(on) {
    selectMode = on;
    selectedIds.clear();
    if (!on) el.hint.classList.add("hidden");
    render();
    if (on) updateSelectionUI();
  }

  el.selectBtn.addEventListener("click", () => setSelectMode(true));
  el.exitSelectBtn.addEventListener("click", () => setSelectMode(false));
  el.selectAllBtn.addEventListener("click", () => {
    if (selectedIds.size === tabs.length) selectedIds.clear();
    else selectedIds = new Set(tabs.map((t) => t.id));
    renderList();
  });

  const selectedTabs = () => tabs.filter((t) => selectedIds.has(t.id));

  async function runAction(rpcName, args, doneText) {
    el.errorBox.classList.add("hidden");
    const { data, error } = await supabase.rpc(rpcName, args);
    if (error) return showError(el.errorBox, error);
    selectMode = false;
    selectedIds.clear();
    await loadTabs();
    showTransientHint(`${doneText(Number(data) || 0)}`);
  }

  el.restoreBtn.addEventListener("click", () => {
    if (!selectedIds.size) return;
    runAction("restore_dial_lists", { p_list_ids: [...selectedIds] }, (n) => `Restored ${plural(n, "tab")} to ${n === 1 ? "its" : "their"} last owner${n === 1 ? "" : "s"}.`);
  });

  // Reassign = restore under a different account. The account list is only
  // fetched when the picker opens (profiles is readable by every signed-in
  // user; admins see everyone).
  el.reassignBtn.addEventListener("click", async () => {
    if (!selectedIds.size) return;
    el.reassignHelp.textContent = `${plural(selectedIds.size, "tab")} will be restored to the account you pick, with all of their dials.`;
    el.reassignSelect.innerHTML = `<option value="">Loading…</option>`;
    el.reassignYesBtn.disabled = true;
    el.reassignModal.classList.remove("hidden");
    const { data, error } = await supabase.from("profiles").select("id, full_name, role").order("full_name", { ascending: true });
    if (error) {
      el.reassignModal.classList.add("hidden");
      return showError(el.errorBox, error);
    }
    const roleLabel = { admin: "Admin", team_lead: "Team lead", intern: "Intern" };
    el.reassignSelect.innerHTML =
      `<option value="">Choose an account…</option>` +
      (data || [])
        .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.full_name || "Unnamed")} (${roleLabel[p.role] || p.role})</option>`)
        .join("");
    // Restore stays disabled until an account is actually picked.
  });
  el.reassignSelect.addEventListener("change", () => {
    el.reassignYesBtn.disabled = !el.reassignSelect.value;
  });
  el.reassignNoBtn.addEventListener("click", () => el.reassignModal.classList.add("hidden"));
  el.reassignYesBtn.addEventListener("click", async () => {
    const owner = el.reassignSelect.value;
    if (!owner) return;
    el.reassignModal.classList.add("hidden");
    const ownerName = el.reassignSelect.selectedOptions[0].textContent.replace(/ \([^)]*\)$/, "");
    await runAction("restore_dial_lists", { p_list_ids: [...selectedIds], p_new_owner: owner }, (n) => `Restored ${plural(n, "tab")} to ${ownerName}.`);
  });

  el.purgeBtn.addEventListener("click", () => {
    if (!selectedIds.size) return;
    const chosen = selectedTabs();
    const dialTotal = chosen.reduce((sum, t) => sum + Number(t.dial_count), 0);
    el.purgeTitle.textContent = chosen.length === 1 ? "Permanently delete this tab?" : `Permanently delete ${chosen.length} tabs?`;
    el.purgeHelp.textContent = `This permanently deletes ${plural(chosen.length, "tab")} and the ${plural(dialTotal, "dial")} in ${chosen.length === 1 ? "it" : "them"}. This cannot be undone.`;
    el.purgeModal.classList.remove("hidden");
  });
  el.purgeNoBtn.addEventListener("click", () => el.purgeModal.classList.add("hidden"));
  el.purgeYesBtn.addEventListener("click", async () => {
    el.purgeModal.classList.add("hidden");
    await runAction("purge_dial_lists", { p_list_ids: [...selectedIds] }, (n) => `Permanently deleted ${plural(n, "tab")}.`);
  });

  // -------------------------------------------------------------------------
  // Open / close / back
  // -------------------------------------------------------------------------

  el.backBtn.addEventListener("click", () => {
    detailTabId = null;
    loadToken++; // cancels any in-flight dial fetch
    el.errorBox.classList.add("hidden");
    render();
  });

  menuBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    closePageHeaderMenu();
    detailTabId = null;
    selectMode = false;
    selectedIds.clear();
    el.hint.classList.add("hidden");
    loading = true;
    render();
    el.modal.classList.remove("hidden");
    lockPageScroll();
    await loadTabs();
  });

  el.closeBtn.addEventListener("click", () => {
    loadToken++;
    el.modal.classList.add("hidden");
    el.reassignModal.classList.add("hidden");
    el.purgeModal.classList.add("hidden");
    unlockPageScroll();
  });
}
