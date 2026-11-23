// TEST-project call lock (client half). The server decides: rpc test_call_policy() returns null on the live
// project (no restriction) and {free, allow} on a test project (allow is only filled in for admins). Everyone else asks
// test_call_allowed(number), so the allowlisted number is never handed to every signed-in user. The real enforcement is
// server-side (telnyx-token, telnyx-webhook, calls insert trigger); this stops the phone's own tel: dialer too.
// If the check itself fails on a TEST page, the call is blocked (fail closed) and the failure is not remembered.
import { supabase } from "./supabaseClient.js";
import { APP_ENV } from "./config.js";
import { showNotice } from "./notice.js";
export const TEST_CALL_MSG = "Test app: calls limited to the test number";
const dg = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
let policy;
async function getPolicy() {
  if (policy !== undefined) return policy;
  try {
    const { data, error } = await supabase.rpc("test_call_policy");
    if (error) throw error;
    policy = data || null;
  } catch {
    return APP_ENV === "test" ? { free: false, failed: true, allow: [] } : null; // not cached: the next call asks again
  }
  return policy;
}
export async function callBlocked(phone) {
  const p = await getPolicy();
  if (!p || p.free) return false; // live, or a pilot user allowed to call real numbers on TEST
  let ok = (p.allow || []).map(dg).includes(dg(phone));
  if (!ok && !p.failed) {
    try { const { data, error } = await supabase.rpc("test_call_allowed", { p_number: String(phone || "") }); ok = !error && data === true; } catch { ok = false; }
  }
  if (ok) return false;
  showNotice(TEST_CALL_MSG, { title: "Test app" });
  return true;
}
if (typeof document !== "undefined") {
  document.addEventListener("click", async (e) => {
    const a = e.target.closest?.('a[href^="tel:"]');
    if (!a || a.dataset.callChecked) return;
    e.preventDefault(); e.stopPropagation();
    if (!(await callBlocked(a.getAttribute("href").slice(4)))) { a.dataset.callChecked = "1"; a.click(); delete a.dataset.callChecked; }
  }, true);
}
