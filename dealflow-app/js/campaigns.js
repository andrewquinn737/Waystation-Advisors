// Campaigns (admin only): lists uploaded in the last week (plus anything not launched or still sending).
// Per list: counts, "Review emails" (copy review screen, all drafts) and "Launch" (start-emails edge function).
import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { openCopyReview } from "./copyReviewScreen.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${MON[d.getMonth()]} ${d.getDate()}`; };
const MANDATE = { ma: "M&A", data: "Data" };
const STATUS = { not_launched: "Not launched", sending: "Sending", done: "Done" };

const { profile } = await requireSession();
let lists = [];
if (profile.role !== "admin") $("cpDenied").classList.remove("hidden");
else { $("cpApp").classList.remove("hidden"); load(); }

function msg(text) { const el = $("cpMsg"); el.textContent = text || ""; el.classList.toggle("hidden", !text); }

async function load() {
  $("cpList").innerHTML = `<p class="cp-empty">Loading...</p>`;
  const { data, error } = await supabase.rpc("campaign_overview", { p_days: 7 });
  if (error) { $("cpList").innerHTML = ""; msg("Couldn't load campaigns: " + error.message); return; }
  msg(""); lists = data || []; render();
}

const stat = (label, n) => `<div class="cp-stat${n ? "" : " zero"}"><b>${n}</b><span>${label}</span></div>`;
function card(l) {
  const mand = MANDATE[l.mandate] || "";
  return `<article class="cp-card" data-id="${esc(l.list_id)}">
    <div class="cp-top"><div class="cp-name">${esc(l.name || "(untitled)")}</div><span class="cp-chip ${esc(l.status)}">${STATUS[l.status] || ""}</span></div>
    <div class="cp-sub">${esc([l.owner || "Unknown owner", "Uploaded " + day(l.created_at), mand].filter(Boolean).join(" · "))}</div>
    <div class="cp-stats">${stat("Ready", l.ready)}${stat("Need a fix", l.need_fix)}${stat("Sending", l.active)}${stat("Sent first", l.sent_first)}${stat("Replied", l.replied)}${stat("Bounced", l.bounced)}${stat("Backup #s", l.backup)}</div>
    <div class="cp-actions"><button type="button" class="btn secondary" data-review>Review emails</button>
      <button type="button" class="btn" data-launch${l.ready ? "" : " disabled"}>${l.ready ? `Launch ${l.ready}` : "Nothing to launch"}</button></div>
  </article>`;
}
function render() {
  $("cpSummary").textContent = lists.length ? `${plural(lists.length, "list", "lists")}: uploaded in the last 7 days, plus any not launched or still sending.` : "";
  $("cpList").innerHTML = lists.length ? lists.map(card).join("") : `<p class="cp-empty">No email lists uploaded in the last 7 days, and nothing waiting to launch.</p>`;
}

$("cpRefresh").onclick = load;
$("cpList").addEventListener("click", (e) => {
  const el = e.target.closest(".cp-card"); if (!el) return;
  const l = lists.find((x) => x.list_id === el.dataset.id); if (!l) return;
  if (e.target.closest("[data-review]")) openCopyReview({ id: l.list_id, name: l.name }, { all: true, onChanged: load });
  else if (e.target.closest("[data-launch]")) openLaunch(l);
});

// ---- Launch sheet ------------------------------------------------------------------------------------------------
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
  if (r.held_for_copy) parts.push(`${r.held_for_copy} need a fix`);
  if (r.unverified) parts.push(`${r.unverified} couldn't be checked, still ready`);
  let s = parts.join(", ") + ".";
  if (r.remaining_ready) s += ` ${r.remaining_ready} still ready.`;
  if (r.started) s += r.est_days_to_send_firsts > 1 ? ` First emails finish going out in about ${r.est_days_to_send_firsts} business days at this owner's mailbox capacity.` : " First emails go out today or the next business day.";
  return s;
}
function openLaunch(l) {
  const n = l.ready, sheet = document.createElement("div");
  sheet.className = "cp-sheet-bd";
  sheet.innerHTML = `<div class="cp-sheet" role="dialog" aria-label="Launch emails">
    <div class="cp-sheet-main"><h2>Launch ${esc(l.name)}</h2>
      <p class="cp-muted">${esc(l.owner || "The owner")}'s mailboxes send up to 20 a day each, 8:30am to 5pm their time, a few minutes apart. Addresses are checked first.</p>
      <button type="button" class="btn cp-all" id="cpAll">Send all ${n} ready</button>
      <label class="cp-lbl" for="cpCount">Or send a number</label>
      <div class="cp-num"><input id="cpCount" type="number" inputmode="numeric" min="1" max="${n}" placeholder="1 to ${n}" /><button type="button" class="btn secondary" id="cpSome">Send</button></div></div>
    <div class="cp-sheet-err" id="cpErr" role="alert"></div>
    <div class="cp-sheet-btns"><button type="button" class="btn secondary" id="cpCancel">Cancel</button></div></div>`;
  document.body.appendChild(sheet);
  const q = (s) => sheet.querySelector(s), close = () => sheet.remove();
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  q("#cpCancel").onclick = close;
  let busy = false;
  const go = async (count) => {
    if (busy) return; busy = true;
    q("#cpAll").disabled = q("#cpSome").disabled = true; q("#cpErr").textContent = "";
    q(".cp-sheet-main").insertAdjacentHTML("beforeend", `<p class="cp-muted" id="cpWait">Checking addresses and starting...</p>`);
    try {
      const r = await startEmails(l.list_id, count);
      q(".cp-sheet-main").innerHTML = `<h2>Launched</h2><p class="cp-result">${esc(resultSentence(r))}</p>`;
      q(".cp-sheet-btns").innerHTML = `<button type="button" class="btn" id="cpOk">OK</button>`;
      q("#cpOk").onclick = close; load();
    } catch (e) { q("#cpWait")?.remove(); q("#cpErr").textContent = e.message; q("#cpAll").disabled = q("#cpSome").disabled = false; busy = false; }
  };
  q("#cpAll").onclick = () => go(null);
  q("#cpSome").onclick = () => {
    const v = Math.floor(+q("#cpCount").value || 0);
    if (v < 1 || v > n) { q("#cpErr").textContent = `Enter a number from 1 to ${n}.`; return; }
    go(v);
  };
}
