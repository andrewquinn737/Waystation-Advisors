import { supabase } from "./supabaseClient.js";
import { wireAccountsVisiblePopup, getVisibleAccountIds, initDefaultToSelf } from "./accountsVisible.js";
import { wirePageHeaderMenu, closeAllPageHeaderMenus } from "./pageHeaderMenu.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

// ---------------------------------------------------------------------------
// Reports popup (team lead/admin-only) — "View Reports" on Profile.
//
// Outreach report has two independent sections stacked vertically:
//
// 1. "Call by account" — the original per-account KPI table (Calls made,
//    Owners talked to, Owners agreed, Intro calls completed), read from
//    report_dial_rollups (keyed by list_id, with buyer_id alongside it —
//    see the required "Buyer" picker on tab creation in js/dials.js) and
//    pre-computed every 15 min by compute_report_rollups(), pruned to the
//    last 12 weeks/months by prune_report_data(). On-screen only — this
//    section is deliberately excluded from the PDF (see renderOptionsMenu).
//
// 2. The buyer-centric section — a lifetime summary table, a period bar
//    chart, a lifetime per-tab breakdown, and deduped business-owner
//    tables, all scoped to whichever ONE buyer is currently selected (it's
//    hidden entirely, and the PDF buttons disappear, unless exactly one
//    buyer is picked). Backed by a handful of buyer-scoped RPCs
//    (get_buyer_progress_summary/get_buyer_outreach_chart/
//    get_buyer_outreach_since_signed/get_buyer_milestone_clients/
//    get_buyer_contacted_owners — see supabase/schema.sql) that read raw
//    tables directly rather than report_dial_rollups, since that table is
//    pruned and can't answer anything "lifetime"/"since signed". This is
//    the section (and the ONLY thing) the PDF export contains.
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

// Total progress summary's rows, in display order — key matches
// get_buyer_progress_summary()'s `metric` column exactly.
const SUMMARY_METRIC_LABELS = [
  ["approved_targets", "Approved targets"],
  ["owners_talked", "Owners talked to"],
  ["owners_agreed", "Owners agreed to intro call"],
  ["intro_calls_completed", "Intro calls completed (confirmed leads)"],
  ["leads_approved_by_client", "Leads approved by client"],
  ["client_calls_completed", "Client calls completed"],
  ["nda_signed", "NDA signed"],
  ["loi_sent", "LOI sent"],
  ["loi_executed", "LOI executed"],
  ["closed", "Closed"],
];

// "Total outreach since contract signed" table columns, in display order —
// key matches get_buyer_outreach_since_signed()'s columns exactly.
const CHART_METRIC_LABELS = [
  ["approved_targets", "Approved targets"],
  ["targets_contacted", "Targets contacted"],
  ["attempted_contacts", "Attempted contacts"],
  ["intro_call_scheduled", "Intro call scheduled"],
  ["callback_interested", "Callback, interested"],
  ["no_response", "No response, try again"],
  ["unable_to_contact", "Unable to contact"],
  ["not_interested", "Not interested"],
];

// The "Outreach for week/month of ___" bar chart's own bars — a distinct,
// shorter list from CHART_METRIC_LABELS above: no "Approved targets" (it's
// already in the Total progress summary right next to this chart, so
// repeating it here was redundant). Targets contacted leads (leftmost),
// followed by Total number of contacts (renamed from Attempted contacts),
// then the 5 category breakdown bars. Key matches
// get_buyer_outreach_chart()'s columns.
const GRAPH_METRIC_LABELS = [
  ["targets_contacted", "Targets contacted"],
  ["attempted_contacts", "Total number of contacts"],
  ["intro_call_scheduled", "Intro call scheduled"],
  ["callback_interested", "Callback, interested"],
  ["no_response", "No response, try again"],
  ["unable_to_contact", "Unable to contact"],
  ["not_interested", "Not interested"],
];

// Set 1 of the deduped business-owner tables (lifetime, from
// get_buyer_milestone_clients()) — key matches that RPC's `milestone_type`
// (a client_events.event_type value) exactly. Display order per spec.
const MILESTONE_TABLE_TITLES = [
  ["close", "Closed"],
  ["due_diligence", "LOI executed"],
  ["loi", "LOI sent"],
  ["nda_financials", "NDA signed"],
  ["client_meeting", "Client calls completed"],
  ["client_approval", "Leads approved by client"],
  ["intro_call", "Intro calls completed (confirmed leads)"],
];

