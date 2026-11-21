// Admin > Campaigns: one card per email list. Design in Claude, Review, Launch / Pause / Resume.
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { openCopyReview } from "./copyReviewScreen.js";
import { copyText } from "./claudeHelp.js";
import { confirmBox } from "./copyCommon.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${MON[d.getMonth()]} ${d.getDate()}`; };
const MANDATE = { ma: "M&A", data: "Data" };
const CHIP = { draft: "Draft", ready: "Ready to launch", live: "Running", paused: "Paused", done: "Finished" };
let camps = [], showDone = false;

function msg(text, ok = false) { const el = $("cpMsg"); el.textContent = text || ""; el.classList.toggle("hidden", !text); el.classList.toggle("ok", ok); }

export function initCampaigns() {
  $("cpRefresh").onclick = load;
  $("cpToggleDone").onclick = () => { showDone = !showDone; render(); };
  $("cpList").addEventListener("click", onClick);
  load();
}
async function load() {
  $("cpList").innerHTML = `<p class="ad-empty">Loading...</p>`;
  const { data, error } = await supabase.rpc("admin_campaigns");
  if (error) { $("cpList").innerHTML = ""; msg("Couldn't load campaigns: " + error.message); return; }
  msg(""); camps = data || []; render();
}

const STATS = [["emails_sent", "Emails sent"], ["contacted", "Companies contacted"], ["replied", "Replied"], ["interested", "Interested"], ["intro_calls", "Intro calls booked"], ["bounced", "Bounced"]];
const pct = (n, of) => (of > 0 && n > 0 ? `<small>${Math.round((n / of) * 100)}%</small>` : "");
const statRow = (n, cls = "") => `<div class="ad-stats ${cls}">${STATS.map(([k, label], i) => {
  const v = n[k] ?? 0;
  return `<div class="ad-stat${v ? "" : " zero"}"><b>${v.toLocaleString()}${i > 1 ? pct(v, n.contacted) : ""}</b><span>${label}</span></div>`;
}).join("")}</div>`;
export const designPrompt = (c) => `Use the Waystation CRM connector: design_campaign for list ${c.name} (list_id ${c.list_id})`;

function totals() {
  const t = {};
  for (const [k] of STATS) t[k] = camps.reduce((s, c) => s + (c.counts?.[k] ?? 0), 0);
  return t;
}
function hint(c) {
  const n = c.counts;
  if (!c.mailboxes) return `<p class="ad-note warn">${esc(c.owner || "The owner")} has no sending mailbox yet. Add one under Email accounts before launching.</p>`;
  if (c.status === "paused") return `<p class="ad-note warn">Paused${c.paused_reason ? ": " + esc(c.paused_reason) : ""}. Nothing is sent until you resume.</p>`;
  if (c.status === "draft" && !c.has_spintax) return `<p class="ad-note">No emails yet. Design them in Claude.</p>`;
  if (c.status === "ready") return `<p class="ad-note">${c.launched_at ? `${plural(n.ready, "email is", "emails are")} waiting because copy changed after launch. Launch again to send ${n.ready === 1 ? "it" : "them"}.` : `${plural(n.ready, "email is", "emails are")} ready to launch.`}</p>`;
  return "";
}
function card(c) {
  const n = c.counts, live = c.status === "live", paused = c.status === "paused", canLaunch = n.ready > 0 && !paused;
  const sub = [c.owner || "Unknown owner", "Uploaded " + day(c.created_at), MANDATE[c.mandate] || ""].filter(Boolean).join(" · ");
  const primary = canLaunch ? "launch" : paused ? "resume" : c.status === "draft" ? "design" : "";
  const btn = (a, label) => `<button type="button" class="btn${primary === a ? "" : " secondary"}" data-a="${a}">${label}</button>`;
  const acts = [
    canLaunch ? btn("launch", `${c.launched_at ? "Launch again " : "Launch "}${n.ready}`) : "",
    paused ? btn("resume", "Resume") : "",
    c.status !== "done" ? btn("design", "Design in Claude") : "",
    n.ready + n.need_fix > 0 ? btn("review", "Review emails") : "",
    live ? btn("pause", "Pause") : "",
  ].filter(Boolean);
  const held = n.need_fix > 0 ? `<p class="ad-note warn">${plural(n.need_fix, "email needs", "emails need")} edits <button type="button" class="ad-link" data-a="review">Review</button></p>` : "";
  return `<article class="ad-card" data-id="${esc(c.list_id)}">
    <div class="ad-top"><div class="ad-name">${esc(c.name || "(untitled)")}</div><span class="ad-chip ${esc(c.status)}">${CHIP[c.status] || ""}</span></div>
    <div class="ad-sub">${esc(sub)}</div>
    ${statRow(n)}
    ${hint(c)}${held}<div class="ad-actions">${acts.join("")}</div></article>`;
}
function render() {
  const open = camps.filter((c) => c.status !== "done"), done = camps.filter((c) => c.status === "done");
  $("cpSummary").textContent = camps.length ? `${plural(open.length, "campaign", "campaigns")} in progress${done.length ? `, ${done.length} finished` : ""}.` : "";
  $("cpTotals").innerHTML = camps.length ? `<div class="ad-totals-h">All campaigns</div>${statRow(totals())}` : "";
  $("cpTotals").classList.toggle("hidden", !camps.length);
  const shown = showDone ? camps : open;
  $("cpList").innerHTML = shown.length ? shown.map(card).join("") : `<p class="ad-empty">${camps.length ? "Nothing in progress." : "No campaigns yet. One appears here as soon as a list with email leads is uploaded."}</p>`;
  const t = $("cpToggleDone"); t.classList.toggle("hidden", !done.length); t.textContent = showDone ? "Hide finished" : `Show finished (${done.length})`;
}

