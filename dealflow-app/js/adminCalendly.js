// Admin > Settings: "Connect Calendly". Automatic booking (the schedule-intro-call function) stays OFF until an admin pastes a Calendly
// personal access token here. Until then the intro-call flow works by hand: Calendly popup or "Enter the time myself".
// The token is write-only from the browser: it is stored by an admin-only RPC and never read back.
import { supabase } from "./supabaseClient.js";
import { friendlyMessage } from "./netError.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function mountCalendlyConnect(host) {
  if (!host) return;
  host.innerHTML = `<section class="ad-panel"><h3>Connect Calendly</h3><p class="ad-muted">Loading...</p></section>`;
  const { data: st, error } = await supabase.rpc("calendly_status");
  const panel = host.querySelector(".ad-panel");
  if (error) { panel.innerHTML = `<h3>Connect Calendly</h3><p class="ad-muted">Couldn't read the Calendly setting. ${esc(friendlyMessage(error))} <button type="button" class="ad-link" id="cdlyRetry">Retry</button></p>`; panel.querySelector("#cdlyRetry").onclick = () => mountCalendlyConnect(host); return; }
  const on = !!st?.connected;
  panel.innerHTML = `<h3>Connect Calendly <span class="ad-pill ${on ? "ok" : ""}" id="cdlyState">${on ? "Connected" : "Not connected"}</span></h3>
    <p class="ad-muted">${on
      ? "Automatic booking is on: the app can book the intro call in Calendly for you once the time is entered."
      : "Automatic booking is off. Intro calls are booked by hand (the Calendly popup or entering the time yourself) and everything else in the app already works. To turn automatic booking on, paste a Calendly personal access token and the event type link below."}</p>
    <label for="cdlyToken">Personal access token</label>
    <input id="cdlyToken" type="password" autocomplete="off" placeholder="${st?.has_token ? "Saved (paste a new one to replace it)" : "Paste token"}" />
    <label for="cdlyUri">Event type link (https://api.calendly.com/event_types/...)</label>
    <input id="cdlyUri" type="text" autocomplete="off" value="${esc(st?.event_type_uri || "")}" placeholder="https://api.calendly.com/event_types/XXXXXXXX" />
    <div class="ad-row"><button type="button" class="btn" id="cdlySave">Save</button>
      ${on || st?.has_token ? `<button type="button" class="btn secondary" id="cdlyOff">Disconnect</button>` : ""}</div>
    <div class="error-msg hidden" id="cdlyErr"></div>`;
  const err = panel.querySelector("#cdlyErr");
  const show = (m) => { err.textContent = m; err.classList.remove("hidden"); };
  panel.querySelector("#cdlySave").onclick = async () => {
    err.classList.add("hidden");
    const token = panel.querySelector("#cdlyToken").value.trim();
    const uri = panel.querySelector("#cdlyUri").value.trim();
    if (!token && !st?.has_token) return show("Paste the Calendly token first.");
    if (uri && !/^https:\/\/api\.calendly\.com\/event_types\/[\w-]+/.test(uri)) return show("The event type link should look like https://api.calendly.com/event_types/XXXXXXXX.");
    const { error: e } = await supabase.rpc("calendly_connect", { p_token: token, p_event_type_uri: uri });
    if (e) return show(friendlyMessage(e));
    mountCalendlyConnect(host);
  };
  const off = panel.querySelector("#cdlyOff");
  if (off) off.onclick = async () => { const { error: e } = await supabase.rpc("calendly_disconnect"); if (e) return show(friendlyMessage(e)); mountCalendlyConnect(host); };
}
