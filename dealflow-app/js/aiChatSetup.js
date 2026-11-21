// "Claude on the server": shared status helper + the Admin > Settings card with the owner's one-time setup steps.
import { supabase } from "./supabaseClient.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (iso) => { const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };

export async function fetchStatus() {
  const { data, error } = await supabase.rpc("ai_chat_status");
  return error ? { enabled: false, error: error.message } : data || { enabled: false };
}
// green = signed in and online; amber = online but no working Claude login; gray = no worker heartbeat
export function statusInfo(st) {
  const w = st && st.worker;
  if (!w || !w.online) return { k: "off", text: "Offline", detail: w ? `The server last checked in ${ago(w.last_seen)}.` : "The server has not reported in yet." };
  if (!w.auth_ok) return { k: "warn", text: "Claude isn't signed in on the server yet", detail: w.auth_error || "" };
  return { k: "ok", text: "Claude connected", detail: "" };
}

export const TOKEN_CMD = `read -rs T && printf '%s' "$T" | ssh -i ~/Desktop/ssh-key-2026-11-09.key ubuntu@129.146.6.202 "sudo /opt/waystation-ai/set-token.sh"; unset T`;

export function mountAiStatusCard(host) {
  const card = document.createElement("section");
  card.className = "ad-panel ai-card";
  card.innerHTML = `<h3>Claude on the server</h3>
    <p class="ad-muted">Powers the "Edit with Claude" chat in a campaign's review screen. It runs on the company server with the owner's Claude plan; nobody else's login is used.</p>
    <div class="ai-stat" id="aiCardStat" aria-live="polite">Checking...</div>
    <details class="ai-setup" id="aiSetup"><summary>One-time setup (the owner does this once)</summary>
      <ol class="ai-steps">
        <li>On your Mac, open Terminal and run <code>claude setup-token</code>. It needs a Claude Pro or Max plan. Sign in in the browser; it prints a long token.</li>
        <li>Copy the token. Then run this one command, paste the token when nothing seems to happen, and press Return. The token is not shown or saved in your history:
          <pre id="aiCmd">${esc(TOKEN_CMD)}</pre>
          <button type="button" class="btn secondary small" id="aiCopy">Copy command</button></li>
        <li>Wait about 15 seconds. The line above turns green: "Claude connected".</li>
      </ol>
      <p class="ad-muted">To switch the chat off, set <code>ai_chat_enabled</code> to anything but <code>true</code> in app_secrets. Details: docs/AI_WORKER.md.</p>
    </details>`;
  host.appendChild(card);
  const stat = card.querySelector("#aiCardStat");
  card.querySelector("#aiCopy").onclick = async (e) => { try { await navigator.clipboard.writeText(TOKEN_CMD); e.target.textContent = "Copied"; } catch { e.target.textContent = "Select the command and copy it"; } };
  async function refresh() {
    if (!card.isConnected) return clearInterval(timer);
    const st = await fetchStatus(), i = statusInfo(st);
    stat.className = "ai-stat " + i.k;
    stat.innerHTML = `<span class="ai-dot"></span><span><b>${esc(i.text)}</b>${st.enabled ? "" : " (chat is switched off)"}${i.detail ? `<br><small>${esc(i.detail)}</small>` : ""}</span>`;
    if (i.k === "warn") card.querySelector("#aiSetup").open = true;
  }
  const timer = setInterval(refresh, 10000); refresh();
}
