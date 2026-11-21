// Calls the copy-gate edge function: the server-side copy check. Only that function can mark copy as
// passed, and only for the exact current text. Returns { summary: {passed, held, started_now}, results: [...] }.
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export async function runCopyGate(listId) {
  const { data: { session } } = await supabase.auth.getSession();
  let res;
  try {
    res = await fetch(SUPABASE_URL + "/functions/v1/copy-gate", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + (session?.access_token || "") },
      body: JSON.stringify({ list_id: listId }),
    });
  } catch {
    throw new Error("Couldn't reach the server to check the emails. Check your connection and try again.");
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(json?.error || `The email check failed (${res.status}).`);
  return json;
}
