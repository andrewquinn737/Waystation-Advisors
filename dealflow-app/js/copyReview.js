// Email-sequence UI for the Dials page: import result + mandate picker, "Run sequence setup",
// copy review / one-time approval, and the per-lead sequence badge + Stop action.
// Logic lives here (and in copyLint.js) so js/dials.js only needs small hooks.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { lintBatch, summarize, bodyWordCount, MAX_WORDS } from "./copyLint.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";

const $ = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const msg = (e) => (e && (e.message || e.details || e.hint)) || "Something went wrong";
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
const denverToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());
const parseYMD = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const isWeekday = (dt) => { const w = dt.getUTCDay(); return w !== 0 && w !== 6; };
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const prettyDay = (s) => { const d = parseYMD(s); return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const prettyDate = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${MON[d.getMonth()]} ${d.getDate()}`; };

// Business-day number of today in the sequence (day 1 = seq_day0). Weekends only; holidays ignored (display only).
export function seqDayNumber(day0, today = denverToday()) {
  const a = parseYMD(day0), b = parseYMD(today);
  if (b < a) return 0;
  let n = 0;
  for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) if (isWeekday(d)) n++;
  return Math.max(n, 1);
}

// ---------------------------------------------------------------------------
// Sequence badge + Stop
// ---------------------------------------------------------------------------
export function seqBadgeInfo(d) {
  if (!d || !d.sequence) return null;
  const kind = d.sequence === "call3" ? "Calling seq" : "Email seq";
  switch (d.seq_state) {
    case "awaiting_copy": return { text: "Awaiting copy approval", tone: "wait" };
    case "active": {
      if (!d.seq_day0) return { text: kind, tone: "active" };
      const n = seqDayNumber(d.seq_day0);
      return { text: n ? `${kind} · day ${n}` : `${kind} · starts ${prettyDay(d.seq_day0)}`, tone: "active" };
    }
    case "replied": return { text: "Replied", tone: "good" };
    case "bounced": return { text: "Bounced", tone: "bad" };
    case "stopped": return { text: "Stopped", tone: "stop" };
    case "completed": return { text: "Sequence done", tone: "stop" };
    default: return null;
  }
}
export function seqBadgeHTML(d) {
  const b = seqBadgeInfo(d);
  return b ? ` <span class="seq-badge seq-${b.tone}" title="${escapeHtml(d.seq_stop_reason || "")}">${escapeHtml(b.text)}</span>` : "";
}
const canStop = (d) => d && d.sequence && (d.seq_state === "active" || d.seq_state === "awaiting_copy");

// Panel for the dial detail header: badge + Stop sequence. Wire with wireSeqPanel after inserting.
export function seqPanelHTML(d) {
  const b = seqBadgeInfo(d);
  if (!b) return "";
  return `<div class="seq-panel" id="seqPanel">${seqBadgeHTML(d).trim()}${
    d.seq_stop_reason && !canStop(d) ? ` <span class="seq-reason">${escapeHtml(d.seq_stop_reason)}</span>` : ""
  }${canStop(d) ? ` <button type="button" class="seq-stop-btn" id="seqStopBtn">Stop sequence</button>` : ""}</div>`;
}
export function wireSeqPanel(d, onChanged) {
  const btn = document.getElementById("seqStopBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const ok = await confirmBox({
      title: "Stop this sequence?",
      body: `No more automatic emails or call tasks will be created for ${d.full_name || d.company_name || "this lead"}. This can't be undone.`,
      yes: "Stop sequence", danger: true,
    });
    if (!ok) return;
    btn.disabled = true; btn.textContent = "Stopping...";
    const { error } = await supabase.rpc("stop_sequence", { p_dial_id: d.id, p_reason: "Stopped by user" });
    if (error) { btn.disabled = false; btn.textContent = "Stop sequence"; await infoBox("Could not stop the sequence", msg(error)); return; }
    d.seq_state = "stopped"; d.seq_stop_reason = "Stopped by user";
    onChanged && onChanged(d);
  });
}

