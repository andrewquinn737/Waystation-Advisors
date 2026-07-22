import { supabase } from "./supabaseClient.js";
import { requireSession, showError, signOut } from "./auth.js";
import { wirePageHeaderMenu } from "./pageHeaderMenu.js";
import { contactActionIcons, stopContactActionPropagation } from "./contactIcons.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;

const els = {
  errorBox: document.getElementById("errorBox"),
  pageMenuToggle: document.getElementById("pageMenuToggle"),
  pageHeaderMenu: document.getElementById("pageHeaderMenu"),
  avatarInitials: document.getElementById("avatarInitials"),
  profileName: document.getElementById("profileName"),
  profileRole: document.getElementById("profileRole"),
  callsThisWeekText: document.getElementById("callsThisWeekText"),
  callsChart: document.getElementById("callsChart"),
  teamsBtn: document.getElementById("teamsBtn"),
  teamsModal: document.getElementById("teamsModal"),
  teamsCloseBtn: document.getElementById("teamsCloseBtn"),
  teamsWrap: document.getElementById("teamsWrap"),
  profileSignOutBtn: document.getElementById("profileSignOutBtn"),
};

function initials(name) {
  return (name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("") || "?";
}

els.profileName.textContent = profile.full_name;
// Team leads are on hold for now — every account is an intern (see
// is_team_lead() in supabase/schema.sql for the one place to re-enable it).
els.profileRole.textContent = "Intern";
els.avatarInitials.textContent = initials(profile.full_name);

// ---------------------------------------------------------------------------
// Teams popup — 3 fixed, expandable groups (not user-creatable yet). Every
// intern account lands in "Unassigned interns" by default (see the `team`
// column's default in supabase/schema.sql / handle_new_user()); re-assigning
// someone to Admins/Team 1 is a manual DB edit for now, same as promoting a
// team lead used to be.
// ---------------------------------------------------------------------------
const TEAM_GROUPS = ["Admins", "Team 1", "Unassigned interns"];
let teamMembersByGroup = {};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function memberPositionLabel(m) {
  // Only "Intern" exists as a position today (team leads are on hold — see
  // is_team_lead() in supabase/schema.sql).
  return m.role === "team_lead" ? "Team Lead" : "Intern";
}

async function loadTeams() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, phone, email, team")
    .order("full_name", { ascending: true });
  if (error) return showError(els.errorBox, error);

  teamMembersByGroup = { "Admins": [], "Team 1": [], "Unassigned interns": [] };
  (data || []).forEach((m) => {
    const group = teamMembersByGroup[m.team] ? m.team : "Unassigned interns";
    teamMembersByGroup[group].push(m);
  });
  renderTeams();
}

function renderTeams() {
  els.teamsWrap.innerHTML = TEAM_GROUPS.map((group, i) => {
    const members = teamMembersByGroup[group] || [];
    return `
      <div class="accordion-section team-group ${i === 0 ? "open" : ""}" data-group="${escapeHtml(group)}">
        <div class="accordion-header">
          <span>${escapeHtml(group)} <span class="help-text" style="display:inline;">(${members.length})</span></span>
          <span class="chevron">&#9662;</span>
        </div>
        <div class="accordion-body team-group-body">
          ${
            members.length
              ? `<div class="team-member-list">${members.map(memberCardHTML).join("")}</div>`
              : `<div class="empty-state">No one here yet.</div>`
          }
        </div>
      </div>`;
  }).join("");

  els.teamsWrap.querySelectorAll(".accordion-header").forEach((header) => {
    header.addEventListener("click", () => header.parentElement.classList.toggle("open"));
  });
  els.teamsWrap.querySelectorAll("[data-member-id]").forEach((card) => {
    card.addEventListener("click", () => {
      const member = Object.values(teamMembersByGroup).flat().find((m) => m.id === card.dataset.memberId);
      if (member) toggleMemberDetail(card, member);
    });
  });
  stopContactActionPropagation(els.teamsWrap);
}

function memberCardHTML(m) {
  return `
    <div class="team-member-card-wrap">
      <div class="team-member-card clickable-row" data-member-id="${m.id}">
        <div class="mc-main">
          <div class="mc-name">${escapeHtml(m.full_name)}</div>
          <div class="mc-sub">${escapeHtml(memberPositionLabel(m))}</div>
        </div>
        ${contactActionIcons({ phone: m.phone, email: m.email })}
      </div>
    </div>`;
}

