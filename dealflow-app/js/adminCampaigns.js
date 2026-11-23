// Admin > Campaigns: one table row per email list (cards on phones). Design in Claude, Review, Launch / Pause / Resume.
import { supabase } from "./supabaseClient.js";
import { openCopyReview } from "./copyReviewScreen.js";
import { copyText } from "./claudeHelp.js";
import { confirmBox } from "./copyCommon.js";
import { openLaunch, openDetails, plural, day } from "./adminLaunch.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MANDATE = { ma: "M&A", data: "Data" };
const CHIP = { draft: "Draft", ready: "Ready to launch", live: "Running", paused: "Paused", done: "Finished" };
let camps = [], showDone = false, loadedAt = null;

function msg(text, ok = false) { const el = $("cpMsg"); el.textContent = text || ""; el.classList.toggle("hidden", !text); el.classList.toggle("ok", ok); }

export function initCampaigns() {
  $("cpRefresh").onclick = load;
  $("cpToggleDone").onclick = () => { showDone = !showDone; render(); };
  $("cpList").addEventListener("click", onClick);
  load();
}
// Read the cached stats first (fast), then ask the server to refresh them in the background and redraw only if something changed.
async function load() {
  if (!camps.length) $("cpList").innerHTML = `<p class="ad-empty">Loading...</p>`;
  const { data, error } = await supabase.rpc("admin_campaigns", { p_fresh: false });
  if (error) {
    // keep what was loaded: a dropped connection must not wipe the list
    const offline = /fetch|network|offline/i.test(error.message || "") || navigator.onLine === false;
    if (camps.length) msg(`${offline ? "You're offline" : "Couldn't refresh"}. Showing what was loaded at ${loadedAt?.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. `);
    else { $("cpList").innerHTML = ""; msg(offline ? "You're offline. Check your connection. " : "Couldn't load campaigns. Try again. "); }
    return retryLink();
  }
  msg(""); camps = data || []; loadedAt = new Date(); render();
  supabase.rpc("admin_campaigns", { p_fresh: true }).then(({ data: fresh, error: e2 }) => {
    if (e2 || !fresh || !$("cpList") || JSON.stringify(fresh) === JSON.stringify(camps)) return;
    camps = fresh; if (!menuEl) render();
  });
}
function retryLink() { const el = $("cpMsg"), b = document.createElement("button"); b.type = "button"; b.className = "ad-link"; b.textContent = "Retry"; b.onclick = load; el.appendChild(b); }

const STATS = [["emails_sent", "Emails sent"], ["contacted", "Companies emailed"], ["replied", "Replied"], ["interested", "Interested"], ["intro_calls", "Intro calls"], ["bounced", "Bounced"]];
const statCells = (n) => STATS.map(([k, label]) => { const v = n[k] ?? 0; return `<div class="cp-n${v ? "" : " zero"}" title="${label}"><b>${v.toLocaleString()}</b><span>${label}</span></div>`; }).join("");
export const designPrompt = (c) => `Use the Waystation CRM connector: design_campaign for list ${c.name} (list_id ${c.list_id})`;