async function onClick(e) {
  const b = e.target.closest("[data-a]"), el = e.target.closest(".ad-card"); if (!b || !el) return;
  const c = camps.find((x) => x.list_id === el.dataset.id); if (!c) return;
  const a = b.dataset.a;
  if (a === "review") return openCopyReview({ id: c.list_id, name: c.name }, { all: true, onChanged: load });
  if (a === "launch") return openLaunch(c);
  if (a === "design") return designInClaude(c, el);
  if (a === "pause" && !(await confirmBox({ title: "Pause this campaign?", body: "Nothing more is sent until you resume. Emails already queued for later are taken back out of the queue.", yes: "Pause" }))) return;
  b.disabled = true;
  const { error } = a === "pause" ? await supabase.rpc("campaign_pause", { p_list: c.list_id, p_reason: "Paused by admin" }) : await supabase.rpc("campaign_resume", { p_list: c.list_id });
  if (error) msg(error.message); else msg("");
  load();
}

async function designInClaude(c, el) {
  const prompt = designPrompt(c), ok = await copyText(prompt);
  window.open("https://claude.ai/new?q=" + encodeURIComponent(prompt), "_blank", "noopener");
  el.querySelector(".ad-design-note")?.remove();
  el.querySelector(".ad-actions").insertAdjacentHTML("beforebegin", `<p class="ad-note ad-design-note">Opened Claude with the request${ok ? " (also copied)" : ""}. If it did not fill in, paste: <span class="ad-prompt">${esc(prompt)}</span> Not connected yet? Admin &gt; Settings.</p>`);
}

// ---- launch sheet (start-emails edge function checks every address first) ----------------------------------------
async function startEmails(listId, count) {
  const { data: { session } } = await supabase.auth.getSession();
  let res;
  try {
    res = await fetch(SUPABASE_URL + "/functions/v1/start-emails", { method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + (session?.access_token || "") },
      body: JSON.stringify({ list_id: listId, count }) });
  } catch { throw new Error("Couldn't reach the server. Check your connection and try again."); }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(json?.error || `Couldn't launch (${res.status}).`);
  return json;
}
function resultSentence(r) {
  const parts = [`${plural(r.started ?? 0, "email", "emails")} started`];
  if (r.moved_to_backup) parts.push(`${r.moved_to_backup} moved to backup after the address check`);
  if (r.held_for_copy) parts.push(`${r.held_for_copy} need edits`);
  if (r.unverified) parts.push(`${r.unverified} couldn't be checked, still ready`);
  let s = parts.join(", ") + ".";
  if (r.remaining_ready) s += ` ${r.remaining_ready} still ready.`;
  if (r.started) s += r.est_days_to_send_firsts > 1 ? ` First emails finish going out in about ${r.est_days_to_send_firsts} business days at this owner's mailbox capacity.` : " First emails go out today or the next business day.";
  return s;
}
function openLaunch(c) {
  const n = c.counts.ready, sheet = document.createElement("div");
  sheet.className = "ad-sheet-bd";
  sheet.innerHTML = `<div class="ad-sheet" role="dialog" aria-label="Launch emails"><div class="ad-sheet-main"><h2>Launch ${esc(c.name)}</h2>
      <p class="ad-muted">${esc(c.owner || "The owner")}'s mailboxes send up to 20 a day each, 8:30am to 5pm their time, a few minutes apart. Addresses are checked first. You can pause any time.</p>
      <div class="ad-row"><button type="button" class="btn" id="adAll">Send all ${n} ready</button></div>
      <label class="ad-lbl" for="adCount">Or send a number</label>
      <div class="ad-num"><input id="adCount" type="number" inputmode="numeric" min="1" max="${n}" placeholder="1 to ${n}" /><button type="button" class="btn secondary" id="adSome">Send</button></div></div>
    <div class="ad-err" id="adErr" role="alert"></div><button type="button" class="btn secondary" id="adCancel">Cancel</button></div>`;
  document.body.appendChild(sheet);
  const q = (s) => sheet.querySelector(s), close = () => sheet.remove();
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  q("#adCancel").onclick = close;
  let busy = false;
  const go = async (count) => {
    if (busy) return; busy = true; q("#adAll").disabled = q("#adSome").disabled = true; q("#adErr").textContent = "";
    q(".ad-sheet-main").insertAdjacentHTML("beforeend", `<p class="ad-muted" id="adWait">Checking addresses and starting...</p>`);
    try {
      const r = await startEmails(c.list_id, count);
      await supabase.rpc("campaign_launched", { p_list: c.list_id });
      q(".ad-sheet-main").innerHTML = `<h2>Launched</h2><p>${esc(resultSentence(r))}</p>`;
      const cancel = q("#adCancel"); cancel.textContent = "OK"; cancel.className = "btn"; load();
    } catch (e) { q("#adWait")?.remove(); q("#adErr").textContent = e.message; q("#adAll").disabled = q("#adSome").disabled = false; busy = false; }
  };
  q("#adAll").onclick = () => go(null);
  q("#adSome").onclick = () => { const v = Math.floor(+q("#adCount").value || 0); if (v < 1 || v > n) { q("#adErr").textContent = `Enter a number from 1 to ${n}.`; return; } go(v); };
}