// Tapping a team member's rectangle used to open a separate centered popup
// for their phone/email — but that popup rendered behind the Teams
// full-screen modal (a lower z-index than .fullscreen-modal), so it looked
// like it "pulled up underneath" the Teams view. Replaced with an inline
// expand: the phone/email rows (each with its own instant-contact icons,
// aligned with that row) appear directly below the tapped card, pushing the
// rest of the list down; tapping the same card again collapses them back.
// This mutates the DOM directly (rather than re-rendering the whole
// #teamsWrap via renderTeams()) so expanding/collapsing a card never
// resets which team-group accordions happen to be open.
function toggleMemberDetail(card, member) {
  const wrap = card.closest(".team-member-card-wrap");
  const existingDetail = wrap.querySelector(".team-member-detail");
  if (existingDetail) {
    existingDetail.remove();
    card.classList.remove("expanded");
    if (!card.querySelector(".contact-actions")) {
      card.insertAdjacentHTML("beforeend", contactActionIcons({ phone: member.phone, email: member.email }));
      stopContactActionPropagation(card);
    }
    return;
  }
  const iconsSlot = card.querySelector(".contact-actions");
  if (iconsSlot) iconsSlot.remove();
  card.classList.add("expanded");
  wrap.insertAdjacentHTML(
    "beforeend",
    `<div class="team-member-detail">
      ${memberDetailRow("Phone number", member.phone, "phone")}
      ${memberDetailRow("Email", member.email, "email")}
    </div>`
  );
  wireLongPressCopy(wrap);
  stopContactActionPropagation(wrap);
}

// Briefly shows "Copied" next to a value after a long-press copies it —
// same lightweight pattern as the call-notes "Saved" indicator on Dials.
function wireLongPressCopy(container) {
  container.querySelectorAll(".copyable").forEach((el) => {
    let timer = null;
    const start = () => {
      timer = setTimeout(async () => {
        try {
          await navigator.clipboard.writeText(el.dataset.copy || "");
          const toast = el.parentElement.querySelector(".copy-toast");
          if (toast) {
            toast.classList.remove("hidden");
            setTimeout(() => toast.classList.add("hidden"), 1200);
          }
        } catch {
          // Clipboard access can fail (permissions, insecure context, etc.)
          // — silently ignore, nothing to fall back to here.
        }
      }, 500);
    };
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    el.addEventListener("pointerdown", start);
    ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => el.addEventListener(ev, cancel));
  });
}

