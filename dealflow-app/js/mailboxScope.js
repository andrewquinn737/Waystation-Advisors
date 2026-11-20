// Mailbox scope for the Messages page: which mailboxes the signed-in user can see (their own, their interns' for a
// team lead, everyone's for an admin), how they are grouped in the picker, per-mailbox unread counts, sequence
// badges and daily send quota. Everything here is one-query-per-concern (never per row / per mailbox).
import { supabase } from "./supabaseClient.js";
import { getVisibleAccountIds, setVisibleAccountIds, isVisibleSelectionInitialized } from "./accountsVisible.js";

export const MAILBOX_KEY = "waystation_messages_mailboxes_v2";
const COLS = "id, owner_id, label, email_address, imap_host, smtp_host, sync_enabled, last_synced_at, last_sync_error, daily_send_limit, mandate, needs_assignment, send_paused_reason";

const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";
export const ownerFirstName = (a) => firstName(a.ownerName) || "someone";

// Mailboxes visible to this user (RLS-scoped). An intern also gets read access to their lead's mailboxes (for quick
// send), which are NOT theirs to browse here, so interns are restricted to the mailboxes they own.
export async function loadMailboxes(profile, { isAdmin, isTeamLead }) {
  let q = supabase.from("email_accounts").select(COLS).order("email_address").range(0, 999);
  if (!isAdmin && !isTeamLead) q = q.eq("owner_id", profile.id);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  const otherOwners = [...new Set(rows.map((a) => a.owner_id).filter((id) => id !== profile.id))];
  let names = { [profile.id]: profile.full_name };
  for (let i = 0; i < otherOwners.length; i += 100) {
    const { data: owners } = await supabase.from("profiles").select("id, full_name").in("id", otherOwners.slice(i, i + 100));
    for (const p of owners || []) names[p.id] = p.full_name;
  }
  return rows.map((a) => ({ ...a, mine: a.owner_id === profile.id, ownerName: names[a.owner_id] || "Unknown" }));
}

// Groups: "My mailboxes", one per other owner ("Caleb Hong – 5 mailboxes"), and (admin) "Unassigned".
export function buildGroups(accounts, { isAdmin }) {
  const unassigned = [];
  const mine = [];
  const byOwner = new Map();
  for (const a of accounts) {
    if (isAdmin && a.needs_assignment) unassigned.push(a);
    else if (a.mine) mine.push(a);
    else {
      if (!byOwner.has(a.owner_id)) byOwner.set(a.owner_id, []);
      byOwner.get(a.owner_id).push(a);
    }
  }
  const plural = (n) => `${n} mailbox${n === 1 ? "" : "es"}`;
  const groups = [];
  if (mine.length) groups.push({ key: "__mine__", label: "My mailboxes", accounts: mine, open: true });
  [...byOwner.values()]
    .sort((x, y) => x[0].ownerName.localeCompare(y[0].ownerName))
    .forEach((list) => groups.push({ key: `o:${list[0].owner_id}`, label: `${list[0].ownerName} – ${plural(list.length)}`, accounts: list, open: false }));
  if (unassigned.length) groups.push({ key: "__unassigned__", label: `Unassigned – ${plural(unassigned.length)}`, accounts: unassigned, open: false });
  return groups;
}

// Selected mailbox ids, always a subset of `accounts`. First visit (or a stale/empty saved selection) defaults to
// "all of mine"; a lead/admin who owns none starts with everything they can see.
export function selectedMailboxIds(accounts) {
  const valid = new Set(accounts.map((a) => a.id));
  const saved = getVisibleAccountIds(MAILBOX_KEY);
  let ids = saved && isVisibleSelectionInitialized(MAILBOX_KEY) ? [...saved].filter((id) => valid.has(id)) : [];
  if (!ids.length) {
    const mine = accounts.filter((a) => a.mine).map((a) => a.id);
    ids = mine.length ? mine : accounts.map((a) => a.id);
    setVisibleAccountIds(ids, MAILBOX_KEY);
  }
  return ids;
}

// One query: unread inbound counts for the given mailboxes -> Map(account_id -> n).
export async function loadUnreadCounts(accountIds) {
  const counts = new Map();
  if (!accountIds.length) return counts;
  const { data } = await supabase.from("email_messages").select("account_id").eq("direction", "inbound").eq("is_read", false).in("account_id", accountIds).limit(5000);
  for (const r of data || []) counts.set(r.account_id, (counts.get(r.account_id) || 0) + 1);
  return counts;
}

// Sequence badges for a set of counterpart addresses: Map(lowercase address -> { label, replied }).
export async function loadSequenceBadges(addresses) {
  const out = new Map();
  const addrs = [...new Set(addresses.map((a) => String(a || "").toLowerCase()).filter(Boolean))];
  for (let i = 0; i < addrs.length; i += 80) {
    const { data } = await supabase.from("dials").select("email, seq_state").in("email", addrs.slice(i, i + 80)).not("seq_state", "is", null);
    for (const d of data || []) {
      const k = String(d.email || "").toLowerCase();
      const prev = out.get(k);
      if (d.seq_state === "replied") out.set(k, { label: "Replied – sequence paused", replied: true });
      else if (d.seq_state === "active" && !prev) out.set(k, { label: "In sequence", replied: false });
    }
  }
  return out;
}

