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
// Read the cached stats first (fast), then ask the server to refresh them in the background and redraw only if something changed.
async function load() {
  $("cpList").innerHTML = `<p class="ad-empty">Loading...</p>`;
  const { data, error } = await supabase.rpc("admin_campaigns", { p_fresh: false });
  if (error) { $("cpList").innerHTML = ""; msg("Couldn't load campaigns: " + error.message + " "); return retryLink(); }
  msg(""); camps = data || []; render();
  supabase.rpc("admin_campaigns", { p_fresh: true }).then(({ data: fresh, error: e2 }) => {
    if (e2 || !fresh || !$("cpList") || JSON.stringify(fresh) === JSON.stringify(camps)) return;
    camps = fresh; if (!menuEl) render();
  });
}
function retryLink() { const el = $("cpMsg"), b = document.createElement("button"); b.type = "button"; b.className = "ad-link"; b.textContent = "Retry"; b.onclick = load; el.appendChild(b); }

const STATS = [["emails_sent", "Emails sent"], ["contacted", "Contacted"], ["replied", "Replied"], ["interested", "Interested"], ["intro_calls", "Intro calls"], ["bounced", "Bounced"]];
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
  if (c.status === "paused") return `<span class="warn">Paused${c.paused_reason ? ": " + esc(c.paused_reason) : ""}. Nothing is sent until you resume.</span>`;
  if (c.status === "draft" && !c.has_spintax) return `No emails yet. Design them in Claude.`;
  if (c.status === "ready") return c.launched_at ? `${plural(n.ready, "email is", "emails are")} waiting because copy changed after launch. Launch again to send ${n.ready === 1 ? "it" : "them"}.` : `${plural(n.ready, "email is", "emails are")} ready to launch.`;
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
    <div class="cp-status"><span class="cp-pill ${esc(c.status)}">${CHIP[c.status] || ""}</span></div>
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
  if (a === "launch") return openLaunch(c);
  if (a === "design") return designInClaude(c, el);
  if (a === "pause" && !(await confirmBox({ title: "Pause this campaign?", body: "Nothing more is sent until you resume. Emails already queued for later are taken back out of the queue.", yes: "Pause" }))) return;
  b.disabled = true;
  const { error } = a === "pause" ? await supabase.rpc("campaign_pause", { p_list: c.list_id, p_reason: "Paused by admin" }) : await supabase.rpc("campaign_resume", { p_list: c.list_id });
  if (error) msg(error.message); else msg("");
  load();
}

// ---- list details sheet ---------------------------------------------------------------------------------------------
async function openDetails(c) {
  const sheet = document.createElement("div");
  sheet.className = "ad-sheet-bd";
  sheet.innerHTML = `<div class="ad-sheet" role="dialog" aria-label="List details"><div class="ad-sheet-main"><h2>${esc(c.name || "(untitled)")}</h2><div id="adDet"><p class="ad-muted">Loading...</p></div></div>
    <a class="btn" id="adOpen" href="dials.html?list=${encodeURIComponent(c.list_id)}">Open list on Calls</a><button type="button" class="btn secondary" id="adCancel">Close</button></div>`;
  document.body.appendChild(sheet);
  const close = () => sheet.remove();
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  sheet.querySelector("#adCancel").onclick = close;
  const count = (f) => { let qy = supabase.from("dials").select("id", { count: "exact", head: true }).eq("list_id", c.list_id); return f(qy).then((r) => r.count ?? 0); };
  const [withEmail, held, queue, lst] = await Promise.all([
    count((qy) => qy.not("email", "is", null).neq("email", "")),
    Promise.resolve(c.counts.need_fix ?? 0),
    c.owner_id ? supabase.rpc("email_queue_status", { p_owner: c.owner_id }).then((r) => (Array.isArray(r.data) ? r.data[0] : r.data)) : Promise.resolve(null),
    supabase.from("dial_lists").select("buyer_id").eq("id", c.list_id).maybeSingle().then((r) => r.data),
  ]);
  let buyer = "";
  if (lst?.buyer_id) buyer = (await supabase.from("profiles").select("full_name").eq("id", lst.buyer_id).maybeSingle()).data?.full_name || "";
  const boxes = queue?.mailboxes || [];
  const boxHtml = boxes.length ? boxes.map((m) => `<li>${esc(m.address)} <span class="ad-muted">${Math.max(0, (m.cap ?? 0) - (m.used ?? 0))} of ${m.cap ?? 0} left today</span></li>`).join("") : `<li class="ad-muted">None yet. Add one under Email accounts.</li>`;
  const n = c.counts, dl = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  sheet.querySelector("#adDet").innerHTML = `<dl class="cp-det">
      ${dl("Owner", esc(c.owner || "Unknown"))}${dl("Mandate", esc(MANDATE[c.mandate] || "Not set"))}${dl("Buyer", esc(buyer || "None"))}${dl("Uploaded", esc(day(c.created_at)))}
      ${dl("Leads", n.leads?.toLocaleString?.() ?? n.leads)}${dl("With email", withEmail.toLocaleString())}${dl("Backup (calls only)", (n.backup ?? 0).toLocaleString())}${dl("Held for edits", held.toLocaleString())}
    </dl><h3 class="cp-det-h">Sending mailboxes${queue ? ` \u00b7 ${queue.remaining_today ?? 0} of ${queue.capacity_today ?? 0} sends left today` : ""}</h3><ul class="cp-det-boxes">${boxHtml}</ul>`;
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
