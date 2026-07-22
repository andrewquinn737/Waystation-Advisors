import { supabase } from "./supabaseClient.js";
import { requireSession, showError, signOut } from "./auth.js";
import { wirePageHeaderMenu } from "./pageHeaderMenu.js";

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
els.profileRole.textContent = profile.role === "team_lead" ? "Team Lead" : "Intern";
els.avatarInitials.textContent = initials(profile.full_name);

async function loadTeams() {
  const { data, error } = await supabase.from("teams").select("*").order("name");
  if (error) return showError(els.errorBox, error);
  renderTeams(data || []);
}

function renderTeams(teams) {
  if (teams.length === 0) {
    els.teamsWrap.innerHTML = `<div class="empty-state">No teams yet.</div>`;
    return;
  }
  els.teamsWrap.innerHTML = `
    <table>
      <thead><tr><th>Team</th></tr></thead>
      <tbody>
        ${teams.map((t) => `<tr><td>${escapeHtml(t.name)}</td></tr>`).join("")}
      </tbody>
    </table>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

function renderCallsChart(weekStarts, counts) {
  const w = 300;
  const h = 90;
  const padX = 16;
  const padY = 14;
  const max = Math.max(1, ...counts);
  const stepX = counts.length > 1 ? (w - padX * 2) / (counts.length - 1) : 0;
  const points = counts.map((c, i) => ({
    x: padX + i * stepX,
    y: h - padY - (c / max) * (h - padY * 2),
  }));
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const dots = points.map((p) => `<circle class="profile-chart-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3"></circle>`).join("");
  const labels = weekStarts
    .map((ws, i) => `<text class="profile-chart-label" x="${points[i].x.toFixed(1)}" y="${h - 2}" text-anchor="middle">${fmtShortDate(ws)}</text>`)
    .join("");
  els.callsChart.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}">
      <path class="profile-chart-line" d="${pathD}"></path>
      ${dots}
      ${labels}
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
  els.callsThisWeekText.textContent = `${thisWeekCount} ${thisWeekCount === 1 ? "person" : "people"} called this week`;
  renderCallsChart(weekStarts, counts);
}

loadCallsChart();

els.teamsBtn.addEventListener("click", async () => {
  els.teamsModal.classList.remove("hidden");
  await loadTeams();
});
els.teamsCloseBtn.addEventListener("click", () => {
  els.teamsModal.classList.add("hidden");
});
els.profileSignOutBtn.addEventListener("click", signOut);

wirePageHeaderMenu({ toggleBtn: els.pageMenuToggle, menuEl: els.pageHeaderMenu });