// ---------------------------------------------------------------------------
// Small modals
// ---------------------------------------------------------------------------
function modal(inner) {
  const el = $(`<div class="modal-backdrop cr-modal-bd" style="z-index:400"><div class="modal">${inner}</div></div>`);
  document.body.appendChild(el);
  return el;
}
function confirmBox({ title, body, yes, danger }) {
  return new Promise((resolve) => {
    const el = modal(`<h2>${escapeHtml(title)}</h2><p class="help-text" style="font-size:14px;">${escapeHtml(body)}</p>
      <div class="form-actions"><button type="button" class="btn ${danger ? "danger" : ""}" data-y>${escapeHtml(yes)}</button><button type="button" class="btn secondary" data-n>Cancel</button></div>`);
    const done = (v) => { el.remove(); resolve(v); };
    el.querySelector("[data-y]").onclick = () => done(true);
    el.querySelector("[data-n]").onclick = () => done(false);
    el.addEventListener("click", (e) => { if (e.target === el) done(false); });
  });
}
function infoBox(title, body) {
  return new Promise((resolve) => {
    const el = modal(`<h2>${escapeHtml(title)}</h2><p class="help-text" style="font-size:14px;">${escapeHtml(body)}</p>
      <div class="form-actions"><button type="button" class="btn" data-n>OK</button></div>`);
    const done = () => { el.remove(); resolve(); };
    el.querySelector("[data-n]").onclick = done;
    el.addEventListener("click", (e) => { if (e.target === el) done(); });
  });
}

// ---------------------------------------------------------------------------
// Mandate picker (two big buttons) used in the Import modal
// ---------------------------------------------------------------------------
export const MANDATES = [
  { value: "ma", label: "M&A", sub: "Seller outreach" },
  { value: "data", label: "Data sales", sub: "Working Signal" },
];
export const defaultMandateForBuyer = (name) => (/\b(arieh|working\s*signal)\b/i.test(name || "") ? "data" : null);

export function mountMandatePicker(anchorEl) {
  let row = document.getElementById("importMandateRow");
  if (!row) {
    row = $(`<div id="importMandateRow" class="cr-mandate-row"><label>What is this list for?</label>
      <div class="cr-mandate-btns">${MANDATES.map((m) => `<button type="button" class="cr-mandate-btn" data-m="${m.value}"><b>${m.label}</b><span>${m.sub}</span></button>`).join("")}</div></div>`);
    anchorEl.parentNode.insertBefore(row, anchorEl);
    row.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => setMandate(b.dataset.m)));
  }
  const setMandate = (v) => { row.dataset.value = v || ""; row.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === v)); row.classList.remove("cr-need"); };
  row.hidden = false; setMandate(null);
  return { set: setMandate, get: () => row.dataset.value || null, hide: () => { row.hidden = true; }, flagMissing: () => row.classList.add("cr-need") };
}

// ---------------------------------------------------------------------------
// Sequence setup (import + "Run sequence setup")
// ---------------------------------------------------------------------------
export async function prepareList(listId) {
  const { data, error } = await supabase.rpc("seq_prepare_list", { p_list_id: listId });
  if (error) throw error;
  return data || { email_sequence: 0, call_sequence: 0, missing_copy: 0 };
}
export function describePrepare(r) {
  const e = r.email_sequence || 0, c = r.call_sequence || 0, m = r.missing_copy || 0;
  const parts = [
    `${plural(e, "company", "companies")} with a personal email → email sequence (waiting for copy approval)`,
    `${c} without → calling starts today (3-call sequence)`,
  ];
  if (m) parts.push(`${plural(m, "email row is", "email rows are")} missing copy`);
  return parts.join(" · ");
}

