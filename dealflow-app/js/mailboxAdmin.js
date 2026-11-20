// Mailboxes admin page: lists every sending mailbox grouped by owner, lets an admin
// reassign / set limits / pause / bulk-assign, and bulk-add mailboxes via the
// mailbox-admin Edge Function (same API an AI tool can call).
import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL } from "./config.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ENDPOINT = SUPABASE_URL + "/functions/v1/mailbox-admin";

const { profile } = await requireSession();
if (profile.role !== "admin") {
  $("mbxDenied").classList.remove("hidden");
} else {
  $("mbxApp").classList.remove("hidden");
}
let boxes = [];
let people = [];
const selected = new Set();
let apiKey = null;
let previewRows = null; // normalized rows from the last good preview

async function api(body) {
  const { data: { session } } = await supabase.auth.getSession();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (session?.access_token || "") },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(json?.error || `Request failed (${res.status}).`);
  return json;
}

function msg(text, ok = false) {
  const el = $("mbxMsg");
  if (!text) return el.classList.add("hidden");
  el.textContent = text;
  el.classList.toggle("ok", ok);
  el.classList.remove("hidden");
}

const domainOf = (a) => (a.split("@")[1] || "").toLowerCase();

async function load() {
  $("mbxList").innerHTML = `<p class="mbx-loading">Loading mailboxes...</p>`;
  try {
    const r = await api({ action: "list" });
    boxes = r.mailboxes;
    people = r.people.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
    for (const id of [...selected]) if (!boxes.some((b) => b.id === id)) selected.delete(id);
    msg("");
    fillDomains();
    render();
  } catch (e) {
    $("mbxList").innerHTML = "";
    msg(e.message);
  }
}

function fillDomains() {
  const cur = $("mbxFilterDomain").value;
  const domains = [...new Set(boxes.map((b) => domainOf(b.email_address)))].sort();
  $("mbxFilterDomain").innerHTML = `<option value="">All domains</option>` + domains.map((d) => `<option ${d === cur ? "selected" : ""}>${esc(d)}</option>`).join("");
  const opts = `<option value="">Assign selected to...</option>` + people.map((p) => `<option value="${p.id}">${esc(p.full_name)}</option>`).join("");
  $("mbxBulkOwner").innerHTML = opts;
}

function filtered() {
  const q = $("mbxSearch").value.trim().toLowerCase();
  const st = $("mbxFilterStatus").value, md = $("mbxFilterMandate").value, dm = $("mbxFilterDomain").value;
  return boxes.filter((b) =>
    (!q || b.email_address.toLowerCase().includes(q) || (b.owner_name || "").toLowerCase().includes(q) || (b.label || "").toLowerCase().includes(q)) &&
    (!st || (st === "unassigned" ? b.needs_assignment : !!b.send_paused_reason)) &&
    (!md || (md === "none" ? !b.mandate : b.mandate === md)) &&
    (!dm || domainOf(b.email_address) === dm));
}