function totals(list) {
  const t = {};
  for (const [k] of STATS) t[k] = list.reduce((s, c) => s + (c.counts?.[k] ?? 0), 0);
  return t;
}
function hint(c) {
  const n = c.counts;
  if (c.status === "done") return "";
  if (!c.mailboxes) return `<span class="warn">${esc(c.owner || "The owner")} has no sending mailbox yet. Add one under Email accounts before launching.</span>`;
  if (c.status === "paused") return `<span class="warn">${c.bounce_paused ? "Paused: " + esc(String(c.paused_reason || "bounce rate").replace(/^Auto-paused:\s*/i, "")) : "Paused" + (c.paused_reason ? ": " + esc(c.paused_reason) : "")}. Nothing is sent until you resume.</span>`;
  if (c.status === "draft" && !c.has_spintax && !n.ready && !n.need_fix) return `No emails yet. Design them in Claude.`;
  if (n.started > 0 && n.ready > 0) return n.copy_changed > 0 ? `${plural(n.ready, "email is", "emails are")} waiting because copy changed after launch. Launch again to send ${n.ready === 1 ? "it" : "them"}.` : `${plural(n.ready, "more email is", "more emails are")} ready. ${n.active} running.`;
  if (c.status === "ready") return `${plural(n.ready, "email is", "emails are")} ready to launch.`;
  return "";
}
function row(c) {
  const n = c.counts, paused = c.status === "paused", canLaunch = n.ready > 0 && !paused, noMailbox = !c.mailboxes;
  const sub = [c.owner || "Unknown owner", "Uploaded " + day(c.created_at), MANDATE[c.mandate] || ""].filter(Boolean).join(" \u00b7 ");
  // One primary action per row; the "..." menu holds the rest (see menuItems).
  const pick = canLaunch ? ["launch", `${c.launched_at ? "Launch again " : "Launch "}${n.ready}`, noMailbox] : paused ? ["resume", "Resume"]
    : n.need_fix > 0 ? ["review", "Review emails"] : c.status === "draft" ? ["design", "Design in Claude"] : null;
  const held = n.need_fix > 0 ? `<span class="warn">${plural(n.need_fix, "email needs", "emails need")} edits <button type="button" class="ad-link" data-a="review">Review</button></span>` : "";
  const note = [hint(c), held].filter(Boolean).join(" ");
  return `<article class="cp-row" data-id="${esc(c.list_id)}">
    <div class="cp-name"><b title="${esc(c.name || "")}">${esc(c.name || "(untitled)")}</b><span>${esc(sub)}</span></div>
    <div class="cp-status"><span class="cp-pill ${esc(c.status)}">${CHIP[c.status] || ""}</span>${c.status === "live" && n.ready > 0 ? `<span class="cp-sub">${n.started} of ${n.started + n.ready + n.need_fix} started</span>` : ""}</div>
    ${statCells(n)}
    <div class="cp-act${pick ? "" : " cp-act-solo"}">${pick ? `<button type="button" class="btn small" data-a="${pick[0]}"${pick[2] ? ` disabled title="Add a sending mailbox under Email accounts first"` : ""}>${pick[1]}</button>` : "<span></span>"}
      <button type="button" class="cp-more" data-menu aria-label="More actions" aria-haspopup="menu" aria-expanded="false">&#8943;</button></div>
    <div class="cp-note${note ? "" : " hidden"}">${note}</div></article>`;
}
// Menu items for a campaign: details first, then what can be done now.
// Launch is never here: the primary button on the row is Launch whenever launching is possible.
function menuItems(c) {
  const n = c.counts, paused = c.status === "paused", live = c.status === "live";
  return [
    ["details", "List details"],
    n.ready + n.need_fix > 0 ? ["review", "Review emails"] : null,
    paused ? ["resume", "Resume"] : null,
    live ? ["pause", "Pause"] : null,
    c.status !== "done" ? ["design", "Design in Claude"] : null,
  ].filter(Boolean);
}
function render() {
  const open = camps.filter((c) => c.status !== "done"), done = camps.filter((c) => c.status === "done");
  $("cpSummary").textContent = "";
  const shown = showDone ? camps : open;
  const t = totals(shown); // the totals row adds up exactly the rows on screen
  const total = `<div class="cp-row cp-total"><div class="cp-name"><b>${showDone ? "All campaigns" : "In progress"}</b><span>${plural(shown.length, "campaign", "campaigns")} shown${!showDone && done.length ? `, ${done.length} finished hidden` : ""}</span></div><div class="cp-status"></div>${statCells(t)}<div class="cp-act"></div></div>`;
  $("cpList").innerHTML = shown.length ? `<div class="cp-head" aria-hidden="true"><div>Campaign</div><div>Status</div>${STATS.map(([, l]) => `<div class="num">${l === "Emails sent" ? "Sent" : l}</div>`).join("")}<div></div></div>${total}${shown.map(row).join("")}` : `<p class="ad-empty">${camps.length ? "Nothing in progress." : "No campaigns yet. One appears here as soon as a list with email leads is uploaded."}</p>`;
  $("cpList").classList.toggle("cp-table", !!shown.length);
  const tg = $("cpToggleDone"); tg.classList.toggle("hidden", !done.length); tg.textContent = showDone ? "Hide finished" : `Show finished (${done.length})`;
}

// One floating menu on <body>, positioned from the button (fixed), so no table / card overflow can clip it.
let menuEl = null, menuBtn = null;
function closeMenus() { menuEl?.remove(); menuEl = null; menuBtn?.setAttribute("aria-expanded", "false"); menuBtn = null; }
function openMenu(btn, c) {
  closeMenus();
  menuBtn = btn; btn.setAttribute("aria-expanded", "true");
  menuEl = document.createElement("div");
  menuEl.className = "cp-menu"; menuEl.setAttribute("role", "menu"); menuEl.dataset.id = c.list_id;
  menuEl.innerHTML = menuItems(c).map(([a, l]) => `<button type="button" role="menuitem" data-a="${a}">${l}</button>`).join("");
  document.body.appendChild(menuEl);
  const r = btn.getBoundingClientRect(), mw = menuEl.offsetWidth, mh = menuEl.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  menuEl.style.left = Math.max(8, Math.min(r.right - mw, vw - mw - 8)) + "px";
  menuEl.style.top = (r.bottom + 4 + mh > vh - 8 ? Math.max(8, r.top - 4 - mh) : r.bottom + 4) + "px";
  menuEl.querySelector("button")?.focus();
}
document.addEventListener("click", (e) => { if (menuEl && !e.target.closest(".cp-menu, [data-menu]")) closeMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
window.addEventListener("resize", closeMenus);
window.addEventListener("scroll", closeMenus, true);

async function onClick(e) {
  const menuBtnEl = e.target.closest("[data-menu]");
  if (menuBtnEl) {
    const c = camps.find((x) => x.list_id === menuBtnEl.closest(".cp-row")?.dataset.id);
    if (c) { if (menuBtn === menuBtnEl) closeMenus(); else openMenu(menuBtnEl, c); }
    return;
  }
  const b = e.target.closest("[data-a]"), el = e.target.closest(".cp-row"); if (!b || !el) return;
  runAction(b, el.dataset.id, el);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".cp-menu [data-a]"); if (!b) return;
  const id = b.closest(".cp-menu").dataset.id; closeMenus();
  runAction(b, id, document.querySelector(`.cp-row[data-id="${id}"]`));
});
async function runAction(b, listId, el) {
  closeMenus();
  const c = camps.find((x) => x.list_id === listId); if (!c) return;
  const a = b.dataset.a;
  if (a === "details") return openDetails(c);
  if (a === "review") return openCopyReview({ id: c.list_id, name: c.name }, { all: true, onChanged: load });
  if (a === "launch") return openLaunch(c, load);
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
