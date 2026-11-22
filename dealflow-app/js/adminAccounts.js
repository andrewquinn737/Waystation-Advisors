// Admin > Email accounts: sending mailboxes grouped by person (mailbox-admin edge function, same API an AI tool can call).
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL } from "./config.js";
import { copyText } from "./claudeHelp.js";
import { confirmBox } from "./copyCommon.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ENDPOINT = SUPABASE_URL + "/functions/v1/mailbox-admin";
let boxes = [], people = [];

async function api(body) {
  const { data: { session } } = await supabase.auth.getSession();
  let res;
  try { res = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + (session?.access_token || "") }, body: JSON.stringify(body) }); }
  catch { throw new Error("Couldn't reach the server. Check your connection and try again."); }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) { const e = new Error(json?.error || `Request failed (${res.status}).`); e.status = res.status; throw e; }
  return json;
}
function msg(text, ok = false) { const el = $("mbxMsg"); el.textContent = text || ""; el.classList.toggle("hidden", !text); el.classList.toggle("ok", ok); }

export function initAccounts() {
  $("mbxEndpoint").textContent = ENDPOINT;
  $("mbxRefresh").onclick = load;
  $("mbxCheckAll").onclick = checkAll;
  $("mbxAddToggle").onclick = () => { $("mbxAddPanel").classList.toggle("hidden"); $("addEmail").focus(); };
  $("addCancel").onclick = () => $("mbxAddPanel").classList.add("hidden");
  $("mbxAddPanel").addEventListener("submit", (e) => { e.preventDefault(); addOne(); });
  $("mbxList").addEventListener("change", onEvent);
  $("mbxList").addEventListener("click", onEvent);
  $("mbxRotate").onclick = rotateKey;
  load();
}

async function load() {
  $("mbxList").innerHTML = `<p class="ad-empty">Loading...</p>`;
  try {
    const r = await api({ action: "list" });
    boxes = r.mailboxes; people = r.people.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
    $("addOwner").innerHTML = `<option value="">Owner: match by name</option>` + people.map((p) => `<option value="${p.id}">${esc(p.full_name)}</option>`).join("");
    msg(""); render();
  } catch (e) { $("mbxList").innerHTML = ""; msg(e.message); }
}

// Two separate indicators from the last REAL login check: sending (SMTP login) and reading (IMAP login; XOAUTH2 for Microsoft
// 365 mailboxes). Reading also shows the sync status (last sync time / last sync error).
function ago(t) {
  if (!t) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago";
}
function indicators(b) {
  const send = b.sending_ok === true ? ["good", "Sending \u2713"] : b.sending_ok === false ? ["bad", "Sending \u2717"] : ["", "Sending not checked"];
  const r = b.reading_state;
  const read = r === "ok" ? ["good", "Reading \u2713"]
    : r === "blocked_microsoft" ? ["warn", "Reading blocked by Microsoft"]
    : r === "error" ? ["bad", "Reading \u2717"] : r === "off" ? ["", "Reading off"] : ["", "Reading not checked"];
  const checked = b.checked_at ? `Last checked ${ago(b.checked_at)}.` : "Not checked yet.";
  const sendTip = esc((b.check_error || "").split(" | ").find((x) => x.startsWith("Sending")) || checked);
  const readTip = esc(b.last_sync_error || (b.check_error || "").split(" | ").find((x) => x.startsWith("Reading")) || checked);
  const sync = !b.sync_enabled ? "Not syncing" : b.last_sync_error ? "Sync error" : b.last_synced_at ? "Synced " + ago(b.last_synced_at) : "Not synced yet";
  return `<span class="ad-ind ${send[0]}" title="${sendTip}">${send[1]}</span><span class="ad-ind ${read[0]}" title="${readTip}">${read[1]}</span><span class="ad-ind ${b.sync_enabled && !b.last_sync_error ? "" : "warn"}" title="${esc(b.last_sync_error || "")}">${sync}</span>`;
}

