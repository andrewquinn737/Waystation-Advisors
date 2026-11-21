// Admin > Settings: connect Claude (setup guide + link status), time zone.
import { mountClaudeConnect } from "./claudeConnect.js";
import { openOnboarding } from "./adminOnboarding.js";
import { mountAiStatusCard } from "./aiChatSetup.js";

export function initSettings(profile) {
  const host = document.getElementById("adSettings");
  host.innerHTML = `<section class="ad-panel"><h3>Claude setup guide</h3>
      <p class="ad-muted">Campaigns are designed in your own Claude app with the Waystation CRM connector. The CRM never stores your Claude login. A chat inside this page comes later.</p>
      <div class="ad-row"><button type="button" class="btn secondary" id="adWizard">Open setup guide</button></div></section>
    <div id="adConnectHost"></div>
    <div id="adAiHost"></div>
    <section class="ad-panel"><h3>Time zone</h3>
      <p class="ad-muted" id="adTz"></p></section>`;
  const tz = profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "this device's time zone";
  document.getElementById("adTz").textContent = `${tz} (set automatically). Emails send 8:30am to 5pm weekdays in each list owner's time zone.`;
  mountClaudeConnect(document.getElementById("adConnectHost"), { profile });
  mountAiStatusCard(document.getElementById("adAiHost"));
  document.getElementById("adWizard").onclick = () => openOnboarding(profile, { manual: true });
}
