import { supabase } from "./supabaseClient.js";

/**
 * Call at the top of every protected page. Redirects to login.html if
 * there's no session, otherwise returns { user, profile }.
 * If teamLeadOnly is true and the signed-in user is an intern, redirects
 * them to profile.html (defense in depth — the database RLS is the real
 * gate, this just avoids showing a page they'd get empty data on).
 */
export async function requireSession({ teamLeadOnly = false } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "login.html";
    return null;
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", session.user.id)
    .single();

  if (error || !profile) {
    console.error("Could not load profile", error);
    window.location.href = "login.html";
    return null;
  }

  if (teamLeadOnly && profile.role !== "team_lead") {
    window.location.href = "profile.html";
    return null;
  }

  renderNav(profile);
  return { user: session.user, profile };
}

export function renderNav(profile) {
  const mount = document.getElementById("topnav");
  if (!mount) return;

  const page = document.body.dataset.page || "";
  const link = (href, label) =>
    `<a href="${href}" class="${page === href ? "active" : ""}">${label}</a>`;

  const financeLink = profile.role === "team_lead" ? link("finance.html", "Finance") : "";

  // Two nav presentations share the same markup pattern: a full top bar
  // (desktop) and a fixed bottom tab bar (mobile — see the max-width:720px
  // media query in css/style.css, which hides one and shows the other).
  mount.innerHTML = `
    <div class="topnav-bar">
      <div class="brand">Waystation Advisors</div>
      <div class="links">
        ${link("profile.html", "Profile")}
        ${link("clients.html", "Clients")}
        ${link("dials.html", "Dials")}
        ${financeLink}
      </div>
      <div class="who">
        <span>${profile.full_name}</span>
        <span class="role-badge">${profile.role === "team_lead" ? "Team Lead" : "Intern"}</span>
        <button class="btn secondary small" id="signOutBtn">Sign out</button>
      </div>
    </div>
    <div class="bottom-tabbar">
      ${link("profile.html", "Profile")}
      ${link("clients.html", "Clients")}
      ${link("dials.html", "Dials")}
      ${financeLink}
      <button type="button" id="bottomSignOutBtn">Sign out</button>
    </div>
  `;

  const doSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "login.html";
  };
  document.getElementById("signOutBtn").addEventListener("click", doSignOut);
  document.getElementById("bottomSignOutBtn").addEventListener("click", doSignOut);
}

export function showError(el, err) {
  if (!el) return;
  el.textContent = err?.message || String(err);
  el.classList.remove("hidden");
}
