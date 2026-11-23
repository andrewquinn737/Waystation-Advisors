// TEST-project call lock (client half). The server decides: rpc test_call_policy() returns null on the live
// project (no restriction) and {allow:[...]} on a test project. The real enforcement is server-side
// (telnyx-token, telnyx-webhook, calls insert trigger); this stops the phone's own tel: dialer too.
import { supabase } from "./supabaseClient.js";
import { showNotice } from "./notice.js";
export const TEST_CALL_MSG = "Test app: calls limited to the test number";
const dg = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
let policy;
async function getPolicy() {
  if (policy !== undefined) return policy;
  try { const { data, error } = await supabase.rpc("test_call_policy"); policy = error ? null : (data || null); } catch { policy = null; }
  return policy;
}
export async function callBlocked(phone) {
  const p = await getPolicy();
  if (!p || p.free) return false; // live, or a pilot user allowed to call real numbers on TEST
  if ((p.allow || []).map(dg).includes(dg(phone))) return false;
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
