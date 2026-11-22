// First-run wizard for admins: 1 Connect your Claude, 2 Test connection, 3 How campaigns work.
// Opens by itself the first time an admin opens the app (profiles.onboarding_done_at is empty); also from Admin > Settings.
// Nobody is asked to paste a Claude token: the wizard only makes the CRM's own connector link.
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL } from "./config.js";
import { copyText } from "./claudeHelp.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SKIP_KEY = "ws_onboarding_skip";
let open = false;

export async function maybeShowOnboarding(profile) {
  if (!profile || profile.role !== "admin" || open) return;
  try { if (sessionStorage.getItem(SKIP_KEY)) return; } catch { /* private mode: just show it */ }
  const { data, error } = await supabase.rpc("onboarding_status");
  if (error || data) return;
  openOnboarding(profile);
}

function ensureCss() {   // the wizard can open on any page, so it brings its own styles
  if (document.getElementById("adminCss")) return;
  const l = document.createElement("link"); l.id = "adminCss"; l.rel = "stylesheet"; l.href = "css/admin.css?v=6"; document.head.appendChild(l);
}

export function openOnboarding(profile, { manual = false } = {}) {
  if (open) return;
  open = true; ensureCss();
  let step = 1, link = null, startedAt = new Date(), timer = null, used = false;
  const wrap = document.createElement("div");
  wrap.className = "ad-wiz";
  document.body.appendChild(wrap);
  const onKey = (e) => { if (e.key === "Escape") { if (!manual) { try { sessionStorage.setItem(SKIP_KEY, "1"); } catch { /* ignore */ } } close(); } };
  const close = () => { clearInterval(timer); document.removeEventListener("keydown", onKey); wrap.remove(); open = false; };
  document.addEventListener("keydown", onKey);
  const dots = () => `<div class="ad-dots">${[1, 2, 3].map((i) => `<i class="${i <= step ? "on" : ""}"></i>`).join("")}</div>`;

  function view() {
    clearInterval(timer);
    if (step === 1) {
      wrap.innerHTML = `<div class="ad-wiz-card" role="dialog" aria-label="Connect your Claude">${dots()}<h2>Connect your Claude</h2>
        <p class="ad-muted">Claude writes the campaign emails for you. The CRM checks every one before it can send.</p>
        ${link ? `<p class="ad-note warn">Treat this link like a password. It is shown once.</p><input type="text" class="ad-url" id="wizUrl" readonly value="${esc(link)}" aria-label="Your connector link" />
          <div class="ad-row"><button type="button" class="btn" id="wizCopy">Copy link</button></div>`
          : `<div class="ad-row"><button type="button" class="btn" id="wizMake">Create my Claude link</button></div>`}
        <ol><li>Open <b>Claude</b> &gt; <b>Settings</b> &gt; <b>Connectors</b>.</li><li>Choose <b>Add custom connector</b> and name it <b>Waystation CRM</b>.</li><li>Paste the link and save.</li></ol>
        <div class="ad-err" id="wizErr"></div>
        <div class="ad-wiz-foot"><button type="button" class="btn secondary" id="wizSkip">${manual ? "Close" : "Not now"}</button><button type="button" class="btn" id="wizNext" ${link ? "" : "disabled"}>Next</button></div></div>`;
      const make = wrap.querySelector("#wizMake");
      if (make) make.onclick = async () => {
        make.disabled = true; make.textContent = "Working...";
        const { data, error } = await supabase.rpc("create_claude_connector_token", { p_label: "Claude" });
        if (error) { wrap.querySelector("#wizErr").textContent = "Could not make the link: " + error.message; make.disabled = false; make.textContent = "Create my Claude link"; return; }
        link = `${SUPABASE_URL}/functions/v1/claude-connector/mcp/${data}`; startedAt = new Date(); view();
      };
      const cp = wrap.querySelector("#wizCopy"); if (cp) cp.onclick = async () => { cp.textContent = (await copyText(link)) ? "Copied" : "Select the link and copy it"; };
      wrap.querySelector("#wizNext").onclick = () => { step = 2; view(); };
    } else if (step === 2) {
      wrap.innerHTML = `<div class="ad-wiz-card" role="dialog" aria-label="Test connection">${dots()}<h2>Test the connection</h2>
        <p>In Claude, start a new chat and type:</p><p class="ad-prompt"><b>list my campaigns</b></p>
        <p class="${used ? "ad-ok" : "ad-wait"}" id="wizState" aria-live="polite">${used ? "&#10003; Connected. Claude just reached the CRM." : "Waiting for Claude to reach the CRM..."}</p>
        <div class="ad-wiz-foot"><button type="button" class="btn secondary" id="wizBack">Back</button><button type="button" class="btn" id="wizNext">${used ? "Next" : "Skip this check"}</button></div></div>`;
      wrap.querySelector("#wizBack").onclick = () => { step = 1; view(); };
      wrap.querySelector("#wizNext").onclick = () => { step = 3; view(); };
      const poll = async () => {
        const { data } = await supabase.from("claude_connector_tokens").select("last_used_at").eq("profile_id", profile.id).is("revoked_at", null).order("created_at", { ascending: false }).limit(1);
        const t = data?.[0]?.last_used_at;
        if (t && new Date(t) > startedAt && !used) { used = true; clearInterval(timer); view(); }
      };
      poll(); timer = setInterval(poll, 3000);
    } else {
      wrap.innerHTML = `<div class="ad-wiz-card" role="dialog" aria-label="How campaigns work">${dots()}<h2>How campaigns work</h2>
        <ol><li>An intern uploads a list. It shows up in <b>Admin &gt; Campaigns</b> by itself.</li>
          <li>Tap <b>Design in Claude</b>. Claude writes the emails; the CRM checks every one against the house rules.</li>
          <li>You read the result, tap <b>Launch</b>, and can <b>Pause</b> any time.</li></ol>
        <p class="ad-muted">You design in your own Claude app. A campaign's review screen also has an "Edit with Claude" chat once the Claude server is connected (Admin &gt; Settings).</p>
        <div class="ad-wiz-foot"><button type="button" class="btn secondary" id="wizBack">Back</button><button type="button" class="btn" id="wizGo">Go to Campaigns</button></div></div>`;
      wrap.querySelector("#wizBack").onclick = () => { step = 2; view(); };
      wrap.querySelector("#wizGo").onclick = async () => {
        await supabase.rpc("onboarding_complete", { p_done: true });
        close();
        if (!/admin\.html$/.test(location.pathname) || location.hash !== "#campaigns") location.href = "admin.html#campaigns";
      };
    }
    const skip = wrap.querySelector("#wizSkip");
    if (skip) skip.onclick = () => { if (!manual) { try { sessionStorage.setItem(SKIP_KEY, "1"); } catch { /* ignore */ } } close(); };
  }
  view();
}