// Ask for confirmation-free setup on an existing list; returns after showing the result.
export async function runSequenceSetupFlow(list, onChanged) {
  try {
    const r = await prepareList(list.id);
    await infoBox("Sequence setup done", describePrepare(r));
  } catch (e) {
    await infoBox("Sequence setup failed", msg(e));
  }
  onChanged && (await onChanged());
}

// ---------------------------------------------------------------------------
// Banner (above the dials table)
// ---------------------------------------------------------------------------
export async function renderCopyBanner(container, list, { onChanged } = {}) {
  if (!container) return;
  const token = (container._tok = (container._tok || 0) + 1);
  container.innerHTML = "";
  if (!list || list.deleted_at) return;
  if (list.copy_status === "pending_review") {
    container.innerHTML = `<div class="cr-banner"><span class="cr-banner-text">Checking copy...</span></div>`;
    const { count, error } = await supabase.from("dials").select("id", { count: "exact", head: true })
      .eq("list_id", list.id).eq("sequence", "email5").eq("seq_state", "awaiting_copy");
    if (token !== container._tok) return;
    const label = error ? "Review emails before they send" : `Review ${plural(count || 0, "email", "emails")} before they send`;
    container.innerHTML = `<div class="cr-banner"><span class="cr-banner-text">${escapeHtml(label)}</span><button type="button" class="btn cr-banner-btn">Review</button></div>`;
    container.querySelector("button").onclick = () => openCopyReview(list, { onChanged });
  } else if (list.copy_status === "approved") {
    let who = "";
    if (list.copy_approved_by) {
      const { data } = await supabase.from("profiles").select("full_name").eq("id", list.copy_approved_by).maybeSingle();
      who = data?.full_name || "";
    }
    if (token !== container._tok) return;
    const when = list.copy_approved_at ? ` on ${prettyDate(list.copy_approved_at)}` : "";
    container.innerHTML = `<div class="cr-status">Copy approved${who ? ` by ${escapeHtml(who)}` : ""}${when} · sequence running</div>`;
  }
}

// ---------------------------------------------------------------------------
// Review screen
// ---------------------------------------------------------------------------
const PAGE = 40;
const FIELDS = [
  { key: "email_subject", label: "Subject", rows: 1 },
  { key: "email_1", label: "Email 1", rows: 7 },
  { key: "email_2", label: "Follow-up", rows: 5 },
];

