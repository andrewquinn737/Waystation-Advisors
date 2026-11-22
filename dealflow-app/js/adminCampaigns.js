// Admin > Campaigns: one table row per email list (cards on phones). Design in Claude, Review, Launch / Pause / Resume.
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

const STATS = [["emails_sent", "Emails sent"], ["contacted", "Contacted"], ["replied", "Replied"], ["interested", "Interested"], ["intro_calls", "Intro calls"], ["bounced", "Bounced"]];
const statCells = (n) => STATS.map(([k, label]) => { const v = n[k] ?? 0; return `<div class="cp-n${v ? "" : " zero"}" title="${label}"><b>${v.toLocaleString()}</b><span>${label}</span></div>`; }).join("");
export const designPrompt = (c) => `Use the Waystation CRM connector: design_campaign for list ${c.name} (list_id ${c.list_id})`;

function totals() {
  const t = {};
  for (const [k] of STATS) t[k] = camps.reduce((s, c) => s + (c.counts?.[k] ?? 0), 0);
  return t;
}
function hint(c) {
  const n = c.counts;
  if (c.status === "done") return "";
  if (!c.mailboxes) return `<span class="warn">${esc(c.owner || "The owner")} has no sending mailbox yet. Add one under Email accounts before launching.</span>`;
  if (c.status === "paused") return `<span class="warn">Paused${c.paused_reason ? ": " + esc(c.paused_reason) : ""}. Nothing is sent until you resume.</span>`;
  if (c.status === "draft" && !c.has_spintax) return `No emails yet. Design them in Claude.`;
  if (c.status === "ready") return c.launched_at ? `${plural(n.ready, "email is", "emails are")} waiting because copy changed after launch. Launch again to send ${n.ready === 1 ? "it" : "them"}.` : `${plural(n.ready, "email is", "emails are")} ready to launch.`;
  return "";
}
function row(c) {
  const n = c.counts, live = c.status === "live", paused = c.status === "paused", canLaunch = n.ready > 0 && !paused;
  const sub = [c.owner || "Unknown owner", "Uploaded " + day(c.created_at), MANDATE[c.mandate] || ""].filter(Boolean).join(" \u00b7 ");
  // One primary action per row; everything else sits in the overflow menu.
  const all = [
    canLaunch ? ["launch", `${c.launched_at ? "Launch again " : "Launch "}${n.ready}`] : null,
    paused ? ["resume", "Resume"] : null,
    c.status !== "done" ? ["design", "Design in Claude"] : null,
    n.ready + n.need_fix > 0 ? ["review", "Review emails"] : null,
    live ? ["pause", "Pause"] : null,
  ].filter(Boolean);
  const pick = canLaunch ? "launch" : paused ? "resume" : all.find(([a]) => a === "review") && n.need_fix > 0 ? "review" : c.status === "draft" ? "design" : "";
  const main = all.find(([a]) => a === pick), rest = all.filter(([a]) => a !== pick);
  const held = n.need_fix > 0 ? `<span class="warn">${plural(n.need_fix, "email needs", "emails need")} edits <button type="button" class="ad-link" data-a="review">Review</button></span>` : "";
  const note = [hint(c), held].filter(Boolean).join(" ");
  return `<article class="cp-row" data-id="${esc(c.list_id)}">
    <div class="cp-name"><b title="${esc(c.name || "")}">${esc(c.name || "(untitled)")}</b><span>${esc(sub)}</span></div>
    <div class="cp-status"><span class="cp-pill ${esc(c.status)}">${CHIP[c.status] || ""}</span></div>
    ${statCells(n)}
    <div class="cp-act">${main ? `<button type="button" class="btn small" data-a="${main[0]}">${main[1]}</button>` : ""}
      ${rest.length ? `<div class="cp-menu-wrap"><button type="button" class="cp-more" data-menu aria-label="More actions" aria-haspopup="menu" aria-expanded="false">&#8943;</button><div class="cp-menu hidden" role="menu">${rest.map(([a, l]) => `<button type="button" role="menuitem" data-a="${a}">${l}</button>`).join("")}</div></div>` : ""}</div>
    <div class="cp-note${note ? "" : " hidden"}">${note}</div></article>`;
}
function render() {
  const open = camps.filter((c) => c.status !== "done"), done = camps.filter((c) => c.status === "done");
  $("cpSummary").textContent = "";
  const t = totals();
  const total = `<div class="cp-row cp-total"><div class="cp-name"><b>All campaigns</b><span>${open.length} in progress${done.length ? `, ${done.length} finished` : ""}</span></div><div class="cp-status"></div>${statCells(t)}<div class="cp-act"></div></div>`;
  const shown = showDone ? camps : open;
  $("cpList").innerHTML = shown.length ? `<div class="cp-head" aria-hidden="true"><div>Campaign</div><div>Status</div>${STATS.map(([, l]) => `<div class="num">${l === "Emails sent" ? "Sent" : l}</div>`).join("")}<div></div></div>${total}${shown.map(row).join("")}` : `<p class="ad-empty">${camps.length ? "Nothing in progress." : "No campaigns yet. One appears here as soon as a list with email leads is uploaded."}</p>`;
  $("cpList").classList.toggle("cp-table", !!shown.length);
  const tg = $("cpToggleDone"); tg.classList.toggle("hidden", !done.length); tg.textContent = showDone ? "Hide finished" : `Show finished (${done.length})`;
}

function closeMenus() { document.querySelectorAll(".cp-menu:not(.hidden)").forEach((m) => { m.classList.add("hidden"); m.previousElementSibling?.setAttribute("aria-expanded", "false"); }); }
document.addEventListener("click", (e) => { if (!e.target.closest(".cp-menu-wrap")) closeMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

async function onClick(e) {
  const menuBtn = e.target.closest("[data-menu]");
  if (menuBtn) { const m = menuBtn.nextElementSibling, was = !m.classList.contains("hidden"); closeMenus(); if (!was) { m.classList.remove("hidden"); menuBtn.setAttribute("aria-expanded", "true"); } return; }
  const b = e.target.closest("[data-a]"), el = e.target.closest(".cp-row"); if (!b || !el) return;
  closeMenus();
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
  const slot = el.querySelector(".cp-note");
  slot.classList.remove("hidden");
  slot.innerHTML = `Opened Claude with the request${ok ? " (also copied)" : ""}. If it did not fill in, paste: <span class="ad-prompt">${esc(prompt)}</span> Not connected yet? Admin &gt; Settings.`;
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
