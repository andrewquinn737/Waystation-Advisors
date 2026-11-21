// Full-screen copy review. Status per card comes from the SERVER check (copy-gate); the in-browser
// lint (copyLint.js) only gives instant feedback while a card is being edited or is unchecked.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { lintBatch, bodyWordCount, MAX_WORDS } from "./copyLint.js";
import { lockPageScroll, unlockPageScroll } from "./modalLock.js";
import { runCopyGate } from "./copyGate.js";
import { loadHistoryHTML } from "./copyHistory.js";
import { claudeHelpHTML, wireClaudeHelp } from "./claudeHelp.js";
import { $, msg, plural, prettyDay } from "./copyCommon.js";

const PAGE = 40;
const FIELDS = [
  { key: "email_subject", label: "Subject", rows: 1 },
  { key: "email_1", label: "Email 1", rows: 7 },
  { key: "email_2", label: "Follow-up", rows: 5 },
];
const SRV = "copy_ok, copy_errors, copy_warnings, copy_hash, seq_state";
const STATUS_LABEL = { ready: "Ready", fix: "Needs fixing", unch: "Not checked yet" };

async function selectAll(listId, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("dials").select(cols).eq("list_id", listId).eq("sequence", "email5")
      .eq("seq_state", "awaiting_copy").order("company_name", { ascending: true }).order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export function approvalLine(a) {
  const cap = a.daily_capacity || 0;
  let t = `Started ${a.started ?? 0} · ${a.held ?? 0} held`;
  if (a.started) t += ` · first emails go out ${a.first_send_day ? prettyDay(a.first_send_day) : "soon"} between 8am-5pm MT`;
  if (cap) t += ` · your mailboxes can send ${cap}/day`;
  if (cap && a.started > cap) t += ` · this list will take about ${Math.ceil(a.started / cap)} business days to finish sending`;
  return t;
}

export async function openCopyReview(list, { onChanged } = {}) {
  lockPageScroll();
  const wasApproved = list.copy_status === "approved";
  const panel = $(`<div class="cr-panel" role="dialog" aria-label="Review email copy">
    <div class="cr-head">
      <div class="cr-head-row"><h2>Review emails · ${escapeHtml(list.name || "")}</h2><button type="button" class="fs-close cr-close" aria-label="Close">&times;</button></div>
      <div class="cr-counts" id="crCounts"></div>
      <label class="cr-filter"><input type="checkbox" id="crProblems" /> Show problems only</label>
      <div class="cr-result" id="crResult"></div>
      <button type="button" class="btn cr-approve" id="crApprove" disabled>Send the ready emails</button>
      <div class="cr-why" id="crWhy"></div>
      ${claudeHelpHTML(list.name || "this list")}
    </div>
    <div class="cr-body" id="crBody"><div class="help-text">Loading emails...</div></div>
  </div>`);
  document.body.appendChild(panel);
  wireClaudeHelp(panel);
  const q = (id) => panel.querySelector("#" + id);
  const body = q("crBody");
  let leads = [], local = new Map(), shown = PAGE, approved = wasApproved, busy = false, changed = false, startedLater = 0, gateErr = "";

  const close = () => { panel.remove(); unlockPageScroll(); document.removeEventListener("keydown", onKey); if (changed) onChanged && onChanged(); };
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".cr-modal-bd")) close(); };
  document.addEventListener("keydown", onKey);
  panel.querySelector(".cr-close").onclick = close;

  const pending = (l) => FIELDS.some((f) => (l[f.key] ?? "") !== (l._saved?.[f.key] ?? ""));
  const statusOf = (l) => (pending(l) || !l.copy_hash ? "unch" : l.copy_ok ? "ready" : "fix");
  const issuesOf = (l) => (statusOf(l) === "unch" ? local.get(l.id) : { errors: l.copy_errors || [], warnings: l.copy_warnings || [] }) || { errors: [], warnings: [] };
  const counts = () => { const c = { ready: 0, fix: 0, unch: 0 }; leads.forEach((l) => c[statusOf(l)]++); return c; };

  function updateHeader() {
    local = lintBatch(leads);
    const c = counts(), btn = q("crApprove"), why = q("crWhy"), notReady = c.fix + c.unch;
    q("crCounts").innerHTML = `<span class="cr-pill ok">${c.ready} ready</span><span class="cr-pill ${c.fix ? "err" : ""}">${c.fix} need fixing</span>${c.unch ? `<span class="cr-pill warn">${c.unch} not checked yet</span>` : ""}`;
    btn.style.display = approved ? "none" : "";
    btn.textContent = `Send the ${c.ready} ready ${c.ready === 1 ? "email" : "emails"}`;
    btn.disabled = busy || c.ready === 0;
    why.classList.toggle("bad", !!gateErr);
    why.textContent = gateErr || (notReady ? `${notReady} ${notReady === 1 ? "needs" : "need"} fixing — they'll send automatically once fixed.` : (!leads.length ? "" : approved ? "Fixed drafts start sending automatically." : ""));
  }

  const issuesHTML = (r) => r.errors.map((e) => `<li class="e">${escapeHtml(e)}</li>`).join("") + r.warnings.map((w) => `<li class="w">${escapeHtml(w)}</li>`).join("");
  const wc = (l) => `${bodyWordCount(l.email_1)}/${MAX_WORDS} words`;
  const chip = (l) => { const s = statusOf(l); return `<span class="cr-chip ${s}">${STATUS_LABEL[s]}</span>`; };

  function cardHTML(l) {
    const r = issuesOf(l);
    return `<div class="cr-card ${r.errors.length ? "has-err" : r.warnings.length ? "has-warn" : ""}" data-id="${l.id}">
      <div class="cr-card-top"><div><b>${escapeHtml(l.company_name || "(no company)")}</b><div class="cr-to">${escapeHtml(l.full_name || "")} &lt;${escapeHtml(l.email || "")}&gt;</div></div><div class="cr-card-side"><span class="cr-chipbox">${chip(l)}</span><span class="cr-wc">${wc(l)}</span></div></div>
      <ul class="cr-issues">${issuesHTML(r)}</ul>
      ${FIELDS.map((f) => `<label class="cr-field"><span>${f.label}</span><textarea data-f="${f.key}" rows="${f.rows}" spellcheck="true">${escapeHtml(l[f.key] || "")}</textarea></label>`).join("")}
      <div class="cr-card-foot"><div class="cr-save"></div><button type="button" class="cr-hist-btn">History</button></div><div class="cr-hist hidden"></div></div>`;
  }

  function renderList() {
    const only = q("crProblems").checked;
    const vis = leads.filter((l) => !only || statusOf(l) !== "ready" || issuesOf(l).warnings.length);
    if (!leads.length) {
      body.innerHTML = approved
        ? `<div class="cr-done"><div class="cr-done-big">No held drafts left</div><p>Every draft passed the check and is in the sequence.</p><button type="button" class="btn" id="crDone">Done</button></div>`
        : `<div class="empty-state">No emails are waiting for review on this list.</div>`;
      const d = body.querySelector("#crDone"); if (d) d.onclick = close;
      return;
    }
    if (!vis.length) { body.innerHTML = `<div class="empty-state">No problems found.</div>`; return; }
    body.innerHTML = vis.slice(0, shown).map(cardHTML).join("") +
      (vis.length > shown ? `<button type="button" class="btn secondary cr-more">Show more (${vis.length - shown} left)</button>` : "");
    const more = body.querySelector(".cr-more");
    if (more) more.onclick = () => { shown += PAGE; renderList(); };
  }

  function refreshCards() {
    body.querySelectorAll(".cr-card").forEach((card) => {
      const l = leads.find((x) => x.id === card.dataset.id); if (!l) return;
      const r = issuesOf(l);
      card.classList.toggle("has-err", r.errors.length > 0);
      card.classList.toggle("has-warn", !r.errors.length && r.warnings.length > 0);
      card.querySelector(".cr-issues").innerHTML = issuesHTML(r);
      card.querySelector(".cr-chipbox").innerHTML = chip(l);
      card.querySelector(".cr-wc").textContent = wc(l);
    });
  }
  const repaint = () => { updateHeader(); refreshCards(); };

  // ---- server check: run copy-gate, then pull the fresh status columns (text is never overwritten)
  let gateQ = Promise.resolve();
  const check = () => (gateQ = gateQ.then(async () => {
    try {
      const { summary } = await runCopyGate(list.id);
      const rows = await selectAll(list.id, "id, " + SRV);
      const fresh = new Map(rows.map((r) => [r.id, r]));
      const before = leads.length;
      leads = leads.filter((l) => fresh.has(l.id) || pending(l));
      leads.forEach((l) => { const f = fresh.get(l.id); if (f && !pending(l)) Object.assign(l, f); });
      if (summary?.started_now) { startedLater += summary.started_now; changed = true; q("crResult").textContent = `${plural(startedLater, "fixed draft", "fixed drafts")} joined the sequence.`; }
      if (leads.length !== before) renderList();
      gateErr = "";
    } catch (e) { gateErr = "Could not check with the server: " + msg(e); }
    repaint();
  }));

  let t = null;
  body.addEventListener("input", (e) => {
    const ta = e.target.closest("textarea[data-f]"); if (!ta) return;
    const l = leads.find((x) => x.id === ta.closest(".cr-card").dataset.id);
    l[ta.dataset.f] = ta.value;
    clearTimeout(t); t = setTimeout(repaint, 250);
  });
  const inflight = new Set();
  function saveField(l, field, saveEl) {
    const val = l[field] ?? "";
    if (l._saved[field] === val) return Promise.resolve(true);
    if (saveEl) { saveEl.className = "cr-save"; saveEl.textContent = "Saving..."; }
    const p = supabase.from("dials").update({ [field]: val }).eq("id", l.id).then(({ error }) => {
      if (error) { if (saveEl) { saveEl.className = "cr-save bad"; saveEl.textContent = "Not saved: " + msg(error); } return false; }
      l._saved[field] = val; l.copy_hash = null; l.copy_ok = false; changed = true;
      if (saveEl) { saveEl.className = "cr-save ok"; saveEl.textContent = "Saved, checking..."; }
      return true;
    });
    inflight.add(p); p.finally(() => inflight.delete(p));
    return p;
  }
  body.addEventListener("focusout", async (e) => {
    const ta = e.target.closest("textarea[data-f]"); if (!ta) return;
    const card = ta.closest(".cr-card"), l = leads.find((x) => x.id === card.dataset.id), se = card.querySelector(".cr-save");
    l[ta.dataset.f] = ta.value;
    if (!(await saveField(l, ta.dataset.f, se))) return;
    await check();
    const cur = body.querySelector(`.cr-card[data-id="${l.id}"] .cr-save`);
    if (cur && cur.classList.contains("ok")) { cur.textContent = "Saved"; setTimeout(() => { if (cur.textContent === "Saved") cur.textContent = ""; }, 1500); }
  });
  body.addEventListener("click", async (e) => {
    const b = e.target.closest(".cr-hist-btn"); if (!b) return;
    const card = b.closest(".cr-card"), box = card.querySelector(".cr-hist");
    if (!box.classList.toggle("hidden")) { box.innerHTML = `<div class="help-text">Loading...</div>`; box.innerHTML = await loadHistoryHTML(card.dataset.id); }
  });
  q("crProblems").onchange = () => { shown = PAGE; renderList(); };

  q("crApprove").onclick = async () => {
    if (busy || approved) return;
    busy = true; updateHeader(); q("crApprove").textContent = "Sending...";
    const saved = (await Promise.all(leads.flatMap((l) => FIELDS.map((f) => saveField(l, f.key, body.querySelector(`.cr-card[data-id="${l.id}"] .cr-save`)))))).every(Boolean);
    if (!saved) { busy = false; gateErr = "Some edits could not be saved. Check the cards marked 'Not saved'."; return repaint(); }
    await check(); busy = false;
    if (gateErr || !counts().ready) return repaint();
    busy = true; updateHeader();
    const { data, error } = await supabase.rpc("approve_list_copy", { p_list_id: list.id });
    busy = false;
    if (error) { gateErr = "Could not send: " + msg(error); return repaint(); }
    approved = true; changed = true; gateErr = "";
    q("crResult").textContent = approvalLine(data || {});
    await check(); renderList(); repaint();
  };

  try {
    leads = await selectAll(list.id, "id, full_name, company_name, email, email_subject, email_1, email_2, " + SRV);
    leads.forEach((l) => (l._saved = { email_subject: l.email_subject || "", email_1: l.email_1 || "", email_2: l.email_2 || "" }));
    updateHeader(); renderList();
    q("crWhy").textContent = "Checking with the server...";
    await check();
  } catch (e) {
    body.innerHTML = `<div class="error-msg">Could not load emails: ${escapeHtml(msg(e))}</div><button type="button" class="btn secondary" id="crRetry">Try again</button>`;
    q("crRetry").onclick = () => { close(); openCopyReview(list, { onChanged }); };
  }
}