function boxHtml(b) {
  const lim = b.effective_daily_limit ?? 0, sent = b.sent_24h ?? 0, paused = !!b.send_paused_reason;
  const ver = indicators(b);
  const owners = people.map((p) => `<option value="${p.id}" ${!b.needs_assignment && p.id === b.owner_id ? "selected" : ""}>${esc(p.full_name)}</option>`).join("");
  return `<div class="ad-box${paused ? " paused" : ""}" data-id="${b.id}">
    <div class="ad-box-top"><span class="ad-addr" title="${esc(b.email_address)}">${esc(b.email_address)}</span><span class="ad-use${lim && sent + (b.scheduled ?? 0) >= lim ? " full" : ""}" title="Sent in the last 24h / daily limit (${b.scheduled ?? 0} queued)">${sent}/${lim} today</span></div>
    <div class="ad-badges">${ver}<button type="button" class="ad-link" data-act="check" title="Log in to this mailbox now (nothing is sent)">Check now</button>${paused ? `<span class="ad-badge warn" title="${esc(b.send_paused_reason)}">paused: ${esc(b.send_paused_reason)}</span>` : ""}</div>
    <div class="ad-box-ctl"><select data-act="owner" aria-label="Owner">${b.needs_assignment ? `<option value="" selected disabled>Pick an owner</option>` : ""}${owners}</select>
      <input type="number" min="0" max="200" data-act="limit" value="${b.daily_send_limit ?? ""}" placeholder="${lim || ""}" title="Daily limit (blank = default)" aria-label="Daily limit" />
      <button type="button" class="btn secondary small" data-act="pause">${paused ? "Resume" : "Pause"}</button></div>
    <details class="ad-more"><summary>More</summary><div>
      <label>Mandate <select data-act="mandate"><option value="">Any</option><option value="ma" ${b.mandate === "ma" ? "selected" : ""}>M&amp;A</option><option value="data" ${b.mandate === "data" ? "selected" : ""}>Data</option></select></label>
      <label><input type="checkbox" data-act="sync" ${b.sync_enabled ? "checked" : ""} /> Read this inbox</label></div></details></div>`;
}
function render() {
  const unassigned = boxes.filter((b) => b.needs_assignment).length;
  $("mbxSummary").textContent = `${boxes.length} account${boxes.length === 1 ? "" : "s"}` + (unassigned ? `, ${unassigned} need an owner` : "");
  if (!boxes.length) { $("mbxList").innerHTML = `<p class="ad-empty">No email accounts yet. Tap "Add account".</p>`; return; }
  const wasOpen = new Set([...$("mbxList").querySelectorAll("details.ad-group[open]")].map((d) => d.dataset.k));
  const groups = new Map();
  for (const b of boxes) {
    const k = b.needs_assignment ? "__un" : b.owner_id;
    if (!groups.has(k)) groups.set(k, { name: b.needs_assignment ? "Needs an owner" : b.owner_name || "Unknown owner", items: [] });
    groups.get(k).items.push(b);
  }
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === "__un" ? -1 : b[0] === "__un" ? 1 : a[1].name.localeCompare(b[1].name)));
  $("mbxList").innerHTML = ordered.map(([k, g]) => {
    const used = g.items.reduce((s, b) => s + (b.sent_24h ?? 0), 0), cap = g.items.reduce((s, b) => s + (b.effective_daily_limit ?? 0), 0);
    const open = wasOpen.has(String(k)) || k === "__un" || g.items.some((b) => b.send_paused_reason || b.sending_ok === false);
    return `<details class="ad-group${k === "__un" ? " warn" : ""}" data-k="${esc(k)}" ${open ? "open" : ""}><summary><span>${esc(g.name)}</span><small>${g.items.length} · ${used}/${cap} today</small></summary>${g.items.map(boxHtml).join("")}</details>`;
  }).join("");
}

