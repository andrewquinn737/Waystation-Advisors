// TEST CALL LOCK. On any project that is not the live one, outbound calling may reach ONLY the numbers in
// the TEST_CALL_ALLOWLIST env secret (comma-separated E.164). Fail-closed: not live + secret unset = nothing allowed.
// Live (SUPABASE_URL contains the live ref) is never restricted by this file.
export const LIVE_REF = "jabjrhkhnbabfihodqie";
export const TEST_CALL_MSG = "Test app: calls limited to the test number";
const digits = (s: string) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
// TEST_CALL_FREE_USERS (comma-separated user ids, TEST only): people piloting the new CRM with real leads, whose calls
// are not limited to the allowlist. Everyone else on TEST stays locked.
export function callAllowed(to: string, userId?: string | null): boolean {
  if ((Deno.env.get("SUPABASE_URL") || "").includes(LIVE_REF)) return true;
  const free = (Deno.env.get("TEST_CALL_FREE_USERS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (userId && free.includes(userId)) return true;
  const allow = (Deno.env.get("TEST_CALL_ALLOWLIST") || "").split(",").map(digits).filter(Boolean);
  return allow.includes(digits(to));
}
