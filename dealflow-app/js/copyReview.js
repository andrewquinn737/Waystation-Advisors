// Email-sequence UI for the Dials page: import result + mandate picker, "Run sequence setup",
// the review banner, and the per-lead sequence badge + Stop action.
// The review screen itself is in copyReviewScreen.js; the server check call is in copyGate.js.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { runCopyGate } from "./copyGate.js";
import { openCopyReview } from "./copyReviewScreen.js";
import { $, msg, plural, prettyDay, prettyDate, seqDayNumber, confirmBox, infoBox } from "./copyCommon.js";

export { openCopyReview, prettyDay, seqDayNumber };

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
  const r = data || { email_sequence: 0, call_sequence: 0, missing_copy: 0 };
  // Server check right away, so the review opens with server results. A failure here is not fatal:
  // the review screen runs the check again when it opens.
  try { r.gate = await runCopyGate(listId); } catch (e) { r.gate_error = msg(e); }
  return r;
}
export function describePrepare(r) {
  const e = r.email_sequence || 0, c = r.call_sequence || 0, m = r.missing_copy || 0;
  const parts = [
    `${plural(e, "company", "companies")} with a personal email → email sequence (waiting for copy approval)`,
    `${c} without → calling starts today (3-call sequence)`,
  ];
  if (m) parts.push(`${plural(m, "email row is", "email rows are")} missing copy`);
  if (r.gate) parts.push(`server check: ${r.gate.summary?.passed ?? 0} ready, ${r.gate.summary?.held ?? 0} need fixing`);
  else if (r.gate_error) parts.push("server check will run when you open the review");
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
  const approved = list.copy_status === "approved";
  if (list.copy_status === "pending_review" || approved) {
    if (!approved) container.innerHTML = `<div class="cr-banner"><span class="cr-banner-text">Checking copy...</span></div>`;
    const { count, error } = await supabase.from("dials").select("id", { count: "exact", head: true })
      .eq("list_id", list.id).eq("sequence", "email5").eq("seq_state", "awaiting_copy");
    if (token !== container._tok) return;
    if (approved && !error && !count) { await approvedStatusLine(container, list, token); return; }
    const label = error ? "Review emails before they send"
      : approved ? `${plural(count, "held draft needs", "held drafts need")} fixing`
      : `Review ${plural(count || 0, "email", "emails")} before they send`;
    container.innerHTML = `<div class="cr-banner"><span class="cr-banner-text">${escapeHtml(label)}</span><button type="button" class="btn cr-banner-btn">Review</button></div>`;
    container.querySelector("button").onclick = () => openCopyReview(list, { onChanged });
  }
}

async function approvedStatusLine(container, list, token) {
  let who = "";
  if (list.copy_approved_by) {
    const { data } = await supabase.from("profiles").select("full_name").eq("id", list.copy_approved_by).maybeSingle();
    who = data?.full_name || "";
  }
  if (token !== container._tok) return;
  const when = list.copy_approved_at ? ` on ${prettyDate(list.copy_approved_at)}` : "";
  container.innerHTML = `<div class="cr-status">Copy approved${who ? ` by ${escapeHtml(who)}` : ""}${when} · sequence running</div>`;
}