function cardHtml(b) {
  const lim = b.effective_daily_limit ?? 0;
  const used = (b.sent_24h ?? 0) + (b.scheduled ?? 0);
  const paused = !!b.send_paused_reason;
  const ver = b.credentials_verified === true ? `<span class="mbx-badge good">verified</span>` : b.credentials_verified === false ? `<span class="mbx-badge bad">login failed</span>` : `<span class="mbx-badge warn">unverified</span>`;
  const owners = people.map((p) => `<option value="${p.id}" ${!b.needs_assignment && p.id === b.owner_id ? "selected" : ""}>${esc(p.full_name)}</option>`).join("");
  return `<div class="mbx-card ${paused ? "paused" : ""}" data-id="${b.id}">
    <span class="c-chk"><input type="checkbox" data-act="sel" ${selected.has(b.id) ? "checked" : ""} aria-label="Select ${esc(b.email_address)}" /></span>
    <div class="mbx-addr"><b title="${esc(b.email_address)}">${esc(b.email_address)}</b>
      <small>${ver}${paused ? `<span class="mbx-badge warn" title="${esc(b.send_paused_reason)}">paused</span>` : ""}${esc(b.label && b.label !== b.email_address ? b.label : "")}</small></div>
    <select class="c-owner" data-act="owner" aria-label="Owner">${b.needs_assignment ? `<option value="" selected disabled>Unassigned: pick a person</option>` : ""}${owners}</select>
    <select class="c-mand" data-act="mandate" aria-label="Mandate"><option value="">Any</option><option value="ma" ${b.mandate === "ma" ? "selected" : ""}>M&amp;A</option><option value="data" ${b.mandate === "data" ? "selected" : ""}>Data</option></select>
    <input class="c-lim" type="number" min="0" max="200" data-act="limit" value="${b.daily_send_limit ?? ""}" placeholder="${lim || ""}" title="Daily limit (blank = default)" aria-label="Daily limit" />
    <span class="mbx-usage ${used >= lim && lim ? "full" : ""}" title="Sent in last 24h + scheduled, over the daily limit">${used}/${lim}</span>
    <button type="button" class="btn secondary small c-pause" data-act="pause">${paused ? "Resume" : "Pause"}</button>
    <label class="mbx-sync"><input type="checkbox" data-act="sync" ${b.sync_enabled ? "checked" : ""} /> Sync inbox</label>
  </div>`;
}

function render() {
  const list = filtered();
  const unassigned = boxes.filter((b) => b.needs_assignment).length;
  $("mbxSummary").textContent = `${boxes.length} mailbox${boxes.length === 1 ? "" : "es"}` + (unassigned ? `, ${unassigned} need an owner` : "") + (list.length !== boxes.length ? ` (showing ${list.length})` : "");
  $("mbxBulk").classList.toggle("hidden", selected.size === 0);
  $("mbxSelCount").textContent = `${selected.size} selected`;
  if (boxes.length === 0) { $("mbxList").innerHTML = `<p class="mbx-empty">No mailboxes yet. Use "Add mailboxes" to import some.</p>`; return; }
  if (list.length === 0) { $("mbxList").innerHTML = `<p class="mbx-empty">No mailboxes match these filters.</p>`; return; }
  const groups = new Map();
  for (const b of list) {
    const k = b.needs_assignment ? "__unassigned" : b.owner_id;
    if (!groups.has(k)) groups.set(k, { name: b.needs_assignment ? "Unassigned" : b.owner_name || "Unknown owner", items: [] });
    groups.get(k).items.push(b);
  }
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === "__unassigned" ? -1 : b[0] === "__unassigned" ? 1 : a[1].name.localeCompare(b[1].name)));
  $("mbxList").innerHTML = ordered.map(([k, g]) =>
    `<section class="mbx-group"><h3 class="mbx-group-head ${k === "__unassigned" ? "warn" : ""}">${esc(g.name)} <span class="mbx-group-count">${g.items.length}</span></h3>${g.items.map(cardHtml).join("")}</section>`).join("");
}

async function run(fn, okText) {
  try { await fn(); if (okText) msg(okText, true); } catch (e) { msg(e.message); }
  await load();
}

function onListEvent(ev) {
  const el = ev.target.closest("[data-act]");
  const card = ev.target.closest(".mbx-card");
  if (!el || !card) return;
  const id = card.dataset.id, b = boxes.find((x) => x.id === id), act = el.dataset.act;
  if (!b) return;
  if (act === "sel" && ev.type === "change") {
    el.checked ? selected.add(id) : selected.delete(id);
    $("mbxBulk").classList.toggle("hidden", selected.size === 0);
    $("mbxSelCount").textContent = `${selected.size} selected`;
  } else if (act === "owner" && ev.type === "change" && el.value) {
    run(() => api({ action: "assign", account_ids: [id], owner_id: el.value }), "Owner updated.");
  } else if (act === "mandate" && ev.type === "change") {
    run(() => api({ action: "update", account_id: id, mandate: el.value || null }));
  } else if (act === "limit" && ev.type === "change") {
    const v = el.value.trim();
    if (v !== "" && (!/^\d+$/.test(v) || +v > 200)) { msg("Daily limit must be a whole number from 0 to 200."); el.value = b.daily_send_limit ?? ""; return; }
    run(() => api({ action: "update", account_id: id, daily_send_limit: v === "" ? null : +v }));
  } else if (act === "sync" && ev.type === "change") {
    run(() => api({ action: "update", account_id: id, sync_enabled: el.checked }));
  } else if (act === "pause" && ev.type === "click") {
    run(() => api({ action: "update", account_id: id, send_paused_reason: b.send_paused_reason ? null : "Paused by admin" }));
  }
}

