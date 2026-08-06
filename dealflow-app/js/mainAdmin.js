import { supabase } from "./supabaseClient.js";

// ---------------------------------------------------------------------------
// "Main admin" = the admin account listed the longest (earliest created_at
// among role = 'admin' profiles) — no separate flag on the row, just derived
// from signup order. Used by:
// - js/profile.js: highlights their card in the Teams popup the same way a
//   team lead's is, and gates the Profile page's Calendly-link section.
// - js/introCall.js: intro-call scheduling routes to their Calendly link for
//   anyone who isn't an intern.
// ---------------------------------------------------------------------------

export async function getMainAdmin() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, calendly_link")
    .eq("role", "admin")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("getMainAdmin failed", error);
    return null;
  }
  return data;
}

// Which Calendly link a given profile's intro-call scheduling should open.
// Admins and team leads (including the main admin themselves) always use
// the main admin's own link. Interns use their own team lead's link,
// falling back to the main admin's if their team lead hasn't set one (or
// they have no team lead at all).
export async function resolveCalendlyLink(profile) {
  const mainAdmin = await getMainAdmin();
  if (profile.role !== "intern") {
    return mainAdmin?.calendly_link || null;
  }
  if (profile.team_id) {
    const { data: lead, error } = await supabase
      .from("profiles")
      .select("calendly_link")
      .eq("team_id", profile.team_id)
      .eq("role", "team_lead")
      .maybeSingle();
    if (!error && lead?.calendly_link) return lead.calendly_link;
  }
  return mainAdmin?.calendly_link || null;
}
