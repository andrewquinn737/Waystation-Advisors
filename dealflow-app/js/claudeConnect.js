// Profile > "Connect Claude" card: creates a personal connector link (shown once), shows status of the
// existing one (never the token), regenerate and disconnect.
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL } from "./config.js";
import { escapeHtml } from "./clientForm.js";
import { $, msg, confirmBox } from "./copyCommon.js";
import { copyText } from "./claudeHelp.js";

const when = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); };
export const connectorUrl = (token) => `${SUPABASE_URL}/functions/v1/claude-connector/mcp/${token}`;

const STEPS = `<ol class="cc-steps"><li>In claude.ai or Claude Desktop, go to <b>Settings &gt; Connectors</b>.</li>
  <li>Choose <b>Add custom connector</b> and name it <b>Waystation CRM</b>.</li><li>Paste the link above and save.</li></ol>`;

export function mountClaudeConnect(host, { profile }) {
  const card = $(`<section class="cc-card" id="claudeConnectCard"><h3>Connect Claude</h3>
    <p>Let Claude see and rewrite your own held email drafts. Its rewrites must pass the same checks before they save.</p>
    <div class="cc-body"><div class="help-text">Loading...</div></div></section>`);
  host.appendChild(card);
  const bodyEl = card.querySelector(".cc-body");
  let shownToken = null, working = false;

  async function load() {
    const { data, error } = await supabase.from("claude_connector_tokens").select("id, created_at, last_used_at, revoked_at, expires_at")
      .eq("profile_id", profile.id).order("created_at", { ascending: false }).limit(1);
    if (error) { bodyEl.innerHTML = `<div class="error-msg">Could not load your link status: ${escapeHtml(msg(error))}</div><div class="cc-actions"><button type="button" class="btn secondary" data-a="retry">Try again</button></div>`; return; }
    render(data?.[0] || null);
  }

  function render(tok, err = "") {
    const expired = tok && !tok.revoked_at && tok.expires_at && new Date(tok.expires_at) < new Date();
    const live = tok && !tok.revoked_at && !expired;
    let h = err ? `<div class="error-msg">${escapeHtml(err)}</div>` : "";
    if (shownToken) {
      h += `<p class="cc-warn">Treat this link like a password. It is shown only once; anyone with it can read and edit your drafts.</p>
        <input class="cc-url" id="ccUrl" readonly value="${escapeHtml(connectorUrl(shownToken))}" aria-label="Your Claude link" />
        <div class="cc-actions"><button type="button" class="btn" data-a="copy">Copy link</button></div>${STEPS}`;
    }
    if (live) {
      h += `<div class="cc-status">Connected link created ${escapeHtml(when(tok.created_at))} · ${tok.last_used_at ? `last used ${escapeHtml(when(tok.last_used_at))}` : "not used yet"}${tok.expires_at ? ` · expires ${escapeHtml(when(tok.expires_at))}` : ""}</div>
        <div class="cc-actions"><button type="button" class="btn secondary" data-a="regen">Regenerate</button><button type="button" class="btn danger" data-a="disc">Disconnect</button></div>`;
    } else {
      h += `${expired ? `<div class="cc-status">Your link expired ${escapeHtml(when(tok.expires_at))}. Make a new one.</div>` : tok ? `<div class="cc-status">Link revoked ${escapeHtml(when(tok.revoked_at))}.</div>` : ""}${shownToken ? "" : `<div class="cc-actions"><button type="button" class="btn" data-a="create">Create my Claude link</button></div>`}`;
    }
    bodyEl.innerHTML = h;
    bodyEl.querySelectorAll("button").forEach((b) => (b.disabled = working));
  }

  async function act(a, b) {
    if (working) return;
    if (a === "retry") return load();
    if (a === "copy") { const ok = await copyText(connectorUrl(shownToken)); b.textContent = ok ? "Copied" : "Select the link and copy it"; return; }
    if (a === "regen" && !(await confirmBox({ title: "Regenerate your Claude link?", body: "The old link stops working right away. You'll need to paste the new one into Claude.", yes: "Regenerate" }))) return;
    if (a === "disc" && !(await confirmBox({ title: "Disconnect Claude?", body: "Your link stops working right away. You can create a new one any time.", yes: "Disconnect", danger: true }))) return;
    working = true; bodyEl.querySelectorAll("button").forEach((x) => (x.disabled = true)); b.textContent = "Working...";
    let err = "";
    if (a === "disc") {
      const { error } = await supabase.rpc("revoke_claude_connector_tokens");
      if (error) err = msg(error); else shownToken = null;
    } else {
      const { data, error } = await supabase.rpc("create_claude_connector_token", { p_label: "Claude" });
      if (error) err = msg(error); else shownToken = data;
    }
    working = false;
    if (err) { await load(); const e = document.createElement("div"); e.className = "error-msg"; e.textContent = "Could not do that: " + err; bodyEl.prepend(e); return; }
    await load();
  }
  bodyEl.addEventListener("click", (e) => { const b = e.target.closest("button[data-a]"); if (b) act(b.dataset.a, b); });
  load();
}
