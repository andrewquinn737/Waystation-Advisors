import { supabase } from "./supabaseClient.js";
import { wireAccountsVisiblePopup, getVisibleAccountIds, initDefaultToSelf } from "./accountsVisible.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

// ---------------------------------------------------------------------------
// Reports popup (team lead/admin-only) — "View Reports" on Profile.
//
// Outreach report: every seller-side dial tab is assigned to a specific
// buyer client (dial_lists.buyer_id — see the required "Buyer" picker on
// tab creation in js/dials.js), so "Select buyer" is really a buyer-scoped
// view of the same tab-level data. Calls made, Owners talked to, Owners
// agreed to intro call, and Intro calls completed all come from
// report_dial_rollups (keyed by list_id, with buyer_id captured alongside
// it) and respond to the buyer filter — Owners agreed is derived from the
// same call_status_changes rows as Owners talked (a call whose category
// landed on "Intro call scheduled"), not from intro_call_log like it used
// to be, specifically so it has a real tab/buyer relationship. This table
// is pre-computed every 15 min by a scheduled Postgres function
// (compute_report_rollups()) and pruned to the last 12 weeks/months by
// another (prune_report_data()) — this module only ever reads it, never
// computes numbers live, since dial_lists rows are hard-deleted and
// dials.contact_status/called_today_date are mutable, so a live query
// couldn't reconstruct a past period's numbers reliably.
//
// Team report: reads straight from survey_responses (no rollup needed — it
// already has exactly the right grain, one row per intern per week), pruned
// to the last 3 weeks by the same prune job. Always weekly, no buyer
// filter, no Totals row, always shows every account, no PDF export.
//
// Seller-side only for now (buyer support for the DIALS side, i.e. cold-
// calling actual buyers, may come later — not to be confused with the
// buyer-CLIENT attribution above, which is unrelated) — hardcoded, not a UI
// toggle, at every query in compute_report_rollups() (dial_type/
// client_type = 'seller') and in loadAvailableBuyers() below.
// ---------------------------------------------------------------------------

const REPORTS_ACCOUNTS_KEY = "waystation_report_accounts_visible";
// null represents "no buyer_id" both for rows where a tab was explicitly
// never assigned to a buyer, and for historical rows whose tab/buyer
// attribution predates this tracking existing at all (dial_lists rows are
// hard-deleted, so a deleted tab's rollup rows just keep whatever buyer_id
// was captured at the time — see js/dials.js). Both cases render as the
// same "Not attached to buyer" bucket; there's no need to distinguish them.
const UNATTACHED_BUYER_LABEL = "Not attached to buyer";

// Mirrors dials.js's CONTACT_STATUSES labels (kept as a separate plain map
// here since this module has no need for the color/dot info that lives
// alongside them there — call_status_changes.contact_status_at_call is just
// a frozen snapshot of whichever of these values was current at call time).
const CONTACT_STATUS_LABELS = {
  uncontacted: "Uncontacted",
  unable_to_contact: "Unable to contact",
  not_interested: "Not interested",
  no_response: "No response, try again",
  callback_interested: "Callback, interested",
  intro_call_scheduled: "Intro call scheduled",
};

// Same light-mode background shades as CONTACT_STATUSES' `bg` in
// js/dials.js (css/style.css's --status-*-bg custom properties) — PDFs have
// no concept of a CSS variable or a dark-mode toggle, so these are the
// literal light-mode hex values, used to tint each "Contacted business
// owners" PDF row by its category.
const CONTACT_STATUS_PDF_COLORS = {
  uncontacted: "#ffffff",
  unable_to_contact: "#eef0f2",
  not_interested: "#fdecec",
  no_response: "#ffeede",
  callback_interested: "#fff6e0",
  intro_call_scheduled: "#e7f8ee",
};

// PDF-only text cleanup (the on-screen table shows the raw values as-is) —
// strips emoji (\p{Extended_Pictographic} is the proper Unicode property for
// this, not an ad-hoc code-point range) and the invisible joiner/variation-
// selector characters emoji sequences use, without touching legitimate
// accented letters in a real name — jsPDF's standard fonts render Á/é/ñ/etc
// fine, just not emoji (those show up as blank boxes). Then title-cases the
// result so every name/company/category reads consistently regardless of
// how it was originally typed in.
function sanitizeForPdf(text) {
  if (!text) return "";
  const stripped = String(text)
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{FE0F}\u{200D}]/gu, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

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

// Inclusive start / exclusive end ISO bounds for a period — used only by
// the raw call_status_changes query behind the "Contacted business owners"
// list (everything else in this module reads pre-aggregated rollup tables
// keyed by period_type/period_start and never needs actual date bounds).
function periodBoundsISO(periodStart, type) {
  const start = new Date(periodStart);
  const end = new Date(periodStart);
  if (type === "month") end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + 7);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
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
  let selectedBuyerIds = null; // Set of buyer client ids (null member = "Not attached to buyer"), or null = all
  let showIndividuals = true;
  let availableBuyers = []; // [{id, name}] — real buyer clients only; "Not attached to buyer" is handled separately, not part of this list
  let allAccountsCache = null;
  let lastTableData = null; // { columns, rows } — plain arrays, for PDF export
  let lastContactedDialsRows = null; // raw rows from fetchContactedDials, or null when the section isn't currently shown — also feeds PDF export

  async function resolveAccounts() {
    if (!allAccountsCache) allAccountsCache = await getAllAccounts();
    const visible = getVisibleAccountIds(REPORTS_ACCOUNTS_KEY);
    if (!visible) return allAccountsCache;
    const picked = allAccountsCache.filter((a) => visible.has(a.id));
    return picked.length ? picked : allAccountsCache;
  }

  // get_reports_available_buyers() is a SECURITY DEFINER RPC (see
  // supabase/schema.sql) rather than a plain query — it returns the union
  // of buyers owned by the caller's admin/team pool with a confirmed
  // "Contract signed" event (mirrors js/dials.js's
  // loadContractSignedBuyers()) AND any buyer that pool has actually made
  // calls for, even one owned by someone outside the pool entirely (most
  // commonly an admin) — a plain query against `clients` can't see a
  // buyer it doesn't own/lead in the first place, so that second case
  // needs its own server-side scoping. Computed from the caller's own
  // admin/team pool, not the report's currently selected accounts — the
  // options list reflects the whole team's history regardless of how
  // Accounts visible happens to be narrowed right now.
  async function loadAvailableBuyers() {
    const { data, error } = await supabase.rpc("get_reports_available_buyers");
    return error ? [] : data || [];
  }

  async function fetchOutreachRows(accounts) {
    const accountIds = accounts.map((a) => a.id);
    const periodStartStr = isoDate(selectedPeriodStart);
    const { data } = await supabase
      .from("report_dial_rollups")
      .select("user_id, buyer_id, calls_made, owners_talked, owners_agreed_to_intro_call, intro_calls_completed")
      .in("user_id", accountIds)
      .eq("period_type", periodType)
      .eq("period_start", periodStartStr);
    const dialRows = data || [];
    return accounts.map((a) => {
      const myDialRows = dialRows.filter((r) => r.user_id === a.id && (!selectedBuyerIds || selectedBuyerIds.has(r.buyer_id)));
      return {
        name: a.full_name,
        callsMade: myDialRows.reduce((s, r) => s + r.calls_made, 0),
        ownersTalked: myDialRows.reduce((s, r) => s + r.owners_talked, 0),
        ownersAgreed: myDialRows.reduce((s, r) => s + r.owners_agreed_to_intro_call, 0),
        introCompleted: myDialRows.reduce((s, r) => s + r.intro_calls_completed, 0),
      };
    });
  }

  // Raw call_status_changes rows for the "Contacted business owners" static
  // list — the one place this module queries something other than a
  // pre-computed rollup table, since there's no aggregate to read here:
  // every logged call in range, as-is. Caller guarantees selectedBuyerIds is
  // a Set of exactly one id (possibly null, for "Not attached to buyer")
  // before calling this. contact_name/company_name are only ever populated
  // for calls logged after those columns existed (or the small slice of
  // older rows whose dial hadn't been deleted at backfill time) — older
  // rows show "—" for name/company but keep their real date/category.
  async function fetchContactedDials(accounts) {
    const singleBuyerId = [...selectedBuyerIds][0];
    const accountIds = accounts.map((a) => a.id);
    const { startISO, endISO } = periodBoundsISO(selectedPeriodStart, periodType);
    let query = supabase
      .from("call_status_changes")
      .select("contact_name, company_name, contact_status_at_call, changed_at")
      .eq("dial_type", "seller")
      .in("user_id", accountIds)
      .gte("changed_at", startISO)
      .lt("changed_at", endISO)
      .order("changed_at", { ascending: true });
    query = singleBuyerId === null ? query.is("buyer_id", null) : query.eq("buyer_id", singleBuyerId);
    const { data, error } = await query;
    return error ? [] : data || [];
  }

  // PDF-only "Total confirmed leads since contract was signed" table (see
  // buildReportPdf) — a seller client counts as a "lead" here once it has a
  // confirmed intro_call event AND its clients.source_list_id resolves
  // (via dial_lists) to one of the currently selected real buyers. This is
  // only possible because of how Intro calls completed is tracked: a new
  // seller client created from a dial captures which tab it came from
  // (source_list_id), and that tab is always attached to a buyer — so
  // "which buyer does this lead belong to" is answerable at all. Cumulative
  // across ALL time, not the selected week/month period — "since contract
  // was signed" has no period boundary of its own (a tab can only ever be
  // attached to a buyer with an already-confirmed Contract signed, so every
  // result here inherently postdates that signing without needing an
  // explicit date filter). Excludes the null "Not attached to buyer"
  // bucket entirely — there's no contract to be "since" for unattached
  // data — and returns [] outright if that's the only thing selected.
  //
  // get_confirmed_leads_since_signed() is a SECURITY DEFINER RPC rather
  // than a plain multi-table query — the join chain (client_events ->
  // clients -> dial_lists -> clients again for the buyer) crosses ownership
  // boundaries plain RLS wasn't built for: dial_lists_select_own only lets
  // a team lead see tabs they own/lead, but a buyer their team has real
  // call activity against could easily be attached to a tab owned by
  // someone else (most commonly an admin) — same shape of gap
  // get_reports_available_buyers exists to close for the buyer picker.
  async function fetchConfirmedLeadsSinceSigned(accounts) {
    let buyerIds = null;
    if (selectedBuyerIds) {
      buyerIds = [...selectedBuyerIds].filter((id) => id !== null);
      if (!buyerIds.length) return [];
    }
    const { data, error } = await supabase.rpc("get_confirmed_leads_since_signed", {
      p_account_ids: accounts.map((a) => a.id),
      p_buyer_ids: buyerIds,
    });
    return error ? [] : data || [];
  }

  // Outreach report only, and only once exactly one buyer is selected (a
  // multi-select or the "Select all" default has no single buyer to scope
  // this list to) — see the top-of-file comment and profile.html's
  // reportsContactedDialsWrap for the full rationale. Never affected by
  // showIndividuals.
  async function renderContactedDialsSection(accounts) {
    const showsLog = reportType === "outreach" && selectedBuyerIds !== null && selectedBuyerIds.size === 1;
    els.reportsContactedDialsWrap.classList.toggle("hidden", !showsLog);
    if (!showsLog) {
      els.reportsContactedDialsWrap.innerHTML = "";
      lastContactedDialsRows = null;
      return;
    }
    const rows = await fetchContactedDials(accounts);
    lastContactedDialsRows = rows;
    // The table itself scrolls inside a fixed-height box (see
    // .reports-contacted-dials-scroll in css/style.css) so a long list
    // doesn't push the rest of the report (and the PDF buttons below it)
    // off-screen — the PDF export instead includes every row as a plain
    // (unboxed) table of its own, see buildReportPdf().
    const bodyHTML = rows.length
      ? `
        <div class="reports-contacted-dials-scroll">
          <table>
            <thead><tr><th>Name</th><th>Company name</th><th>Date contacted</th><th>Category</th></tr></thead>
            <tbody>
              ${rows
                .map(
                  (r) => `
                <tr>
                  <td>${escapeHtml(r.contact_name || "—")}</td>
                  <td>${escapeHtml(r.company_name || "—")}</td>
                  <td>${escapeHtml(new Date(r.changed_at).toLocaleDateString())}</td>
                  <td>${escapeHtml(CONTACT_STATUS_LABELS[r.contact_status_at_call] || r.contact_status_at_call || "—")}</td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>`
      : `<p class="help-text">No contacted business owners in this range.</p>`;
    els.reportsContactedDialsWrap.innerHTML = `<h3>Contacted business owners</h3>${bodyHTML}`;
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
    els.reportsRangeBtn.classList.toggle("hidden", reportType !== "outreach");
    els.reportsSelectBuyerBtn.classList.toggle("hidden", reportType !== "outreach");
    els.reportsShowIndividualsBtn.classList.toggle("hidden", reportType !== "outreach");
    // Team report has no PDF export at all — Outreach report gets both
    // Create PDF (plain download) and Send PDF (share sheet, see the
    // reportsSendPdfBtn handler below).
    els.reportsCreatePdfBtn.classList.toggle("hidden", reportType !== "outreach");
    els.reportsSendPdfBtn.classList.toggle("hidden", reportType !== "outreach");

    const rangeLabel = reportType === "team" ? "week" : periodType;
    els.reportsRangeBtn.querySelector(".menu-item-label").textContent = `Range: ${periodType === "month" ? "Month" : "Week"}`;
    els.reportsSelectPeriodLabel.textContent = `Select ${rangeLabel}`;
    els.reportsShowIndividualsLabel.textContent = `Show individuals: ${showIndividuals ? "On" : "Off"}`;
  }

  function renderSelectPeriodPopup() {
    const type = reportType === "team" ? "week" : periodType;
    const count = reportType === "team" ? 3 : 12;
    const options = generatePeriodOptions(type, count);
    const selectedStr = isoDate(selectedPeriodStart);
    els.reportsSelectPeriodTitle.textContent = `Select ${type}`;
    els.reportsSelectPeriodBody.innerHTML = `
      <div class="accounts-visible-list">
        ${options
          .map((d) => {
            const v = isoDate(d);
            return `<button type="button" class="accounts-visible-row${v === selectedStr ? " selected" : ""}" data-value="${v}">${escapeHtml(fmtPeriodLabel(d, type))}</button>`;
          })
          .join("")}
      </div>
    `;
    els.reportsSelectPeriodBody.querySelectorAll(".accounts-visible-row[data-value]").forEach((row) => {
      row.addEventListener("click", () => {
        selectedPeriodStart = new Date(`${row.dataset.value}T00:00:00`);
        els.reportsSelectPeriodPopup.classList.add("hidden");
        refresh();
      });
    });
  }

  async function refresh() {
    els.reportsError.classList.add("hidden");
    const accounts = await resolveAccounts();
    if (reportType === "outreach") {
      availableBuyers = await loadAvailableBuyers();
      const rows = await fetchOutreachRows(accounts);
      renderOutreachTable(rows);
    } else {
      const rows = await fetchTeamRows(accounts);
      renderTeamTable(rows);
    }
    await renderContactedDialsSection(accounts);
  }

  // DOM data-attributes can't hold a real `null`, so the "Not attached to
  // buyer" row uses the empty string as its sentinel id in the markup —
  // domIdToBuyerId()/buyerIdToDomId() convert between that and the real
  // `null` used everywhere else (selectedBuyerIds, report_dial_rollups.buyer_id).
  function domIdToBuyerId(domId) {
    return domId === "" ? null : domId;
  }
  function buyerIdToDomId(buyerId) {
    return buyerId === null ? "" : buyerId;
  }

  function renderSelectBuyerPopup() {
    const allOptions = [...availableBuyers, { id: null, full_name: UNATTACHED_BUYER_LABEL }];
    const rowsHTML = allOptions
      .map(
        (b) => `
      <button type="button" class="accounts-visible-row" data-id="${buyerIdToDomId(b.id)}">
        <input type="checkbox" ${!selectedBuyerIds || selectedBuyerIds.has(b.id) ? "checked" : ""} tabindex="-1" />
        ${escapeHtml(b.full_name)}
      </button>`
      )
      .join("");
    els.reportsSelectBuyerBody.innerHTML = `
      <div class="accounts-visible-list">
        <button type="button" class="accounts-visible-row select-all" id="reportsBuyerSelectAllBtn">
          <input type="checkbox" ${!selectedBuyerIds ? "checked" : ""} tabindex="-1" />
          Select all
        </button>
        ${rowsHTML}
      </div>
    `;
    els.reportsSelectBuyerBody.querySelector("#reportsBuyerSelectAllBtn").addEventListener("click", (e) => {
      // renderSelectBuyerPopup() below replaces reportsSelectBuyerBody's
      // innerHTML synchronously, which detaches e.target from the DOM
      // before this click finishes bubbling up to document —
      // pageHeaderMenu.js's outside-click listener then sees a detached
      // target, misreads it as "outside," and closes the whole Reports
      // dropdown (and this popup along with it, since it's registered as an
      // extraCloseEl). Stopping propagation here keeps the click from ever
      // reaching that listener — same fix as accountsVisible.js's identical
      // bug this session.
      e.stopPropagation();
      selectedBuyerIds = selectedBuyerIds === null ? new Set() : null;
      renderSelectBuyerPopup();
      refresh();
    });
    els.reportsSelectBuyerBody.querySelectorAll(".accounts-visible-row[data-id]").forEach((row) => {
      row.addEventListener("click", (e) => {
        e.stopPropagation(); // see the comment on #reportsBuyerSelectAllBtn's handler above
        const id = domIdToBuyerId(row.dataset.id);
        if (selectedBuyerIds === null) selectedBuyerIds = new Set(allOptions.map((b) => b.id));
        if (selectedBuyerIds.has(id)) selectedBuyerIds.delete(id);
        else selectedBuyerIds.add(id);
        renderSelectBuyerPopup();
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

  // The three sub-popups (Accounts visible, Select buyer, Select period) are
  // registered as extraCloseEl so pageHeaderMenu.js's outside-click
  // detection treats clicks inside them as "inside" the Reports dropdown,
  // not outside it — that's what keeps the dropdown open underneath while
  // one of them is in use, and closing it (via the arrow, or a genuine
  // outside click) also closes whichever of the three happens to be open.
  wirePageHeaderMenu({
    toggleBtn: els.reportsMenuToggle,
    menuEl: els.reportsOptionsMenu,
    extraCloseEl: [els.reportsAccountsVisiblePopup, els.reportsSelectBuyerPopup, els.reportsSelectPeriodPopup],
  });

  els.reportsTypeBtn.addEventListener("click", () => {
    reportType = reportType === "outreach" ? "team" : "outreach";
    els.reportsTypeBtn.dataset.value = reportType;
    els.reportsTypeBtn.textContent = reportType === "outreach" ? "Outreach report" : "Team report";
    periodType = "week";
    selectedPeriodStart = mondayOf(new Date());
    renderOptionsMenu();
    refresh();
  });

  els.reportsRangeBtn.addEventListener("click", () => {
    periodType = periodType === "week" ? "month" : "week";
    selectedPeriodStart = periodType === "week" ? mondayOf(new Date()) : firstOfMonth(new Date());
    renderOptionsMenu();
    refresh();
  });

  els.reportsShowIndividualsBtn.addEventListener("click", () => {
    showIndividuals = !showIndividuals;
    els.reportsShowIndividualsLabel.textContent = `Show individuals: ${showIndividuals ? "On" : "Off"}`;
    refresh();
  });

  els.reportsSelectBuyerBtn.addEventListener("click", () => {
    els.reportsSelectBuyerPopup.classList.remove("hidden");
    renderSelectBuyerPopup();
  });
  els.reportsSelectBuyerClose.addEventListener("click", () => {
    els.reportsSelectBuyerPopup.classList.add("hidden");
  });
  // Clicking the backdrop itself (not the .modal card, and not any child of
  // it) closes the popup exactly like the Done/Close button does — checking
  // e.target === the popup element rather than e.currentTarget is what
  // excludes clicks that bubble up from inside the card.
  els.reportsSelectBuyerPopup.addEventListener("click", (e) => {
    if (e.target === els.reportsSelectBuyerPopup) els.reportsSelectBuyerClose.click();
  });

  els.reportsSelectPeriodBtn.addEventListener("click", () => {
    els.reportsSelectPeriodPopup.classList.remove("hidden");
    renderSelectPeriodPopup();
  });
  els.reportsSelectPeriodClose.addEventListener("click", () => {
    els.reportsSelectPeriodPopup.classList.add("hidden");
  });
  els.reportsSelectPeriodPopup.addEventListener("click", (e) => {
    if (e.target === els.reportsSelectPeriodPopup) els.reportsSelectPeriodClose.click();
  });

  wireAccountsVisiblePopup({
    menuBtn: els.reportsAccountsVisibleBtn,
    popupEl: els.reportsAccountsVisiblePopup,
    bodyEl: els.reportsAccountsVisibleBody,
    closeBtn: els.reportsAccountsVisibleClose,
    myProfileId: profile.id,
    getAllAccounts,
    storageKey: REPORTS_ACCOUNTS_KEY,
    onChange: () => {
      selectedBuyerIds = null; // available buyers depend on which accounts are selected
      refresh();
    },
    escapeHtml,
  });
  // Same backdrop-click-to-close as the other two popups — programmatically
  // clicking the Done button reuses its own guard (won't close with zero
  // accounts selected) instead of duplicating that logic here.
  els.reportsAccountsVisiblePopup.addEventListener("click", (e) => {
    if (e.target === els.reportsAccountsVisiblePopup) els.reportsAccountsVisibleClose.click();
  });

  // Shared by both Create PDF and Send PDF (Outreach report only — Team
  // report has neither button, see renderOptionsMenu()) so the exact same
  // document gets either downloaded directly or handed to the share sheet.
  async function buildReportPdf() {
    // jspdf-autotable's ESM build exports the older plugin-style API
    // (applyPlugin(jsPDF) attaches .autoTable() to the class, rather than a
    // standalone autoTable(doc, opts) function) — verified directly in a
    // browser before shipping this, since it's easy to get the CDN import
    // shape subtly wrong.
    const { jsPDF } = await import("https://cdn.jsdelivr.net/npm/jspdf@2/+esm");
    const { applyPlugin } = await import("https://cdn.jsdelivr.net/npm/jspdf-autotable@3/+esm");
    applyPlugin(jsPDF);
    const title = "Outreach report";
    const periodLabel = fmtPeriodLabel(selectedPeriodStart, periodType);
    const doc = new jsPDF();
    doc.text(`${title} — ${periodLabel}`, 14, 16);
    doc.autoTable({ startY: 22, head: [lastTableData.columns], body: lastTableData.rows });

    // "Total confirmed leads since contract was signed" — sits between the
    // main KPI table and Contacted business owners. Always rendered (unlike
    // Contacted business owners below, which disappears entirely with no
    // data) — an empty result shows a single "—" placeholder row instead of
    // omitting the table, so its presence/position in the PDF is always
    // predictable. Only possible at all because Intro calls completed is
    // tracked via clients.source_list_id (which buyer a seller client's
    // originating tab was attached to) — see fetchConfirmedLeadsSinceSigned
    // above.
    const accounts = await resolveAccounts();
    const confirmedLeads = await fetchConfirmedLeadsSinceSigned(accounts);
    const leadsY = doc.lastAutoTable.finalY + 10;
    doc.text("Total confirmed leads since contract was signed", 14, leadsY);
    doc.autoTable({
      startY: leadsY + 4,
      head: [["Name", "Company name", "Buyer", "Date"]],
      body: confirmedLeads.length
        ? confirmedLeads.map((r) => [
            sanitizeForPdf(r.contact_name) || "—",
            sanitizeForPdf(r.company_name) || "—",
            sanitizeForPdf(r.buyer_name) || "—",
            new Date(r.event_date).toLocaleDateString(),
          ])
        : [["—", "—", "—", "—"]],
      styles: { font: "helvetica", fontStyle: "normal", fontSize: 9, cellPadding: 3, overflow: "linebreak" },
      headStyles: { fontStyle: "bold" },
    });

    // Contacted business owners on-screen is boxed with its own internal
    // scroll (see .reports-contacted-dials-scroll) so a long list doesn't
    // push the rest of the page down — that constraint doesn't apply to a
    // PDF, so here it's just a full table of its own, relying on
    // jspdf-autotable's own pagination if it runs long. Cell text is
    // sanitized/title-cased for the PDF specifically (see sanitizeForPdf) —
    // the on-screen table keeps the raw values as typed. Each row is tinted
    // by its category using the same colors as the on-screen status dots
    // (see CONTACT_STATUS_PDF_COLORS) via didParseCell, matched back to the
    // row's real category through rowCategories (autoTable only gives the
    // already-sanitized display text in each cell, not the original key).
    if (lastContactedDialsRows && lastContactedDialsRows.length) {
      const contactedY = doc.lastAutoTable.finalY + 10;
      doc.text(`Contacted business owners — ${periodLabel}`, 14, contactedY);
      const rowCategories = lastContactedDialsRows.map((r) => r.contact_status_at_call);
      doc.autoTable({
        startY: contactedY + 4,
        head: [["Name", "Company name", "Date contacted", "Category"]],
        body: lastContactedDialsRows.map((r) => [
          sanitizeForPdf(r.contact_name) || "—",
          sanitizeForPdf(r.company_name) || "—",
          new Date(r.changed_at).toLocaleDateString(),
          sanitizeForPdf(CONTACT_STATUS_LABELS[r.contact_status_at_call] || r.contact_status_at_call) || "—",
        ]),
        styles: { font: "helvetica", fontStyle: "normal", fontSize: 9, cellPadding: 3, overflow: "linebreak" },
        headStyles: { fontStyle: "bold" },
        didParseCell: (data) => {
          if (data.section !== "body") return;
          const color = CONTACT_STATUS_PDF_COLORS[rowCategories[data.row.index]];
          if (color) data.cell.styles.fillColor = color;
        },
      });
    }
    const filename = `${title.replace(/\s+/g, "_")}_${periodLabel.replace(/[\s,]+/g, "_")}.pdf`;
    return { doc, filename };
  }

  els.reportsCreatePdfBtn.addEventListener("click", async () => {
    if (!lastTableData) return;
    const { doc, filename } = await buildReportPdf();
    doc.save(filename);
  });

  // Reuses the exact navigator.share() mechanism the Links "Send" button
  // uses on Profile (see js/profile.js) — but with a file instead of a URL.
  // navigator.share can take { files: [File] } on mobile Safari 15+/Android
  // Chrome, verified directly in a browser before shipping (see the same
  // rigor used for the CDN import shape above). Desktop mostly has no
  // navigator.share at all, and even where it exists, file support is
  // spotty — mailto:/sms: (the existing Links "Send" desktop fallback)
  // literally cannot attach a file at all (a hard platform limitation, not
  // fixable client-side), so the fallback here is a plain download instead
  // of trying to replicate the Text/Email popover.
  els.reportsSendPdfBtn.addEventListener("click", async () => {
    if (!lastTableData) return;
    const { doc, filename } = await buildReportPdf();
    const blob = doc.output("blob");
    const file = new File([blob], filename, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
      } catch {
        // User backed out of the share sheet — not an error.
      }
      return;
    }
    // Desktop (or any browser without file-share support): just download
    // it — there's no way to "automatically send" a file attachment
    // through mailto:/sms: the way the Links "Send" button can with a
    // plain URL, so the person has to attach it themselves afterward.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}
