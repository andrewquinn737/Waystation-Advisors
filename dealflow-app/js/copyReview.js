// Email-sequence UI for the Dials page: import result + mandate picker, "Run sequence setup",
// the review banner, and the per-lead sequence badge + Stop action.
// The review screen itself is in copyReviewScreen.js; the server check call is in copyGate.js.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { runCopyGate } from "./copyGate.js";
import { openCopyReview } from "./copyReviewScreen.js";
import { $, msg, plural, prettyDay, seqDayNumber, confirmBox, infoBox } from "./copyCommon.js";

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
// Chunked and resumable: each call handles up to PREP_CHUNK leads and says how many are left; a failed chunk is retried, and a
// retry (or the "Run sequence setup" menu item) picks up exactly where it stopped because only unset leads are touched.
const PREP_CHUNK = 2500;
export async function prepareList(listId, onProgress) {
  const r = { email_sequence: 0, call_sequence: 0, missing_copy: 0 };
  for (let guard = 0; guard < 200; guard++) {
    let data = null, err = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      ({ data, error: err } = await supabase.rpc("seq_prepare_list", { p_list_id: listId, p_limit: PREP_CHUNK }));
      if (!err) break;
      await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
    }
    if (err) throw err;
    r.email_sequence += data?.email_sequence || 0; r.call_sequence += data?.call_sequence || 0; r.missing_copy += data?.missing_copy || 0;
    onProgress && onProgress(data?.remaining || 0);
    if (!data || !data.remaining) break;
  }
  // Server check right away, so the review opens with server results. A failure here is not fatal:
  // the review screen runs the check again when it opens.
  try { r.gate = await runCopyGate(listId); } catch (e) { r.gate_error = msg(e); }
  return r;
}
export function describePrepare(r) {
  const e = r.email_sequence || 0, c = r.call_sequence || 0, m = r.missing_copy || 0;
  const parts = [
    `${plural(e, "company", "companies")} with a personal email → email sequence (ready to send from Dials)`,
    `${c} without → backup numbers (call whenever)`,
  ];
  // One account of the email rows: the server check says how many are ready and how many are held for edits (rows with no copy
  // yet are among the held ones); without a server check, say how many have no copy.
  if (r.gate) {
    // Say WHY rows are held: the most common reasons, numbers stripped so "Email 1 is 91 words" groups with "Email 1 is 88 words".
    const tally = new Map();
    for (const x of r.gate.results || []) for (const er of x.ok ? [] : (x.errors || []).slice(0, 1)) { const k = String(er?.message || er).replace(/\d+/g, "N").replace(/: ".*$/, "").slice(0, 70); tally.set(k, (tally.get(k) || 0) + 1); }
    const why = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${k.replace(/N/g, "#")} (${n})`).join("; ");
    parts.push(`${r.gate.summary?.passed ?? 0} emails ready, ${r.gate.summary?.held ?? 0} held for edits${m ? ` (${m} of them have no copy yet)` : why ? ` (${why})` : ""}`);
  }
  else if (r.gate_error) { if (m) parts.push(`${plural(m, "email row is", "email rows are")} missing copy`); parts.push("server check will run when you open the review"); }
  else if (m) parts.push(`${plural(m, "email row is", "email rows are")} missing copy`);
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