async function loadLeads(listId) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("dials")
      .select("id, full_name, company_name, email, email_subject, email_1, email_2")
      .eq("list_id", listId).eq("sequence", "email5").eq("seq_state", "awaiting_copy")
      .order("company_name", { ascending: true }).order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function openCopyReview(list, { onChanged } = {}) {
  lockPageScroll();
  const panel = $(`<div class="cr-panel" role="dialog" aria-label="Review email copy">
    <div class="cr-head">
      <div class="cr-head-row"><h2>Review emails · ${escapeHtml(list.name || "")}</h2><button type="button" class="fs-close cr-close" aria-label="Close">&times;</button></div>
      <div class="cr-counts" id="crCounts"></div>
      <label class="cr-filter"><input type="checkbox" id="crProblems" /> Show problems only</label>
      <button type="button" class="btn cr-approve" id="crApprove" disabled>Approve</button>
      <div class="cr-why" id="crWhy"></div>
    </div>
    <div class="cr-body" id="crBody"><div class="help-text">Loading emails...</div></div>
  </div>`);
  document.body.appendChild(panel);
  const q = (id) => panel.querySelector("#" + id);
  const body = q("crBody");
  let leads = [], results = new Map(), shown = PAGE, approved = null, busy = false, changed = false;

  const close = () => { panel.remove(); unlockPageScroll(); document.removeEventListener("keydown", onKey); if (changed || approved) onChanged && onChanged(); };
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".cr-modal-bd")) close(); };
  document.addEventListener("keydown", onKey);
  panel.querySelector(".cr-close").onclick = close;

  function updateHeader() {
    results = lintBatch(leads);
    const s = summarize(results);
    q("crCounts").innerHTML = `<span class="cr-pill ok">${s.ready} ready</span><span class="cr-pill ${s.errors ? "err" : ""}">${s.errors} with errors</span><span class="cr-pill ${s.warnings ? "warn" : ""}">${s.warnings} with warnings</span>`;
    const btn = q("crApprove");
    btn.textContent = `Approve all ${s.total} and start sending`;
    const why = q("crWhy");
    if (approved) { btn.disabled = true; why.textContent = ""; }
    else if (!s.total) { btn.disabled = true; why.textContent = "No emails are waiting for approval."; }
    else if (s.errors) { btn.disabled = true; why.textContent = `Fix the ${plural(s.errors, "email", "emails")} with errors first (red cards). Tap "Show problems only" to find them.`; }
    else { btn.disabled = busy; why.textContent = s.warnings ? "Warnings are okay to send, but glance at them first." : ""; }
  }

  const issuesHTML = (r) => r.errors.map((e) => `<li class="e">${escapeHtml(e)}</li>`).join("") + r.warnings.map((w) => `<li class="w">${escapeHtml(w)}</li>`).join("");
  const wc = (l) => `${bodyWordCount(l.email_1)}/${MAX_WORDS} words`;

  function cardHTML(l) {
    const r = results.get(l.id) || { errors: [], warnings: [] };
    return `<div class="cr-card ${r.errors.length ? "has-err" : r.warnings.length ? "has-warn" : ""}" data-id="${l.id}">
      <div class="cr-card-top"><div><b>${escapeHtml(l.company_name || "(no company)")}</b><div class="cr-to">${escapeHtml(l.full_name || "")} &lt;${escapeHtml(l.email || "")}&gt;</div></div><span class="cr-wc">${wc(l)}</span></div>
      <ul class="cr-issues">${issuesHTML(r)}</ul>
      ${FIELDS.map((f) => `<label class="cr-field"><span>${f.label}</span><textarea data-f="${f.key}" rows="${f.rows}" spellcheck="true">${escapeHtml(l[f.key] || "")}</textarea></label>`).join("")}
      <div class="cr-save"></div></div>`;
  }

  function renderList() {
    const onlyProblems = q("crProblems").checked;
    const list = leads.filter((l) => !onlyProblems || (results.get(l.id)?.errors.length || results.get(l.id)?.warnings.length));
    if (!leads.length) { body.innerHTML = `<div class="empty-state">No emails are waiting for review on this list.</div>`; return; }
    if (!list.length) { body.innerHTML = `<div class="empty-state">No problems found.</div>`; return; }
    body.innerHTML = list.slice(0, shown).map(cardHTML).join("") +
      (list.length > shown ? `<button type="button" class="btn secondary cr-more">Show more (${list.length - shown} left)</button>` : "");
    const more = body.querySelector(".cr-more");
    if (more) more.onclick = () => { shown += PAGE; renderList(); };
  }

  function refreshCards() {
    body.querySelectorAll(".cr-card").forEach((card) => {
      const l = leads.find((x) => x.id === card.dataset.id); if (!l) return;
      const r = results.get(l.id);
      card.classList.toggle("has-err", r.errors.length > 0);
      card.classList.toggle("has-warn", !r.errors.length && r.warnings.length > 0);
      card.querySelector(".cr-issues").innerHTML = issuesHTML(r);
      card.querySelector(".cr-wc").textContent = wc(l);
    });
  }

  let t = null;
  body.addEventListener("input", (e) => {
    const ta = e.target.closest("textarea[data-f]"); if (!ta) return;
    const l = leads.find((x) => x.id === ta.closest(".cr-card").dataset.id);
    l[ta.dataset.f] = ta.value;
    clearTimeout(t);
    t = setTimeout(() => { updateHeader(); refreshCards(); }, 250);
  });
  // Saves one field if it changed since the last save; tracked so Approve can wait for it.
  const inflight = new Set();
  function saveField(l, field, saveEl) {
    const val = l[field] ?? "";
    if (l._saved && l._saved[field] === val) return Promise.resolve(true);
    if (saveEl) { saveEl.className = "cr-save"; saveEl.textContent = "Saving..."; }
    const p = supabase.from("dials").update({ [field]: val }).eq("id", l.id).then(({ error }) => {
      if (error) { if (saveEl) { saveEl.className = "cr-save bad"; saveEl.textContent = "Not saved: " + msg(error); } return false; }
      (l._saved ||= {})[field] = val; changed = true;
      if (saveEl) { saveEl.className = "cr-save ok"; saveEl.textContent = "Saved"; setTimeout(() => { if (saveEl.textContent === "Saved") saveEl.textContent = ""; }, 1500); }
      return true;
    });
    inflight.add(p); p.finally(() => inflight.delete(p));
    return p;
  }
  body.addEventListener("focusout", (e) => {
    const ta = e.target.closest("textarea[data-f]"); if (!ta) return;
    const card = ta.closest(".cr-card"), l = leads.find((x) => x.id === card.dataset.id);
    l[ta.dataset.f] = ta.value;
    saveField(l, ta.dataset.f, card.querySelector(".cr-save"));
  });
  async function flushAll() {
    const ps = [];
    for (const l of leads) for (const f of FIELDS) ps.push(saveField(l, f.key, body.querySelector(`.cr-card[data-id="${l.id}"] .cr-save`)));
    return (await Promise.all(ps)).every(Boolean);
  }
  q("crProblems").onchange = () => { shown = PAGE; renderList(); };

  q("crApprove").onclick = async () => {
    if (busy || approved) return;
    busy = true;
    const btn = q("crApprove"); btn.disabled = true; btn.textContent = "Approving...";
    // make sure every edit is saved first, and re-check the lint on what was saved
    if (!(await flushAll())) { busy = false; updateHeader(); q("crWhy").textContent = "Some edits could not be saved. Check the cards marked 'Not saved'."; q("crWhy").classList.add("bad"); return; }
    updateHeader();
    if (summarize(results).errors) { busy = false; updateHeader(); return; }
    const { data, error } = await supabase.rpc("approve_list_copy", { p_list_id: list.id });
    busy = false;
    if (error) { updateHeader(); q("crWhy").textContent = "Could not approve: " + msg(error); q("crWhy").classList.add("bad"); return; }
    approved = data || {};
    q("crWhy").classList.remove("bad");
    body.innerHTML = `<div class="cr-done"><div class="cr-done-big">Started ${approved.started ?? 0}</div>
      <p>${approved.first_send_day ? `First emails go out ${escapeHtml(prettyDay(approved.first_send_day))} between 8am-5pm MT.` : "Sequence started."}</p>
      ${approved.missing_copy ? `<p class="cr-warn-text">${plural(approved.missing_copy, "lead was", "leads were")} skipped because of missing copy.</p>` : ""}
      <button type="button" class="btn" id="crDone">Done</button></div>`;
    q("crDone").onclick = close;
    q("crCounts").innerHTML = ""; btn.textContent = "Approved"; btn.disabled = true; q("crWhy").textContent = "";
  };

  try {
    leads = await loadLeads(list.id);
    leads.forEach((l) => (l._saved = { email_subject: l.email_subject || "", email_1: l.email_1 || "", email_2: l.email_2 || "" }));
    updateHeader(); renderList();
  } catch (e) {
    body.innerHTML = `<div class="error-msg">Could not load emails: ${escapeHtml(msg(e))}</div><button type="button" class="btn secondary" id="crRetry">Try again</button>`;
    q("crRetry").onclick = () => { close(); openCopyReview(list, { onChanged }); };
  }
}