// Daily send quota per mailbox (rpc allows the owner or an admin). -> Map(id -> {sent, scheduled, daily_limit, left})
export async function loadQuotas(ids) {
  const out = new Map();
  await Promise.all(
    ids.map(async (id) => {
      const { data, error } = await supabase.rpc("mailbox_daily_quota", { p_account_id: id });
      const r = Array.isArray(data) ? data[0] : data;
      if (!error && r) out.set(id, { ...r, left: Math.max(0, r.daily_limit - r.sent - r.scheduled) });
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// Picker popup (reuses the accounts-visible row styles).
// ---------------------------------------------------------------------------
export function wireMailboxPicker({ menuBtn, popupEl, bodyEl, closeBtn, closePageHeaderMenu, getAccounts, getGroups, getUnread, refreshUnread, onChange, escapeHtml }) {
  const open = new Set();
  let filter = "";
  let listEl = null;
  const selected = () => new Set(selectedMailboxIds(getAccounts()));
  const badge = (n) => (n ? `<span class="mailbox-unread-badge">${n > 99 ? "99+" : n}</span>` : "");

  function renderList() {
    const sel = selected();
    const unread = getUnread();
    const f = filter.trim().toLowerCase();
    const all = getAccounts();
    const parts = [`<button type="button" class="accounts-visible-row select-all" data-act="all"><input type="checkbox" ${sel.size === all.length ? "checked" : ""} tabindex="-1" /> Select all ${badge([...unread.values()].reduce((s, n) => s + n, 0))}</button>`];
    for (const g of getGroups()) {
      const members = f ? g.accounts.filter((a) => `${a.email_address} ${a.ownerName}`.toLowerCase().includes(f)) : g.accounts;
      if (!members.length) continue;
      const isOpen = f || open.has(g.key) || (g.open && !open.has("-" + g.key));
      const gUnread = g.accounts.reduce((s, a) => s + (unread.get(a.id) || 0), 0);
      const full = g.accounts.every((a) => sel.has(a.id));
      parts.push(`<div class="accounts-visible-row accounts-visible-group-label mailbox-group-row" data-group="${escapeHtml(g.key)}">
        <input type="checkbox" data-act="group" ${full ? "checked" : ""} aria-label="Select group" />
        <button type="button" class="mailbox-group-toggle" data-act="toggle">${isOpen ? "▾" : "▸"} ${escapeHtml(g.label)}</button>${badge(gUnread)}</div>`);
      if (isOpen)
        for (const a of members)
          parts.push(`<button type="button" class="accounts-visible-row mailbox-row" data-id="${a.id}"><input type="checkbox" ${sel.has(a.id) ? "checked" : ""} tabindex="-1" /> <span class="mailbox-row-addr">${escapeHtml(a.email_address)}</span>${badge(unread.get(a.id) || 0)}</button>`);
    }
    listEl.innerHTML = parts.join("");
    const none = sel.size === 0;
    closeBtn.disabled = none;
    closeBtn.classList.toggle("disabled", none);
    bodyEl.querySelector(".accounts-visible-warning")?.classList.toggle("hidden", !none);
  }

  function renderShell() {
    const many = getAccounts().length > 12;
    bodyEl.innerHTML = `${many ? `<input type="search" class="mailbox-filter" placeholder="Filter mailboxes…" />` : ""}
      <div class="accounts-visible-list" id="mailboxPickerList"></div>
      <div class="accounts-visible-warning hidden">Select at least one mailbox to continue.</div>`;
    listEl = bodyEl.querySelector("#mailboxPickerList");
    bodyEl.querySelector(".mailbox-filter")?.addEventListener("input", (e) => {
      filter = e.target.value;
      renderList();
    });
    listEl.addEventListener("click", (e) => {
      e.stopPropagation(); // see accountsVisible.js: re-rendering detaches the target before pageHeaderMenu's outside-click check
      const el = e.target.closest("[data-act], .mailbox-row");
      if (!el) return;
      const accounts = getAccounts();
      const sel = selected();
      const act = el.dataset.act;
      if (act === "toggle") {
        const key = el.closest("[data-group]").dataset.group;
        const g = getGroups().find((x) => x.key === key);
        const isOpen = open.has(key) || (g?.open && !open.has("-" + key));
        if (isOpen) { open.delete(key); open.add("-" + key); } else { open.add(key); open.delete("-" + key); }
        return renderList();
      }
      if (act === "all") {
        if (sel.size === accounts.length) sel.clear();
        else accounts.forEach((a) => sel.add(a.id));
      } else if (act === "group") {
        const g = getGroups().find((x) => x.key === el.closest("[data-group]").dataset.group);
        const full = g.accounts.every((a) => sel.has(a.id));
        g.accounts.forEach((a) => (full ? sel.delete(a.id) : sel.add(a.id)));
      } else {
        const id = el.dataset.id;
        if (sel.has(id)) sel.delete(id);
        else sel.add(id);
      }
      setVisibleAccountIds([...sel], MAILBOX_KEY);
      renderList();
      onChange();
    });
  }

  menuBtn.addEventListener("click", async () => {
    if (closePageHeaderMenu) closePageHeaderMenu();
    popupEl.classList.remove("hidden");
    filter = "";
    renderShell();
    renderList();
    await refreshUnread(); // counts may have moved since the page loaded
    if (!popupEl.classList.contains("hidden")) renderList();
  });
  closeBtn.addEventListener("click", () => {
    if (selected().size === 0) return;
    popupEl.classList.add("hidden");
  });
}