function memberDetailRow(label, value, kind) {
  const v = value ? String(value) : "";
  return `
    <div class="readonly-field">
      <div class="rf-label">${escapeHtml(label)}</div>
      <div class="rf-value-row">
        <div class="rf-value-row" style="gap:8px;">
          <div class="rf-value ${v ? "copyable" : "empty"}" ${v ? `data-copy="${escapeHtml(v)}"` : ""}>${v ? escapeHtml(v) : "Not provided"}</div>
          <span class="copy-toast hidden">Copied</span>
        </div>
        ${v ? contactActionIcons(kind === "phone" ? { phone: v } : { email: v }) : ""}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// "X people called this week" + 6-week chart. A row is inserted into
// call_status_changes (see updateDialStatus() in js/dials.js) the first time
// a dial moves off its default "Uncontacted" status — this counts how many
// distinct dials this intern has contacted, bucketed into Monday-Sunday weeks.
// ---------------------------------------------------------------------------

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmtShortDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Weekly quota — also drives the "(N more calls to reach quota)" /
// "(Quota met)" text under the calls-this-week heading.
const WEEKLY_QUOTA = 50;

// Picks a "nice" gridline step (1/2/5 x a power of 10) for a given rough
// spacing target, same approach most charting libraries use so the
// gridlines land on round numbers instead of awkward ones.
function niceStep(roughStep) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
  const residual = roughStep / magnitude;
  let step;
  if (residual > 5) step = 10;
  else if (residual > 2) step = 5;
  else if (residual > 1) step = 2;
  else step = 1;
  return step * magnitude;
}

function renderCallsChart(weekStarts, counts) {
  const w = 300;
  const h = 150;
  const padX = 18;
  const padTop = 22; // room for the value label above the tallest dot
  const padBottom = 16;
  const plotH = h - padTop - padBottom;

  // The 50-quota line always has to fit on the chart, even in weeks where
  // nobody's close to it yet, so the axis max is never less than the quota.
  const rawMax = Math.max(WEEKLY_QUOTA, ...counts);
  const step = niceStep(rawMax / 4);
  const axisMax = Math.ceil(rawMax / step) * step;

  const yFor = (v) => padTop + plotH - (v / axisMax) * plotH;

  const stepX = counts.length > 1 ? (w - padX * 2) / (counts.length - 1) : 0;
  const points = counts.map((c, i) => ({
    x: padX + i * stepX,
    y: yFor(c),
  }));
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const dots = points.map((p) => `<circle class="profile-chart-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3"></circle>`).join("");
  const valueLabels = points
    .map((p, i) => `<text class="profile-chart-value" x="${p.x.toFixed(1)}" y="${(p.y - 7).toFixed(1)}" text-anchor="middle">${counts[i]}</text>`)
    .join("");
  const dateLabels = weekStarts
    .map((ws, i) => `<text class="profile-chart-label" x="${points[i].x.toFixed(1)}" y="${h - 2}" text-anchor="middle">${fmtShortDate(ws)}</text>`)
    .join("");

  // Adaptive gridlines (0, step, 2*step, ... up to axisMax), each with a
  // value label on the left.
  const gridlines = [];
  for (let v = 0; v <= axisMax + 0.001; v += step) {
    const y = yFor(v);
    gridlines.push(`<line class="profile-chart-grid" x1="${padX}" x2="${(w - padX).toFixed(1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>`);
    gridlines.push(`<text class="profile-chart-grid-label" x="2" y="${(y + 3).toFixed(1)}">${Math.round(v)}</text>`);
  }

  // Fixed quota line at 50, always green, regardless of the data — drawn
  // after the regular gridlines so it sits on top of them.
  const quotaY = yFor(WEEKLY_QUOTA);
  const quotaLine = `<line class="profile-chart-quota-line" x1="${padX}" x2="${(w - padX).toFixed(1)}" y1="${quotaY.toFixed(1)}" y2="${quotaY.toFixed(1)}"></line>`;

  els.callsChart.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}">
      ${gridlines.join("")}
      ${quotaLine}
      <path class="profile-chart-line" d="${pathD}"></path>
      ${dots}
      ${valueLabels}
      ${dateLabels}
    </svg>
  `;
}

async function loadCallsChart() {
  const thisWeekStart = startOfWeek(new Date());
  const weekStarts = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(thisWeekStart);
    d.setDate(d.getDate() - i * 7);
    weekStarts.push(d);
  }
  const { data, error } = await supabase
    .from("call_status_changes")
    .select("changed_at")
    .eq("user_id", profile.id)
    .gte("changed_at", weekStarts[0].toISOString());
  if (error) return showError(els.errorBox, error);

  const rows = data || [];
  const counts = weekStarts.map((ws) => {
    const we = new Date(ws);
    we.setDate(we.getDate() + 7);
    return rows.filter((r) => {
      const t = new Date(r.changed_at);
      return t >= ws && t < we;
    }).length;
  });

  const thisWeekCount = counts[counts.length - 1];

  // Today's count is just a narrower slice of the same `rows` already
  // fetched above (which covers everything since the start of this week, so
  // today is included in there).
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const todayCount = rows.filter((r) => {
    const t = new Date(r.changed_at);
    return t >= startOfToday && t < startOfTomorrow;
  }).length;

  const remaining = WEEKLY_QUOTA - thisWeekCount;
  const quotaHTML =
    remaining <= 0
      ? `<div class="profile-quota-status profile-quota-met">(Quota met)</div>`
      : `<div class="profile-quota-status profile-quota-remaining">(${remaining} more call${remaining === 1 ? "" : "s"} to reach quota)</div>`;
  els.callsThisWeekText.innerHTML = `${thisWeekCount} ${thisWeekCount === 1 ? "person" : "people"} called this week, ${todayCount} today${quotaHTML}`;
  renderCallsChart(weekStarts, counts);
}

loadCallsChart();

els.teamsBtn.addEventListener("click", async () => {
  els.teamsModal.classList.remove("hidden");
  lockPageScroll();
  await loadTeams();
});
els.teamsCloseBtn.addEventListener("click", () => {
  els.teamsModal.classList.add("hidden");
  unlockPageScroll();
});
els.profileSignOutBtn.addEventListener("click", signOut);

wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu });
