// Admin > Campaigns: the launch sheet (preview BEFORE the click, result that accounts for every lead) and the list-details sheet.
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const day = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${MON[d.getMonth()]} ${d.getDate()}`; };
const ymd = (s) => { const d = new Date(String(s).slice(0, 10) + "T12:00:00"); return isNaN(d) ? "" : `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`; };
const MANDATE = { ma: "M&A", data: "Data" };
const sheetShell = (html) => { const el = document.createElement("div"); el.className = "ad-sheet-bd"; el.innerHTML = html; document.body.appendChild(el); return el; };
const rpc1 = (fn, args) => supabase.rpc(fn, args).then((r) => ({ data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }));

// ---- what a launch did, in numbers that add up -----------------------------------------------------------------------
export async function startEmails(listId, count) {
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
export function resultSentence(r) {
  const started = r.started ?? 0, why = [];
  if (r.bad_address ?? r.moved_to_backup) why.push(`${r.bad_address ?? r.moved_to_backup} with a bad address`);
  if (r.suppressed) why.push(`${r.suppressed} on the do-not-email list`);
  if (r.duplicate) why.push(`${r.duplicate} already in another campaign`);
  const moved = (r.bad_address ?? r.moved_to_backup ?? 0) + (r.suppressed || 0) + (r.duplicate || 0);
  let s = `${plural(started, "email", "emails")} started.`;
  if (moved) s += ` ${moved} moved to backup (calls only): ${why.join(", ")}.`;
  if (r.unverified) s += ` ${plural(r.unverified, "address couldn't", "addresses couldn't")} be checked right now and ${r.unverified === 1 ? "is" : "are"} still ready.`;
  if (r.held_for_copy) s += ` ${r.held_for_copy} need edits.`;
  if (r.remaining_ready) s += ` ${r.remaining_ready} still ready.`;
  if (r.backup_total) s += ` In this list ${r.backup_total} ${r.backup_total === 1 ? "lead is" : "leads are"} calls only${r.backup_no_email ? ` (${r.backup_no_email} with no email address)` : ""}.`;
  if (started) s += r.est_days_to_send_firsts > 1 ? ` First emails finish going out in about ${r.est_days_to_send_firsts} business days at this owner's mailbox capacity.` : " First emails go out today or the next business day.";
  return s;
}

// ---- launch sheet -----------------------------------------------------------------------------------------------------
function previewHTML(p, owner) {
  const boxes = p.mailboxes || [];
  const skip = [p.suppressed && `${p.suppressed} on the do-not-email list`, p.duplicate && `${p.duplicate} already in another campaign`].filter(Boolean);
  const lines = [`<p><b>${plural(p.ready, "email is", "emails are")} ready.</b>${skip.length ? ` ${p.suppressed + p.duplicate} will be skipped and moved to backup: ${skip.join(", ")}.` : ""} Addresses are checked first, so a few more may move to backup.</p>`];
  if (!boxes.length) lines.push(`<p class="warn">${esc(owner || "The owner")} has no ${esc(MANDATE[p.mandate] || "")} sending mailbox yet.</p>`);
  else {
    const dom = (p.domains || []).filter((d) => d.limited);
    lines.push(`<p>Sends from <b>${plural(boxes.length, MANDATE[p.mandate] ? MANDATE[p.mandate] + " mailbox" : "mailbox", MANDATE[p.mandate] ? MANDATE[p.mandate] + " mailboxes" : "mailboxes")}</b>, up to <b>${p.day_capacity} a day</b> in all, weekdays 8:30am to 5pm ${esc(p.timezone || "")}.</p>
      <ul class="cp-det-boxes">${boxes.map((m) => `<li>${esc(m.address)} <span class="ad-muted">${m.cap} a day${m.reason ? ", " + esc(m.reason) : ""}</span></li>`).join("")}</ul>
      ${dom.length ? `<p class="ad-muted">${dom.map((d) => `${esc(d.domain)} is capped at ${d.domain_cap} a day across its ${d.mailboxes} mailboxes`).join("; ")}.</p>` : ""}`);
    if (p.would_send > 0 && p.finish_on) lines.push(`<p>First emails start <b>${esc(ymd(p.first_send_day))}</b>${p.days_to_send_firsts > 1 ? ` and finish about <b>${esc(ymd(p.finish_on))}</b>` : " and are all out that day"}. Follow-ups go out on their own schedule after that.</p>`);
  }
  if (p.sample) lines.push(`<details class="cp-sample"><summary>First email: ${esc(p.sample.to || "")}</summary><div class="cp-sample-b"><b>${esc(p.sample.subject || "(no subject)")}</b><pre>${esc(p.sample.body || "")}</pre></div></details>`);
  return lines.join("");
}
export function openLaunch(c, onDone) {
  const n = c.counts.ready;
  const sheet = sheetShell(`<div class="ad-sheet" role="dialog" aria-label="Launch emails"><div class="ad-sheet-main"><h2>Launch ${esc(c.name)}</h2>
      <div id="adPrev" class="cp-prev"><p class="ad-muted">Working out who sends and when...</p></div>
      <div class="ad-row"><button type="button" class="btn" id="adAll">Send all ${n} ready</button></div>
      <label class="ad-lbl" for="adCount">Or send a number</label>
      <div class="ad-num"><input id="adCount" type="number" inputmode="numeric" min="1" max="${n}" placeholder="1 to ${n}" /><button type="button" class="btn secondary" id="adSome">Send</button></div></div>
    <div class="ad-err" id="adErr" role="alert"></div><button type="button" class="btn secondary" id="adCancel">Cancel</button></div>`);
  const q = (s) => sheet.querySelector(s), close = () => { sheet.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  q("#adCancel").onclick = close;
  rpc1("campaign_launch_preview", { p_list: c.list_id }).then(({ data, error }) => {
    if (!q("#adPrev")) return;
    q("#adPrev").innerHTML = error || !data ? `<p class="ad-muted">Couldn't work out the schedule (${esc(error?.message || "no answer")}). You can still launch.</p>` : previewHTML(data, c.owner);
  });
  let busy = false;
  const go = async (count) => {
    if (busy) return; busy = true; q("#adAll").disabled = q("#adSome").disabled = true; q("#adErr").textContent = "";
    q(".ad-sheet-main").insertAdjacentHTML("beforeend", `<p class="ad-muted" id="adWait">Checking addresses and starting...</p>`);
    try {
      const r = await startEmails(c.list_id, count);
      await supabase.rpc("campaign_launched", { p_list: c.list_id });
      q(".ad-sheet-main").innerHTML = `<h2>Launched</h2><p>${esc(resultSentence(r))}</p>`;
      const cancel = q("#adCancel"); cancel.textContent = "OK"; cancel.className = "btn"; onDone && onDone();
    } catch (e) { q("#adWait")?.remove(); q("#adErr").textContent = e.message; q("#adAll").disabled = q("#adSome").disabled = false; busy = false; }
  };
  q("#adAll").onclick = () => go(null);
  q("#adSome").onclick = () => { const v = Math.floor(+q("#adCount").value || 0); if (v < 1 || v > n) { q("#adErr").textContent = `Enter a number from 1 to ${n}.`; return; } go(v); };
}

// ---- list details sheet -----------------------------------------------------------------------------------------------
export async function openDetails(c) {
  const sheet = sheetShell(`<div class="ad-sheet" role="dialog" aria-label="List details"><div class="ad-sheet-main"><h2>${esc(c.name || "(untitled)")}</h2><div id="adDet"><p class="ad-muted">Loading...</p></div></div>
    <a class="btn" id="adOpen" href="dials.html?list=${encodeURIComponent(c.list_id)}">Open list on Calls</a><button type="button" class="btn secondary" id="adCancel">Close</button></div>`);
  const close = () => sheet.remove();
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  sheet.querySelector("#adCancel").onclick = close;
  const [total, queue, steps, lst] = await Promise.all([
    supabase.from("dials").select("id", { count: "exact", head: true }).eq("list_id", c.list_id).then((r) => r.count ?? 0),
    c.owner_id ? rpc1("email_queue_status", { p_owner: c.owner_id, p_mandate: c.mandate || null }) : Promise.resolve({}),
    rpc1("campaign_step_stats", { p_list: c.list_id }),
    supabase.from("dial_lists").select("buyer_id").eq("id", c.list_id).maybeSingle().then((r) => r.data),
  ]);
  let buyer = "";
  if (lst?.buyer_id) buyer = (await supabase.from("profiles").select("full_name").eq("id", lst.buyer_id).maybeSingle()).data?.full_name || "";
  const qd = queue?.data, boxes = qd?.mailboxes || [], n = c.counts, dl = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const boxHtml = boxes.length ? boxes.map((m) => `<li>${esc(m.address)} <span class="ad-muted">${Math.max(0, (m.cap ?? 0) - (m.used ?? 0))} of ${m.cap ?? 0} left today${m.reason ? ", " + esc(m.reason) : ""}</span></li>`).join("") : `<li class="ad-muted">No ${esc(MANDATE[c.mandate] || "")} mailbox yet. Add one under Email accounts.</li>`;
  const st = Array.isArray(steps.data) ? steps.data : [];
  const stepHtml = st.length ? `<h3 class="cp-det-h">By email step</h3><table class="cp-steps"><thead><tr><th></th><th>Sent</th><th>Replied</th><th>Bounced</th></tr></thead><tbody>${st.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.sent}</td><td>${s.replied}</td><td>${s.bounced}</td></tr>`).join("")}</tbody></table><p class="ad-muted cp-fine">Replied and bounced are counted at the last email the lead was sent. There is no open or click tracking on purpose: it needs a tracking pixel, which hurts deliverability.</p>` : "";
  const prog = n.active ? `<p class="ad-muted">${plural(n.active, "lead is", "leads are")} in a running sequence${qd?.next_send_at ? `; next email goes out ${new Date(qd.next_send_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}.</p>` : "";
  sheet.querySelector("#adDet").innerHTML = `<dl class="cp-det">
      ${dl("Owner", esc(c.owner || "Unknown"))}${dl("Mandate", esc(MANDATE[c.mandate] || "Not set"))}${dl("Buyer", esc(buyer || "None"))}${dl("Uploaded", esc(day(c.created_at)))}
      ${dl("On email track", (n.leads ?? 0).toLocaleString())}${dl("Backup (calls only)", (n.backup ?? 0).toLocaleString())}${dl("Total leads", total.toLocaleString())}${dl("Held for edits", (n.need_fix ?? 0).toLocaleString())}
    </dl>${prog}<h3 class="cp-det-h">${esc(MANDATE[c.mandate] || "Sending")} mailboxes${qd ? ` · ${qd.left_today ?? 0} of ${qd.day_capacity ?? 0} sends left today` : ""}</h3><ul class="cp-det-boxes">${boxHtml}</ul>${stepHtml}`;
}