async function run(fn, okText) { try { await fn(); if (okText) msg(okText, true); } catch (e) { msg(e.message); } await load(); }
function onEvent(ev) {
  const el = ev.target.closest("[data-act]"), card = ev.target.closest(".ad-box"); if (!el || !card) return;
  const id = card.dataset.id, b = boxes.find((x) => x.id === id), act = el.dataset.act; if (!b) return;
  if (act === "owner" && ev.type === "change" && el.value) run(() => api({ action: "assign", account_ids: [id], owner_id: el.value }), "Owner updated.");
  else if (act === "mandate" && ev.type === "change") run(() => api({ action: "update", account_id: id, mandate: el.value || null }));
  else if (act === "sync" && ev.type === "change") run(() => api({ action: "update", account_id: id, sync_enabled: el.checked }));
  else if (act === "limit" && ev.type === "change") {
    const v = el.value.trim();
    if (v !== "" && (!/^\d+$/.test(v) || +v > 200)) { msg("Daily limit must be a whole number from 0 to 200."); el.value = b.daily_send_limit ?? ""; return; }
    run(() => api({ action: "update", account_id: id, daily_send_limit: v === "" ? null : +v }));
  } else if (act === "check" && ev.type === "click") checkLogin(b, el);
  else if (act === "pause" && ev.type === "click") run(() => api({ action: "update", account_id: id, send_paused_reason: b.send_paused_reason ? null : "Paused by admin" }));
}

async function addOne() {
  const email = $("addEmail").value.trim(), password = $("addPass").value, owner = $("addOwner").value, out = $("addMsg");
  const say = (t, ok) => { out.textContent = t; out.classList.toggle("hidden", !t); out.classList.toggle("ok", !!ok); };
  if (!email || !password) return say("Email and password are required.");
  $("addGo").disabled = true; say("Checking the login...", true);
  try {
    const row = { email, password, verify: true };
    if (owner) row.owner_name = people.find((x) => x.id === owner)?.full_name;
    const r = await api({ action: "bulk_upsert", mailboxes: [row] });
    const x = r.results[0];
    if (x.status === "error") return say(x.error || "That account could not be added.");
    $("addEmail").value = ""; $("addPass").value = ""; $("mbxAddPanel").classList.add("hidden"); say("");
    msg(x.needs_assignment ? `${email} added. Pick its owner below.` : `${email} added and its login works.`, true);
    await load();
  } catch (e) { say(e.message); } finally { $("addGo").disabled = false; }
}

async function rotateKey() {
  if (!(await confirmBox({ title: "Make a new API key?", body: "The old key stops working right away. The new one is shown once; copy it somewhere safe.", yes: "Make new key" }))) return;
  $("mbxRotate").disabled = true;
  try {
    const r = await api({ action: "rotate_api_key" });
    $("mbxKeyOut").innerHTML = `<p class="ad-note warn">Copy it now. It is not shown again.</p><pre>${esc(r.api_key)}</pre><button type="button" class="btn secondary small" id="mbxCopyKey">Copy key</button>`;
    $("mbxCopyKey").onclick = async (e) => { e.target.textContent = (await copyText(r.api_key)) ? "Copied" : "Select and copy it by hand"; };
  } catch (e) { msg(e.status === 400 ? "Key rotation isn't available on this server yet." : e.message); }
  $("mbxRotate").disabled = false;
}

// Live login check for one mailbox (nothing is sent). The server stores the result; reload so the list shows the stored truth.
async function checkLogin(b, btn) {
  btn.disabled = true; btn.textContent = "Checking...";
  try { await api({ action: "check_login", account_id: b.id }); await load(); }
  catch (e) { msg(e.message); btn.disabled = false; btn.textContent = "Check now"; }
}

async function checkAll() {
  const btn = $("mbxCheckAll"); btn.disabled = true; btn.textContent = "Checking...";
  try {
    const r = await api({ action: "check_login", all: true });
    await load(); msg(`Checked ${r.checked}: sending works on ${r.sending_ok}, reading works on ${r.reading_ok}.`, r.sending_ok === r.checked && r.reading_ok === r.checked);
  } catch (e) { msg(e.message); }
  btn.disabled = false; btn.textContent = "Check all";
}
