// Which accounts a team lead sees. A team lead can lead several teams (profiles.team_id is their primary team,
// team_lead_teams lists the extra ones); profile.team_ids (set in js/auth.js) holds all of them. The pool is every
// intern and independent lead on any of those teams, plus the lead's own account.
import { supabase } from "./supabaseClient.js";

export function teamIdsOf(profile) {
  if (profile?.team_ids?.length) return profile.team_ids;
  return profile?.team_id ? [profile.team_id] : [];
}

export async function loadTeamScopeAccounts(profile) {
  const ids = teamIdsOf(profile);
  if (!ids.length) return [profile];
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, team_id")
    .in("team_id", ids)
    .or(`role.in.(intern,independent_lead),id.eq.${profile.id}`)
    .order("full_name", { ascending: true });
  if (error) return [];
  // The lead's own row carries every team they lead, so Accounts visible can list them under each team.
  return (data || []).map((r) => (r.id === profile.id ? { ...r, team_ids: ids } : r));
}

// Team leads over more than one team get Accounts visible grouped by team, like admins.
export const groupsByTeam = (profile, isAdmin) => !!isAdmin || teamIdsOf(profile).length > 1;

// The team lead who leads `teamId`: the one whose primary team it is, else one who leads it as an extra team.
export async function findTeamLead(teamId, columns = "id, email, calendly_link") {
  if (!teamId) return null;
  const { data: primary } = await supabase.from("profiles").select(columns).eq("team_id", teamId).eq("role", "team_lead").limit(1);
  if (primary?.length) return primary[0];
  const { data: extra } = await supabase.from("team_lead_teams").select("profile_id").eq("team_id", teamId).limit(1);
  if (!extra?.length) return null;
  const { data: lead } = await supabase.from("profiles").select(columns).eq("id", extra[0].profile_id).eq("role", "team_lead").maybeSingle();
  return lead || null;
}
