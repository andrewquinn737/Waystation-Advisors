import { supabase } from "./supabaseClient.js";
import { wireAccountsVisiblePopup, getVisibleAccountIds, initDefaultToSelf } from "./accountsVisible.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

// ---------------------------------------------------------------------------
// Reports popup (team lead/admin-only) — "View Reports" on Profile.
//
// Outreach report: Calls made + Owners talked to are tab-filterable (backed
// by report_dial_rollups, keyed by list_id — see js/dials.js's
// toggleDidCallToday(), which is what actually captures list_id/
// contact_status onto call_status_changes going forward). Owners agreed to
// intro call + Intro calls completed are NOT tab-filterable — neither has
// any relationship to a specific dial tab in the data model (backed by
// report_user_rollups). Both rollup tables are pre-computed every 15 min by
// a scheduled Postgres function (compute_report_rollups()) and pruned to the
// last 12 weeks/months by another (prune_report_data()) — this module only
// ever reads them, never computes numbers live, since dial_lists rows are
// hard-deleted and dials.contact_status/called_today_date are mutable, so a
// live query couldn't reconstruct a past period's numbers reliably.
//
// Team report: reads straight from survey_responses (no rollup needed — it
// already has exactly the right grain, one row per intern per week), pruned
// to the last 3 weeks by the same prune job. Always weekly, no tabs, no
// Totals row, always shows every account.
// ---------------------------------------------------------------------------

const REPORTS_ACCOUNTS_KEY = "waystation_report_accounts_visible";
const REMOVED_TAB_ID = "00000000-0000-0000-0000-000000000000";
const REMOVED_TAB_LABEL = "Removed tab(s)";

function mondayOf(d) {
  const dd = new Date(d);
  const day = dd.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  dd.setDate(dd.getDate() + diffToMonday);
  dd.setHours(0, 0, 0, 0);
  return dd;
}

function firstOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function fmtPeriodLabel(periodStart, type) {
  if (type === "month") {
    return periodStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  const end = new Date(periodStart);
  end.setDate(end.getDate() + 4); // Friday
  return `Week of ${periodStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

// Last 12 periods for Outreach (matches the 12-week/12-month retention
// window); last 3 for Team report (matches its own, shorter retention).
function generatePeriodOptions(type, count) {
  const options = [];
  const base = type === "week" ? mondayOf(new Date()) : firstOfMonth(new Date());
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    if (type === "week") d.setDate(d.getDate() - i * 7);
    else d.setMonth(d.getMonth() - i);
    options.push(d);
  }
  return options;
}

export function wireReportsPopup({ profile, isAdminSync, els, escapeHtml }) {
  // Mirrors the exact admin/team-lead pool logic already used for the
  // app-wide Accounts visible picker (see profile.js/clients.js) — a team
  // lead only ever sees themselves + their own team's interns, never every
  // account and never a peer admin/team-lead sharing their team_id.
  async function getAllAccounts() {
    if (isAdminSync) {
      const { data, error } = await supabase.from("profiles").select("id, full_name").order("full_name", { ascending: true });
      return error ? [] : data || [];
    }
    if (!profile.team_id) return [profile];
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name")
      .eq("team_id", profile.team_id)
      .or(`role.eq.intern,id.eq.${profile.id}`)
      .order("full_name", { ascending: true });
    return error ? [] : data || [];
  }

  initDefaultToSelf(profile.id, REPORTS_ACCOUNTS_KEY);

  let reportType = "outreach"; // "outreach" | "team"
  let periodType = "week"; // "week" | "month"
  let selectedPeriodStart = mondayOf(new Date());
  let selectedTabIds = null; // Set of tab ids (incl. REMOVED_TAB_ID), or null = all
  let showIndividuals = true;
  let availableTabs = []; // [{id, name}]
  let allAccountsCache = null;
  let lastTableData = null; // { columns, rows } — plain arrays, for PDF export

  async function resolveAccounts() {
    if (!allAccountsCache) allAccountsCache = await getAllAccounts();
    const visible = getVisibleAccountIds(REPORTS_ACCOUNTS_KEY);
    if (!visible) return allAccountsCache;
    const picked = allAccountsCache.filter((a) => visible.has(a.id));
    return picked.length ? picked : allAccountsCache;
  }

  async function loadAvailableTabs(accountIds) {
    const { data, error } = await supabase.from("dial_lists").select("id, name").in("created_by", accountIds);
    const real = error ? [] : (data || []).map((t) => ({ id: t.id, name: t.name }));
    return [...real, { id: REMOVED_TAB_ID, name: REMOVED_TAB_LABEL }];
  }

  async function fetchOutreachRows(accounts) {
    const accountIds = accounts.map((a) => a.id);
    const periodStartStr = isoDate(selectedPeriodStart);
    const [dialRes, userRes] = await Promise.all([
      supabase
        .from("report_dial_rollups")
        .select("user_id, list_id, calls_made, owners_talked")
        .in("user_id", accountIds)
        .eq("period_type", periodType)
        .eq("period_start", periodStartStr),
      supabase
        .from("report_user_rollups")
        .select("user_id, owners_agreed_to_intro_call, intro_calls_completed")
        .in("user_id", accountIds)
        .eq("period_type", periodType)
        .eq("period_start", periodStartStr),
    ]);
    const dialRows = dialRes.data || [];
    const userRows = userRes.data || [];
    return accounts.map((a) => {
      const myDialRows = dialRows.filter((r) => r.user_id === a.id && (!selectedTabIds || selectedTabIds.has(r.list_id)));
      const userRow = userRows.find((r) => r.user_id === a.id);
      return {
        name: a.full_name,
        callsMade: myDialRows.reduce((s, r) => s + r.calls_made, 0),
        ownersTalked: myDialRows.reduce((s, r) => s + r.owners_talked, 0),
        ownersAgreed: userRow?.owners_agreed_to_intro_call || 0,
        introCompleted: userRow?.intro_calls_completed || 0,
      };
    });
  }

  async function fetchTeamRows(accounts) {
    const accountIds = accounts.map((a) => a.id);
    const { data, error } = await supabase
      .from("survey_responses")
      .select("user_id, info_accurate, calls_made_final, owners_talked_final, owners_agreed_final, financial_modeling, questions_concerns")
      .in("user_id", accountIds)
      .eq("period_start", isoDate(selectedPeriodStart));
    const rows = error ? [] : data || [];
    return accounts.map((a) => {
      const r = rows.find((x) => x.user_id === a.id);
      return {
        name: a.full_name,
        submitted: !!r,
        infoAccurate: r?.info_accurate ?? null,
        callsFinal: r?.calls_made_final ?? 0,
        ownersTalkedFinal: r?.owners_talked_final ?? 0,
        ownersAgreedFinal: r?.owners_agreed_final ?? 0,
        financialModeling: r?.financial_modeling ?? null,
        questionsConcerns: r?.questions_concerns || "",
      };
    });
  }

  function renderOutreachTable(rows) {
    const callsLabel = periodType === "month" ? "Calls made this month" : "Calls made this week";
    const totals = rows.reduce(
      (acc, r) => ({
        callsMade: acc.callsMade + r.callsMade,
        ownersTalked: acc.ownersTalked + r.ownersTalked,
        ownersAgreed: acc.ownersAgreed + r.ownersAgreed,
        introCompleted: acc.introCompleted + r.introCompleted,
      }),
      { callsMade: 0, ownersTalked: 0, ownersAgreed: 0, introCompleted: 0 }
    );
    const columns = ["Account", callsLabel, "Owners talked to", "Owners agreed to intro call", "Intro calls completed (confirmed leads)"];
    const dataRows = rows.map((r) => [r.name, r.callsMade, r.ownersTalked, r.ownersAgreed, r.introCompleted]);
    const totalsRow = ["Totals", totals.callsMade, totals.ownersTalked, totals.ownersAgreed, totals.introCompleted];
    lastTableData = { columns, rows: showIndividuals ? [totalsRow, ...dataRows] : [totalsRow] };

    const bodyHTML = showIndividuals
      ? dataRows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")
      : "";
    els.reportsTableWrap.innerHTML = `
      <table>
        <thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>
          <tr class="reports-totals-row">${totalsRow.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>
          ${bodyHTML}
        </tbody>
      </table>
    `;
  }

  function renderTeamTable(rows) {
    const columns = ["Account", "Info accurate?", "Financial modeling", "Questions/concerns"];
    const dataRows = rows.map((r) => [
      r.name,
      !r.submitted ? "No submission" : r.infoAccurate ? "Yes" : `No — Calls: ${r.callsFinal}, Owners talked: ${r.ownersTalkedFinal}, Agreed: ${r.ownersAgreedFinal}`,
      !r.submitted ? "—" : r.financialModeling ? "Yes" : "No",
      r.questionsConcerns || "—",
    ]);
    lastTableData = { columns, rows: dataRows };
    els.reportsTableWrap.innerHTML = `
      <table>
        <thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
        <tbody>${dataRows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    `;
  }

  function renderOptionsMenu() {
    els.reportsPeriodTypeRow.classList.toggle("hidden", reportType !== "outreach");
    els.reportsSelectPeriodRow.classList.remove("hidden");
    els.reportsSelectTabsBtn.classList.toggle("hidden", reportType !== "outreach");
    els.reportsShowIndividualsBtn.classList.toggle("hidden", reportType !== "outreach");

    els.reportsPeriodTypeToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === periodType));

    const count = reportType === "team" ? 3 : 12;
    const options = generatePeriodOptions(reportType === "team" ? "week" : periodType, count);
    els.reportsPeriodSelect.innerHTML = options
      .map((d, i) => `<option value="${isoDate(d)}" ${i === 0 ? "selected" : ""}>${escapeHtml(fmtPeriodLabel(d, reportType === "team" ? "week" : periodType))}</option>`)
      .join("");

    els.reportsShowIndividualsLabel.textContent = `Show individuals: ${showIndividuals ? "On" : "Off"}`;
  }

  async function refresh() {
    els.reportsError.classList.add("hidden");
    const accounts = await resolveAccounts();
    if (reportType === "outreach") {
      availableTabs = await loadAvailableTabs(accounts.map((a) => a.id));
      const rows = await fetchOutreachRows(accounts);
      renderOutreachTable(rows);
    } else {
      const rows = await fetchTeamRows(accounts);
      renderTeamTable(rows);
    }
  }

  function renderSelectTabsPopup() {
    const rowsHTML = availableTabs
      .map(
        (t) => `
      <button type="button" class="accounts-visible-row" data-id="${t.id}">
        <input type="checkbox" ${!selectedTabIds || selectedTabIds.has(t.id) ? "checked" : ""} tabindex="-1" />
        ${escapeHtml(t.name)}
      </button>`
      )
      .join("");
    els.reportsSelectTabsBody.innerHTML = `
      <div class="accounts-visible-list">
        <button type="button" class="accounts-visible-row select-all" id="reportsTabsSelectAllBtn">
          <input type="checkbox" ${!selectedTabIds ? "checked" : ""} tabindex="-1" />
          Select all
        </button>
        ${rowsHTML}
      </div>
    `;
    els.reportsSelectTabsBody.querySelector("#reportsTabsSelectAllBtn").addEventListener("click", () => {
      selectedTabIds = selectedTabIds === null ? new Set() : null;
      renderSelectTabsPopup();
      refresh();
    });
    els.reportsSelectTabsBody.querySelectorAll(".accounts-visible-row[data-id]").forEach((row) => {
      row.addEventListener("click", () => {
        const id = row.dataset.id;
        if (selectedTabIds === null) selectedTabIds = new Set(availableTabs.map((t) => t.id));
        if (selectedTabIds.has(id)) selectedTabIds.delete(id);
        else selectedTabIds.add(id);
        renderSelectTabsPopup();
        refresh();
      });
    });
  }

  els.reportsBtn.addEventListener("click", () => {
    els.reportsModal.classList.remove("hidden");
    lockPageScroll();
    renderOptionsMenu();
    refresh();
  });
  els.reportsCloseBtn.addEventListener("click", () => {
    els.reportsModal.classList.add("hidden");
    // Not just a classList toggle — closeAllPageHeaderMenus() also clears
    // pageHeaderMenu.js's own open-state tracking and its document-level
    // outside-click listener, which a direct classList.add("hidden") here
    // would silently leave dangling if the options menu happened to still
    // be open.
    closeAllPageHeaderMenus();
    unlockPageScroll();
  });

  wirePageHeaderMenu({ toggleBtn: els.reportsMenuToggle, menuEl: els.reportsOptionsMenu });

  els.reportsTypeToggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      reportType = btn.dataset.value;
      els.reportsTypeToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      periodType = "week";
      selectedPeriodStart = mondayOf(new Date());
      renderOptionsMenu();
      refresh();
    });
  });

  els.reportsPeriodTypeToggle.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      periodType = btn.dataset.value;
      selectedPeriodStart = periodType === "week" ? mondayOf(new Date()) : firstOfMonth(new Date());
      renderOptionsMenu();
      refresh();
    });
  });

  els.reportsPeriodSelect.addEventListener("change", () => {
    selectedPeriodStart = new Date(`${els.reportsPeriodSelect.value}T00:00:00`);
    refresh();
  });

  els.reportsShowIndividualsBtn.addEventListener("click", () => {
    showIndividuals = !showIndividuals;
    els.reportsShowIndividualsLabel.textContent = `Show individuals: ${showIndividuals ? "On" : "Off"}`;
    refresh();
  });

  els.reportsSelectTabsBtn.addEventListener("click", () => {
    closeAllPageHeaderMenus();
    els.reportsSelectTabsPopup.classList.remove("hidden");
    renderSelectTabsPopup();
  });
  els.reportsSelectTabsClose.addEventListener("click", () => {
    els.reportsSelectTabsPopup.classList.add("hidden");
  });

  wireAccountsVisiblePopup({
    menuBtn: els.reportsAccountsVisibleBtn,
    popupEl: els.reportsAccountsVisiblePopup,
    bodyEl: els.reportsAccountsVisibleBody,
    closeBtn: els.reportsAccountsVisibleClose,
    closePageHeaderMenu: closeAllPageHeaderMenus,
    myProfileId: profile.id,
    getAllAccounts,
    storageKey: REPORTS_ACCOUNTS_KEY,
    onChange: () => {
      selectedTabIds = null; // available tabs depend on which accounts are selected
      refresh();
    },
    escapeHtml,
  });

  els.reportsCreatePdfBtn.addEventListener("click", async () => {
    if (!lastTableData) return;
    // jspdf-autotable's ESM build exports the older plugin-style API
    // (applyPlugin(jsPDF) attaches .autoTable() to the class, rather than a
    // standalone autoTable(doc, opts) function) — verified directly in a
    // browser before shipping this, since it's easy to get the CDN import
    // shape subtly wrong.
    const { jsPDF } = await import("https://cdn.jsdelivr.net/npm/jspdf@2/+esm");
    const { applyPlugin } = await import("https://cdn.jsdelivr.net/npm/jspdf-autotable@3/+esm");
    applyPlugin(jsPDF);
    const title = reportType === "outreach" ? "Outreach report" : "Team report";
    const periodLabel = fmtPeriodLabel(selectedPeriodStart, reportType === "team" ? "week" : periodType);
    const doc = new jsPDF();
    doc.text(`${title} — ${periodLabel}`, 14, 16);
    doc.autoTable({ startY: 22, head: [lastTableData.columns], body: lastTableData.rows });
    doc.save(`${title.replace(/\s+/g, "_")}_${periodLabel.replace(/[\s,]+/g, "_")}.pdf`);
  });
}
