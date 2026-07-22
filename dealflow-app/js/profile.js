import { supabase } from "./supabaseClient.js";
import { requireSession, showError, signOut } from "./auth.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;

const els = {
  errorBox: document.getElementById("errorBox"),
  avatarInitials: document.getElementById("avatarInitials"),
  profileName: document.getElementById("profileName"),
  profileRole: document.getElementById("profileRole"),
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

els.teamsBtn.addEventListener("click", async () => {
  els.teamsModal.classList.remove("hidden");
  await loadTeams();
});
els.teamsCloseBtn.addEventListener("click", () => {
  els.teamsModal.classList.add("hidden");
});
els.profileSignOutBtn.addEventListener("click", signOut);