// Set 2 of the deduped business-owner tables (period-scoped, from
// get_buyer_contacted_owners()) — key matches that RPC's `category`
// (a contact_status_at_call value) exactly. " for week/month of ___" is
// appended at render time (see renderBuyerCentricSection).
const CONTACTED_TABLE_TITLES = [
  ["intro_call_scheduled", "Intro call scheduled"],
  ["callback_interested", "Callback, interested"],
  ["no_response", "No response, try again"],
  ["unable_to_contact", "Unable to contact"],
  ["not_interested", "Not interested"],
];

// PDF-only text cleanup (the on-screen table shows the raw values as-is) —
// strips emoji (\p{Extended_Pictographic} is the proper Unicode property for
// this, not an ad-hoc code-point range) and the invisible joiner/variation-
// selector characters emoji sequences use, without touching legitimate
// accented letters in a real name — jsPDF's standard fonts render Á/é/ñ/etc
// fine, just not emoji (those show up as blank boxes). Then title-cases the
// result so every name/company/category reads consistently regardless of
// how it was originally typed in.
function stripForPdf(text) {
  if (!text) return "";
  return String(text)
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{FE0F}\u{200D}]/gu, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeForPdf(text) {
  const stripped = stripForPdf(text);
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

// Inclusive start / exclusive end ISO bounds for a period — used by the
// buyer-centric section's period-scoped RPCs (get_buyer_outreach_chart/
// get_buyer_contacted_owners). The call-by-account table doesn't need this
// at all — it reads pre-aggregated rollup rows keyed by period_type/
// period_start directly.
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
      const { data, error } = await supabase.from("profiles").select("id, full_name, role, team_id").order("full_name", { ascending: true });
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

  // Admin-only — groups the popup's account list under team section labels
  // (same real teams shown in the Teams popup) so an admin with many
  // accounts can tell them apart at a glance. See accountsVisible.js.
  async function getTeamsForGrouping() {
    const { data, error } = await supabase.from("teams").select("id, name").order("sort_order", { ascending: true });
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
  let lastTableData = null; // { columns, rows } — plain arrays, for PDF export (call-by-account table only — never in the PDF, see renderOptionsMenu)
  // Buyer-centric section's own cache — populated once per refresh() by
  // fetchBuyerCentricData() and reused as-is by both renderBuyerCentricSection()
  // (on-screen) and buildReportPdf() (which is the ONLY thing the PDF
  // contains), so the two are always guaranteed to show identical numbers
  // rather than risking two separate fetches drifting apart. null whenever
  // the section isn't currently showing (reportType !== "outreach", or
  // anything other than exactly one buyer selected).
  let buyerCentric = null; // { summary, chart, sinceSigned, milestoneClients, contactedOwners, periodLabel }

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

  // Fetches all 5 buyer-centric RPCs in parallel and caches the result on
  // `buyerCentric` — both renderBuyerCentricSection() (on-screen) and
  // buildReportPdf() read from this same cache rather than fetching
  // independently, so the two are guaranteed to always show identical
  // numbers. Only runs for Outreach report with exactly one buyer selected
  // (a multi-select or the "Select all" default has no single buyer to
  // scope any of this to) — sets buyerCentric to null otherwise.
  async function fetchBuyerCentricData(accounts) {
    const shows = reportType === "outreach" && selectedBuyerIds !== null && selectedBuyerIds.size === 1;
    if (!shows) {
      buyerCentric = null;
      return;
    }
    const buyerId = [...selectedBuyerIds][0];
    const { startISO, endISO } = periodBoundsISO(selectedPeriodStart, periodType);
    const [summaryRes, chartRes, sinceSignedRes, milestoneRes, contactedRes] = await Promise.all([
      supabase.rpc("get_buyer_progress_summary", { p_buyer_id: buyerId }),
      supabase.rpc("get_buyer_outreach_chart", { p_buyer_id: buyerId, p_period_start: startISO, p_period_end_excl: endISO }),
      supabase.rpc("get_buyer_outreach_since_signed", { p_buyer_id: buyerId }),
      supabase.rpc("get_buyer_milestone_clients", { p_buyer_id: buyerId }),
      supabase.rpc("get_buyer_contacted_owners", { p_buyer_id: buyerId, p_period_start: startISO, p_period_end_excl: endISO }),
    ]);
    buyerCentric = {
      summary: summaryRes.data || [],
      chart: chartRes.data || [],
      sinceSigned: sinceSignedRes.data || [],
      milestoneClients: milestoneRes.data || [],
      contactedOwners: contactedRes.data || [],
      periodLabel: fmtPeriodLabel(selectedPeriodStart, periodType),
    };
  }

  // Same light-mode hex values as CONTACT_STATUS_PDF_COLORS' `dot` shades
  // in js/dials.js for the 5 category bars, plus the brand navy/gold for the
  // 2 non-category bars — used by both the on-screen SVG chart and the
  // PDF's vector-drawn equivalent (see buildReportPdf).
  const CHART_BAR_COLORS = {
    attempted_contacts: "#15213a",
    targets_contacted: "#c8a45a",
    intro_call_scheduled: "#6fcf8e",
    callback_interested: "#f2d34b",
    no_response: "#f2a65a",
    unable_to_contact: "#9ca3af",
    not_interested: "#e0776d",
  };

  // Rough word-wrap for an SVG <text> label — no live font metrics
  // available here (unlike jsPDF's splitTextToSize), so lines are packed
  // greedily against an estimated average character width for the given
  // font size, same idea as the PDF chart's wrapping (see drawPdfBarChart).
  function wrapLabelLines(label, maxWidth, fontSize) {
    const maxChars = Math.max(4, Math.floor(maxWidth / (fontSize * 0.55)));
    const words = label.split(" ");
    const lines = [];
    let current = "";
    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    });
    if (current) lines.push(current);
    return lines;
  }

  // Plain inline SVG — no charting library is imported anywhere in this
  // app, and pulling one in for 7 bars would be a heavier CDN/CSP footprint
  // than just drawing rects directly. Labels are drawn horizontally rather
  // than rotated, wrapping onto a second line when they don't fit a slot's
  // width (some are long, e.g. "Callback, interested").
  function buildBarChartSVG(chartRows) {
    const w = 720,
      h = 340,
      axisY = 260,
      chartTop = 20,
      chartLeft = 50,
      chartRight = 700;
    const slotWidth = (chartRight - chartLeft) / GRAPH_METRIC_LABELS.length;
    const barWidth = Math.min(46, slotWidth - 14);
    const labelFontSize = 10.5;
    const values = GRAPH_METRIC_LABELS.map(([key]) => chartRows.find((r) => r.metric === key)?.value || 0);
    const maxValue = Math.max(1, ...values);
    const bars = GRAPH_METRIC_LABELS.map(([key, label], i) => {
      const value = values[i];
      const barHeight = (value / maxValue) * (axisY - chartTop);
      const slotCenter = chartLeft + slotWidth * i + slotWidth / 2;
      const barX = slotCenter - barWidth / 2;
      const barY = axisY - barHeight;
      const labelLines = wrapLabelLines(label, slotWidth - 6, labelFontSize);
      const labelText = labelLines
        .map((line, li) => `<tspan x="${slotCenter.toFixed(1)}" dy="${li === 0 ? 0 : labelFontSize + 1}">${escapeHtml(line)}</tspan>`)
        .join("");
      return `
        <rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" width="${barWidth}" height="${Math.max(0, barHeight).toFixed(1)}" fill="${CHART_BAR_COLORS[key]}" rx="2" />
        <text x="${slotCenter.toFixed(1)}" y="${(barY - 6).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="600" fill="#15213a">${value}</text>
        <text x="${slotCenter.toFixed(1)}" y="${axisY + 16}" text-anchor="middle" font-size="${labelFontSize}" fill="#4b5563">${labelText}</text>
      `;
    });
    return `
      <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:auto; max-width:640px;">
        <line x1="${chartLeft}" y1="${axisY}" x2="${chartRight}" y2="${axisY}" stroke="#eae3d3" stroke-width="1.5" />
        ${bars.join("")}
      </svg>
    `;
  }

  // Total progress summary — a plain 2-column (label, value) table, totals
  // for the selected buyer's whole lifetime (see get_buyer_progress_summary).
  function buildSummaryTableHTML(summaryRows) {
    const rows = SUMMARY_METRIC_LABELS.map(([key, label]) => {
      const value = summaryRows.find((r) => r.metric === key)?.value ?? 0;
      return `<tr><td>${escapeHtml(label)}</td><td class="num">${value}</td></tr>`;
    }).join("");
    return `<table><tbody>${rows}</tbody></table>`;
  }

  // "Total outreach since contract signed" — one row per tab attached to
  // the buyer (plus a synthetic "Not attributed to a specific tab" row for
  // historical calls with no identifiable tab — see
  // get_buyer_outreach_since_signed), same 8 columns as the bar chart,
  // lifetime instead of period-scoped, with a totals row computed here
  // client-side (not server-side — simpler to just sum what's on screen).
  function buildSinceSignedTableHTML(rows) {
    const totals = CHART_METRIC_LABELS.map(([key]) => rows.reduce((s, r) => s + (r[key] || 0), 0));
    const headCells = ["Tab", ...CHART_METRIC_LABELS.map(([, label]) => label)].map((c) => `<th>${escapeHtml(c)}</th>`).join("");
    const bodyRows = rows
      .map((r) => {
        const cells = CHART_METRIC_LABELS.map(([key]) => `<td class="num">${r[key] || 0}</td>`).join("");
        return `<tr><td>${escapeHtml(r.list_name)}</td>${cells}</tr>`;
      })
      .join("");
    const totalsRow = `<tr class="reports-totals-row"><td>Totals</td>${totals.map((v) => `<td class="num">${v}</td>`).join("")}</tr>`;
    return `
      <div class="reports-contacted-dials-scroll">
        <table>
          <thead><tr>${headCells}</tr></thead>
          <tbody>${totalsRow}${bodyRows}</tbody>
        </table>
      </div>
    `;
  }

  // Shared by both business-owner table sets (see renderBuyerCentricSection)
  // — a plain table of the given rows/columns, only ever called for a
  // non-empty row set (each individual table is omitted entirely, not shown
  // empty, when it has none — see the caller).
  function buildOwnerTableHTML(title, rows, columns) {
    const headCells = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
    const bodyRows = rows
      .map((r) => `<tr>${columns.map((c) => `<td>${escapeHtml(c.format ? c.format(r[c.key]) : r[c.key] ?? "—")}</td>`).join("")}</tr>`)
      .join("");
    return `
      <h3>${escapeHtml(title)}</h3>
      <div class="reports-contacted-dials-scroll">
        <table>
          <thead><tr>${headCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    `;
  }

  const MONEY_COLUMN = { key: "annual_revenue", label: "Revenue", format: (v) => (v == null ? "—" : `$${Number(v).toLocaleString()}`) };
  const SET1_COLUMNS = [
    { key: "full_name", label: "Name" },
    { key: "company_name", label: "Company name" },
    { key: "website", label: "Website" },
    { key: "city", label: "City" },
    { key: "state", label: "State" },
    { key: "industry", label: "Industry sector" },
    MONEY_COLUMN,
    { key: "employee_count", label: "Employees" },
  ];
  const SET2_COLUMNS = [
    { key: "contact_name", label: "Name" },
    { key: "company_name", label: "Company name" },
    { key: "website", label: "Website" },
    { key: "city", label: "City" },
    { key: "state", label: "State" },
    { key: "industry", label: "Industry sector" },
    { key: "call_notes", label: "Call notes" },
    { key: "date_last_contacted", label: "Date last contacted", format: (v) => (v ? new Date(v).toLocaleDateString() : "—") },
    { key: "outreach_count", label: "Outreach count" },
  ];

  // Outreach report only, and only once exactly one buyer is selected — see
  // fetchBuyerCentricData above. Never affected by showIndividuals.
  function renderBuyerCentricSection() {
    els.reportsBuyerCentricWrap.classList.toggle("hidden", !buyerCentric);
    if (!buyerCentric) {
      els.reportsBuyerCentricWrap.innerHTML = "";
      return;
    }
    const { summary, chart, sinceSigned, milestoneClients, contactedOwners, periodLabel } = buyerCentric;

    const milestoneTablesHTML = MILESTONE_TABLE_TITLES.map(([type, title]) => {
      const rows = milestoneClients.filter((r) => r.milestone_type === type);
      return rows.length ? buildOwnerTableHTML(title, rows, SET1_COLUMNS) : "";
    })
      .filter(Boolean)
      .join("");
    const contactedTablesHTML = CONTACTED_TABLE_TITLES.map(([category, title]) => {
      const rows = contactedOwners.filter((r) => r.category === category);
      return rows.length ? buildOwnerTableHTML(`${title} for ${periodLabel}`, rows, SET2_COLUMNS) : "";
    })
      .filter(Boolean)
      .join("");

    els.reportsBuyerCentricWrap.innerHTML = `
      <h3>Total progress summary</h3>
      ${buildSummaryTableHTML(summary)}
      <h3>Outreach for ${periodLabel}</h3>
      ${buildBarChartSVG(chart)}
      <h3>Total outreach since contract signed</h3>
      ${buildSinceSignedTableHTML(sinceSigned)}
      ${milestoneTablesHTML}
      ${contactedTablesHTML}
    `;
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
    // Team report has no PDF export at all, and even on the Outreach report
    // the PDF is entirely buyer-centric now (see buildReportPdf) — it needs
    // exactly one buyer selected to have anything to build, so both buttons
    // stay hidden for "Select all" or a multi-select just like they already
    // do for Team report.
    const showsPdfButtons = reportType === "outreach" && selectedBuyerIds !== null && selectedBuyerIds.size === 1;
    els.reportsCreatePdfBtn.classList.toggle("hidden", !showsPdfButtons);
    els.reportsSendPdfBtn.classList.toggle("hidden", !showsPdfButtons);

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
    await fetchBuyerCentricData(accounts);
    renderBuyerCentricSection();
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
      // PDF buttons are gated on "exactly one buyer selected" (see
      // renderOptionsMenu) — without this, picking a single buyer here
      // never actually re-evaluated that, so the buttons stayed stuck at
      // whatever they showed the last time something ELSE (report type,
      // period range) happened to re-render the options menu.
      renderOptionsMenu();
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
        renderOptionsMenu(); // see the comment on #reportsBuyerSelectAllBtn's handler above
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
    getTeams: isAdminSync ? getTeamsForGrouping : undefined,
    storageKey: REPORTS_ACCOUNTS_KEY,
    onChange: () => {
      selectedBuyerIds = null; // available buyers depend on which accounts are selected
      renderOptionsMenu(); // re-evaluate PDF button visibility now that selectedBuyerIds changed
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

  // Waystation brand palette (css/style.css's :root block / waystationadvisors.com)
  // — the PDF page background stays plain white (confirmed explicitly, not
  // the cream --gold-soft tint the reference logo/marketing site use), with
  // navy for text/headings and gold for header-row fills/accents.
  const PDF_NAVY = [21, 33, 58];
  const PDF_GOLD = [200, 164, 90];
  const PDF_BORDER = [234, 227, 211];
  const PDF_TEXT_GRAY = [75, 85, 99];

  // Reserved on every doc.autoTable() call below so a table can never be
  // drawn into the footer mark's own space (see drawFooterMark) — jspdf-
  // autotable's own default bottom margin (20) leaves too little clearance
  // once the mark's actual footprint is accounted for.
  const AUTOTABLE_BOTTOM_MARGIN = 24;

  // Columns whose PDF text should only have emoji/control characters
  // stripped, not title-cased — a URL, free-text call note, or two-letter
  // state code reads wrong in title case (see sanitizeForPdf vs stripForPdf).
  const PDF_NO_TITLE_CASE_KEYS = new Set(["website", "call_notes", "state"]);

  function ownerRowToPdfCells(row, columns) {
    return columns.map((c) => {
      if (c.format) return String(c.format(row[c.key]));
      const raw = row[c.key];
      if (raw == null || raw === "") return "—";
      return (PDF_NO_TITLE_CASE_KEYS.has(c.key) ? stripForPdf(raw) : sanitizeForPdf(raw)) || "—";
    });
  }

  // Vector-drawn (no canvas/image round-trip) equivalent of
  // buildBarChartSVG's on-screen chart, using jsPDF's own rect/text
  // primitives — same 7 categories/colors, same values. topPad reserves
  // headroom above the tallest possible bar for its value label, so a bar
  // that reaches (or nearly reaches) the top of the chart never collides
  // with the "Outreach for..." heading drawn just above it — the bug this
  // was fixed from had no such reserve, so a tall bar's number sat right on
  // top of that heading. bottomPad reserves room for up to 2 wrapped lines
  // of category label, drawn horizontally (splitTextToSize) rather than
  // rotated diagonally — long labels ("Callback, interested") wrap onto a
  // second line instead of running at an angle.
  function drawPdfBarChart(doc, chartRows, x, y, width, height) {
    const topPad = 10;
    const bottomPad = 18;
    const axisY = y + height - bottomPad;
    const plotHeight = height - topPad - bottomPad;
    const slotWidth = width / GRAPH_METRIC_LABELS.length;
    const barWidth = Math.min(20, slotWidth - 10);
    const labelMaxWidth = slotWidth - 4;
    const values = GRAPH_METRIC_LABELS.map(([key]) => chartRows.find((r) => r.metric === key)?.value || 0);
    const maxValue = Math.max(1, ...values);
    doc.setDrawColor(...PDF_BORDER);
    doc.setLineWidth(0.3);
    doc.line(x, axisY, x + width, axisY);
    GRAPH_METRIC_LABELS.forEach(([key, label], i) => {
      const value = values[i];
      const barHeight = (value / maxValue) * plotHeight;
      const slotCenter = x + slotWidth * i + slotWidth / 2;
      const barX = slotCenter - barWidth / 2;
      const barY = axisY - barHeight;
      doc.setFillColor(...hexToRgb(CHART_BAR_COLORS[key]));
      doc.rect(barX, barY, barWidth, Math.max(0, barHeight), "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.5);
      doc.setTextColor(...PDF_NAVY);
      doc.text(String(value), slotCenter, barY - 3, { align: "center" });
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.3);
      doc.setTextColor(...PDF_TEXT_GRAY);
      doc.splitTextToSize(label, labelMaxWidth).forEach((line, li) => {
        doc.text(line, slotCenter, axisY + 7 + li * 3.2, { align: "center" });
      });
    });
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Vector recreation of the hanging real-estate-sign "WAYSTATION" icon the
  // user sent as a reference image — a post with an arm extending to one
  // side, the gold sign hanging just below the arm's far end on two short
  // chain lines (not fused directly to the arm, per the reference), navy
  // serif caps centered on the sign. Drawn on every page after all content
  // is added (doc.setPage() loop so it lands on pages created via addPage()
  // too, not just the first). Every doc.autoTable() call below reserves a
  // matching bottom margin (see AUTOTABLE_BOTTOM_MARGIN) so no table can
  // ever be drawn into the space this occupies.
  function drawFooterMark(doc) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const pageCount = doc.internal.getNumberOfPages();

    const scale = 0.97; // ~3% smaller overall than the previous size
    const postHeight = 13 * scale;
    const postOverhang = 2.5 * scale; // post pokes up past where the arm meets it
    const armOverhang = 3 * scale; // arm pokes out to the left of the post too, not just toward the sign
    const gapPostToSign = 5 * scale; // clearance between the post and the sign's left edge (was nearly touching)
    const signW = 15.5 * scale;
    const signH = 7 * scale;
    const chainGap = 2.5 * scale;

    const postX = pageWidth - 34;
    const groundY = pageHeight - 6;
    const armY = groundY - postHeight; // the y level the arm/crossbar sits at
    const postTopY = armY - postOverhang;
    const armStartX = postX - armOverhang;
    const signX = postX + gapPostToSign;
    const armEndX = signX + signW;
    const signY = armY + chainGap;

    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setDrawColor(...PDF_NAVY);
      doc.setLineWidth(0.5);
      doc.line(postX, groundY, postX, postTopY); // post, extending slightly above the arm
      doc.line(postX - 1.5, groundY, postX + 1.5, groundY); // small foot, planted look
      doc.line(armStartX, armY, armEndX, armY); // arm, extending slightly past the post on the left
      doc.setLineWidth(0.3);
      doc.line(signX + 2, armY, signX + 2, signY); // chain, left
      doc.line(signX + signW - 2, armY, signX + signW - 2, signY); // chain, right
      doc.setLineWidth(0.4);
      doc.setFillColor(...PDF_GOLD);
      doc.roundedRect(signX, signY, signW, signH, 1, 1, "FD");
      doc.setFont("times", "bold");
      doc.setFontSize(5.3 * scale);
      doc.setTextColor(...PDF_NAVY);
      // Baseline, not visual center, is what jsPDF actually positions text
      // on — a small downward nudge (not the sign's full half-height) is
      // what actually lands it centered rather than toward the bottom.
      doc.text("WAYSTATION", signX + signW / 2, signY + signH / 2 + 0.9 * scale, { align: "center" });
    }
  }

  // Shared by both Create PDF and Send PDF (Outreach report only, and only
  // once exactly one buyer is selected — see renderOptionsMenu) so the exact
  // same document gets either downloaded directly or handed to the share
  // sheet. Entirely the buyer-centric section, reading straight from the
  // buyerCentric cache populated by fetchBuyerCentricData — the "call by
  // account" table is deliberately never in the PDF (see top-of-file comment).
  async function buildReportPdf() {
    // jspdf-autotable's ESM build exports the older plugin-style API
    // (applyPlugin(jsPDF) attaches .autoTable() to the class, rather than a
    // standalone autoTable(doc, opts) function) — verified directly in a
    // browser before shipping this, since it's easy to get the CDN import
    // shape subtly wrong.
    const { jsPDF } = await import("https://cdn.jsdelivr.net/npm/jspdf@2/+esm");
    const { applyPlugin } = await import("https://cdn.jsdelivr.net/npm/jspdf-autotable@3/+esm");
    applyPlugin(jsPDF);

    const buyerId = [...selectedBuyerIds][0];
    const buyerName = availableBuyers.find((b) => b.id === buyerId)?.full_name || "Buyer";
    const { summary, chart, sinceSigned, milestoneClients, contactedOwners, periodLabel } = buyerCentric;

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(...PDF_NAVY);
    doc.text(`Outreach report — ${buyerName}`, 14, 16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...PDF_TEXT_GRAY);
    doc.text(periodLabel, 14, 22);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...PDF_NAVY);
    doc.text("Total progress summary", 14, 32);
    doc.autoTable({
      startY: 36,
      head: [["Metric", "Total"]],
      body: SUMMARY_METRIC_LABELS.map(([key, label]) => [label, String(summary.find((r) => r.metric === key)?.value ?? 0)]),
      theme: "plain",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 3, lineWidth: 0.1, lineColor: PDF_BORDER, textColor: PDF_NAVY },
      headStyles: { fillColor: PDF_GOLD, textColor: PDF_NAVY, fontStyle: "bold" },
      columnStyles: { 1: { halign: "right" } },
      margin: { bottom: AUTOTABLE_BOTTOM_MARGIN },
    });

    const chartY = doc.lastAutoTable.finalY + 14;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...PDF_NAVY);
    doc.text(`Outreach for ${periodLabel}`, 14, chartY);
    drawPdfBarChart(doc, chart, 14, chartY + 6, pageWidth - 28, 78);

    // Page break before "Total outreach since contract signed" + every
    // business-owner table — page 1 is the two summary items, everything
    // else starts page 2 (per spec).
    doc.addPage();
    let y = 20;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...PDF_NAVY);
    doc.text("Total outreach since contract signed", 14, y);
    const totals = CHART_METRIC_LABELS.map(([key]) => sinceSigned.reduce((s, r) => s + (r[key] || 0), 0));
    doc.autoTable({
      startY: y + 4,
      head: [["Tab", ...CHART_METRIC_LABELS.map(([, label]) => label)]],
      body: [
        ["Totals", ...totals.map(String)],
        ...sinceSigned.map((r) => [r.list_name, ...CHART_METRIC_LABELS.map(([key]) => String(r[key] || 0))]),
      ],
      theme: "plain",
      styles: { font: "helvetica", fontSize: 7.5, cellPadding: 2.5, lineWidth: 0.1, lineColor: PDF_BORDER, textColor: PDF_NAVY, overflow: "linebreak" },
      headStyles: { fillColor: PDF_GOLD, textColor: PDF_NAVY, fontStyle: "bold", fontSize: 7 },
      didParseCell: (data) => {
        if (data.section === "body" && data.row.index === 0) data.cell.styles.fontStyle = "bold";
      },
      margin: { bottom: AUTOTABLE_BOTTOM_MARGIN },
    });
    // Every business-owner table (starting with "Closed"/"Leads approved by
    // client"/etc.) starts fresh on its own page, never sharing page 2 with
    // "Total outreach since contract signed" even when there'd technically
    // be room left — a hard break here instead of just falling through to
    // addOwnerPdfTable's own y > 250 check, which only ever caught a table
    // that literally didn't fit, not "don't put anything else on this page".
    doc.addPage();
    y = 20;

    // Each business-owner table is only added if it has ≥1 row (per spec —
    // absent, not shown empty) and starts a fresh page if it wouldn't fit
    // in the remaining space on the current one.
    // Explicit widths (mm) for the two columns that can't just be left to
    // autoTable's own content-based auto-sizing: website is one long
    // unbroken token (a URL, no spaces to wrap on) — without a fixed width
    // it keeps widening to fit the whole thing, squeezing every other
    // column into a sliver and inflating row height along with it, so it
    // gets a modest fixed width with ellipsize instead. Call notes is
    // free-form text that's routinely the longest content in the row, so
    // it's given the most room of any column here, wider than everything
    // else on purpose rather than leaving it to fight for space.
    const PDF_OWNER_COLUMN_WIDTHS = {
      website: { cellWidth: 26, overflow: "ellipsize" },
      call_notes: { cellWidth: 42 },
    };

    const addOwnerPdfTable = (title, rows, columns) => {
      if (!rows.length) return;
      if (y > 250) {
        doc.addPage();
        y = 20;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(...PDF_NAVY);
      doc.text(title, 14, y);
      const columnStyles = {};
      columns.forEach((c, idx) => {
        if (PDF_OWNER_COLUMN_WIDTHS[c.key]) columnStyles[idx] = PDF_OWNER_COLUMN_WIDTHS[c.key];
      });
      doc.autoTable({
        startY: y + 4,
        head: [columns.map((c) => c.label)],
        body: rows.map((r) => ownerRowToPdfCells(r, columns)),
        theme: "plain",
        styles: { font: "helvetica", fontSize: 7.5, cellPadding: 2.5, lineWidth: 0.1, lineColor: PDF_BORDER, textColor: PDF_NAVY, overflow: "linebreak" },
        headStyles: { fillColor: PDF_GOLD, textColor: PDF_NAVY, fontStyle: "bold", fontSize: 7 },
        columnStyles,
        margin: { bottom: AUTOTABLE_BOTTOM_MARGIN },
      });
      y = doc.lastAutoTable.finalY + 12;
    };

    MILESTONE_TABLE_TITLES.forEach(([type, title]) => {
      addOwnerPdfTable(title, milestoneClients.filter((r) => r.milestone_type === type), SET1_COLUMNS);
    });
    CONTACTED_TABLE_TITLES.forEach(([category, title]) => {
      addOwnerPdfTable(`${title} for ${periodLabel}`, contactedOwners.filter((r) => r.category === category), SET2_COLUMNS);
    });

    drawFooterMark(doc);

    const filename = `Outreach_report_${buyerName.replace(/\s+/g, "_")}_${periodLabel.replace(/[\s,]+/g, "_")}.pdf`;
    return { doc, filename };
  }

  // doc.save() used to be called directly here, which downloads straight
  // to disk on desktop with no preview — but on mobile, the exact same
  // call already opens a preview first (mobile browsers intercept a
  // downloaded PDF blob into their built-in viewer before offering to
  // save it) and only THEN lets you save from there. Opening the blob in
  // a new tab via a plain <a target="_blank"> (no download attribute) —
  // rather than window.open(), which browsers are far more likely to
  // block once a click handler has gone through a few awaits first —
  // gets desktop the same "preview, then decide whether to save" flow
  // mobile already had, using every desktop browser's own built-in PDF
  // viewer (complete with its own download button).
  els.reportsCreatePdfBtn.addEventListener("click", async () => {
    if (!buyerCentric) return;
    const { doc, filename } = await buildReportPdf();
    doc.setProperties({ title: filename });
    const url = URL.createObjectURL(doc.output("blob"));
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked well after the new tab has had time to load the blob URL,
    // not immediately — revoking too early can blank out the preview.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
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
    if (!buyerCentric) return;
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