// ---------------- add / import ----------------
function parseDelimited(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const split = (line) => {
    const d = line.includes("\t") ? "\t" : ",";
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === d) { out.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  let rows = lines.map(split);
  if (rows.length && /^e-?mail/i.test(rows[0][0] || "")) rows = rows.slice(1);
  return rows;
}

function buildRows(text) {
  const out = [];
  for (const c of parseDelimited(text)) {
    const r = { email: c[0] || "", password: c[1] || "" };
    if (c[2]) r.display_name = c[2];
    if (c[3]) (c[3].includes("@") ? (r.owner_email = c[3]) : (r.owner_name = c[3]));
    if (c[4]) r.daily_send_limit = /^\d+$/.test(c[4]) ? +c[4] : c[4];
    if (c[5]) r.mandate = c[5];
    if ($("mbxVerify").checked) r.verify = true;
    out.push(r);
  }
  return out;
}

async function preview() {
  const rows = buildRows($("mbxPaste").value);
  previewRows = null; $("mbxImport").disabled = true;
  if (!rows.length) { $("mbxPreviewOut").innerHTML = `<p class="mbx-muted">Nothing to preview yet. Paste at least one line.</p>`; return; }
  if (rows.length > 500) { $("mbxPreviewOut").innerHTML = `<p class="mbx-st-error">Max 500 rows at a time (you have ${rows.length}).</p>`; return; }
  $("mbxPreviewOut").innerHTML = `<p class="mbx-loading">Checking...</p>`;
  try {
    const r = await api({ action: "bulk_upsert", dry_run: true, mailboxes: rows.map((x) => ({ ...x, verify: undefined })) });
    const s = r.summary;
    $("mbxPreviewOut").innerHTML = `<p class="mbx-muted"><b>${s.would_create}</b> new, <b>${s.would_update}</b> updated, <b>${s.errors}</b> with errors, <b>${s.needs_assignment}</b> will land in Unassigned.</p>
      <div class="mbx-table-wrap"><table class="mbx-table"><thead><tr><th>Email</th><th>Result</th><th>Owner</th><th>Note</th></tr></thead><tbody>${r.results.map((x) =>
        `<tr><td>${esc(x.email)}</td><td class="${x.status === "error" ? "mbx-st-error" : "mbx-st-ok"}">${esc(x.status.replace("_", " "))}</td><td>${esc(x.owner || "")}</td><td>${esc(x.error || (x.needs_assignment ? "No name match: assign by hand" : ""))}</td></tr>`).join("")}</tbody></table></div>`;
    if (s.would_create + s.would_update > 0) { previewRows = rows; $("mbxImport").disabled = false; }
  } catch (e) {
    $("mbxPreviewOut").innerHTML = `<p class="mbx-st-error">${esc(e.message)}</p>`;
  }
}

async function doImport() {
  if (!previewRows) return;
  $("mbxImport").disabled = true;
  $("mbxPreviewOut").innerHTML = `<p class="mbx-loading">Importing...</p>`;
  try {
    const r = await api({ action: "bulk_upsert", mailboxes: previewRows });
    const s = r.summary;
    const bad = r.results.filter((x) => x.status === "error");
    $("mbxPreviewOut").innerHTML = `<p class="mbx-muted"><b>${s.created}</b> created, <b>${s.updated}</b> updated, <b>${s.errors}</b> failed.</p>` +
      (bad.length ? `<ul class="mbx-muted">${bad.map((x) => `<li>${esc(x.email)}: ${esc(x.error)}</li>`).join("")}</ul>` : "");
    if (s.created + s.updated > 0) {
      // Keep only the failed lines in the box so they can be fixed and retried.
      $("mbxPaste").value = "";
      msg(`Imported ${s.created + s.updated} mailbox(es).` + (s.needs_assignment ? ` ${s.needs_assignment} need an owner (see Unassigned).` : ""), true);
    }
    previewRows = null;
    await load();
  } catch (e) {
    $("mbxPreviewOut").innerHTML = `<p class="mbx-st-error">${esc(e.message)}</p>`;
    $("mbxImport").disabled = false;
  }
}

function addOne() {
  const f = (id) => $(id).value.trim().replace(/"/g, '""');
  if (!f("oneEmail") || !f("onePass")) { $("mbxPreviewOut").innerHTML = `<p class="mbx-st-error">Email and password are required.</p>`; return; }
  const cells = ["oneEmail", "onePass", "oneName", "oneOwner", "oneLimit", "oneMandate"].map((id) => `"${f(id)}"`);
  $("mbxPaste").value = ($("mbxPaste").value.trim() ? $("mbxPaste").value.trim() + "\n" : "") + cells.join(",");
  for (const id of ["oneEmail", "onePass", "oneName", "oneOwner", "oneLimit", "oneMandate"]) $(id).value = "";
  $("mbxPreviewOut").innerHTML = `<p class="mbx-muted">Added to the list above. Add more, then Preview.</p>`;
}

// ---------------- API help ----------------
function curlText() {
  const key = apiKey || "<click 'Show API key'>";
  return `curl -X POST '${ENDPOINT}' \\
  -H 'x-admin-api-key: ${key}' \\
  -H 'Content-Type: application/json' \\
  -d '{"action":"bulk_upsert","dry_run":true,"mailboxes":[
        {"email":"sam@example-sales.com","password":"...","display_name":"Sam Lee","daily_send_limit":25,"mandate":"ma"}]}'`;
}

async function showKey() {
  $("mbxShowKey").disabled = true;
  try {
    const r = await api({ action: "get_api_key" });
    if (!r.api_key) throw new Error("No API key is set up on this project yet.");
    apiKey = r.api_key;
    $("mbxCurl").textContent = curlText();
    $("mbxShowKey").classList.add("hidden");
    $("mbxCopyCurl").classList.remove("hidden");
  } catch (e) { msg(e.message); $("mbxShowKey").disabled = false; }
}

function init() {
  $("mbxCurl").textContent = curlText();
  $("mbxRefresh").addEventListener("click", load);
  $("mbxAddToggle").addEventListener("click", () => $("mbxAddPanel").classList.toggle("hidden"));
  for (const id of ["mbxSearch", "mbxFilterStatus", "mbxFilterMandate", "mbxFilterDomain"]) $(id).addEventListener("input", render);
  $("mbxList").addEventListener("change", onListEvent);
  $("mbxList").addEventListener("click", onListEvent);
  $("mbxSelClear").addEventListener("click", () => { selected.clear(); render(); });
  $("mbxBulkAssign").addEventListener("click", () => {
    const owner = $("mbxBulkOwner").value;
    if (!owner) return msg("Pick a person to assign the selected mailboxes to.");
    const ids = [...selected];
    run(async () => { await api({ action: "assign", account_ids: ids, owner_id: owner }); selected.clear(); }, `Assigned ${ids.length} mailbox(es).`);
  });
  $("mbxPreview").addEventListener("click", preview);
  $("mbxImport").addEventListener("click", doImport);
  $("mbxPaste").addEventListener("input", () => { previewRows = null; $("mbxImport").disabled = true; });
  $("oneAdd").addEventListener("click", addOne);
  $("mbxShowKey").addEventListener("click", showKey);
  $("mbxCopyCurl").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(curlText()); msg("Command copied.", true); } catch { msg("Couldn't copy; select the text and copy it by hand."); }
  });
  load();
}

if (profile.role === "admin") init();
