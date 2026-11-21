// Dials home: three plain sections above/around the dials list.
//   1. Follow up now (my_followups)   2. Emails (email_queue_status + start-emails)   3. Backup numbers (the dials list itself)
// dials.js owns the list and the company card; this file owns the other two sections and the collapse behaviour.
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { escapeHtml as esc } from "./clientForm.js";
import { openCopyReview } from "./copyReview.js";

const TZ = "America/Denver";
const $ = (id) => document.getElementById(id);
const KIND = { call: "Call", call_company: "Call company line", linkedin: "LinkedIn", reply: "Reply" };
const CALL_KINDS = ["call", "call_company"];
const denverDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const fmtTime = (ts) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date(ts)).replace(" ", "").toLowerCase();
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

// "Ready to send" = a lead on an email sequence whose copy passed the server check and has not started yet.
export const isReadyToSend = (d) => d.sequence === "email5" && d.seq_state === "awaiting_copy" && d.copy_ok === true && !!d.copy_hash;
export const needsFix = (d) => d.sequence === "email5" && d.seq_state === "awaiting_copy" && !isReadyToSend(d);

export function initDialsHome({ profile, getList, getDials, openCard, onSent, isPhone }) {
  let tasks = [], taskDials = [], followErr = "", queue = null, queueErr = false, started = null;
  const open = new Set();
  let opened = false, userToggled = false;
  const sec = { follow: $("dhFollow"), emails: $("dhEmails"), backup: $("dhBackup") };
  let backupCount = 0;

  // ---- collapse -----------------------------------------------------------------------------------------------
  function setOpen(key, on) {
    on ? open.add(key) : open.delete(key);
    sec[key].classList.toggle("open", on);
    sec[key].querySelector(".dh-head").setAttribute("aria-expanded", String(on));
  }
  function counts() { return { follow: tasks.length, emails: readyCount() + (queue?.sent_today ?? 0), backup: backupCount }; }
  // On a phone only the first section with something in it is open; on a computer everything is.
  function autoOpen() {
    if (userToggled) return;
    const c = counts(), first = ["follow", "emails", "backup"].find((k) => c[k] > 0);
    for (const k of ["follow", "emails", "backup"]) setOpen(k, isPhone() ? k === (first || "follow") : true);
  }
  for (const k of Object.keys(sec)) sec[k].querySelector(".dh-head").addEventListener("click", () => { userToggled = true; setOpen(k, !open.has(k)); });

  // ---- 1. Follow up now ---------------------------------------------------------------------------------------
  const rank = (t) => (t.kind === "reply" ? 0 : 1);
  async function loadFollowups() {
    const { data, error } = await supabase.from("my_followups").select("*").limit(500);
    if (error) { followErr = "Couldn't load follow-ups. Tap Retry."; renderFollow(); return; }
    followErr = "";
    tasks = (data || []).filter((t) => KIND[t.kind] && !["done", "skipped"].includes(t.status) && (!t.owner_id || t.owner_id === profile.id))
      .map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || String(a.t.due_on).localeCompare(String(b.t.due_on)) || a.i - b.i).map((x) => x.t);
    const ids = [...new Set(tasks.map((t) => t.dial_id))], rows = [];
    for (let i = 0; i < ids.length; i += 60) {
      const { data: d } = await supabase.from("dials").select("*").in("id", ids.slice(i, i + 60));
      rows.push(...(d || []));
    }
    const byId = new Map(rows.map((d) => [d.id, d]));
    taskDials = ids.map((id) => byId.get(id)).filter(Boolean);
    tasks = tasks.filter((t) => byId.has(t.dial_id));
    renderFollow();
  }

  function renderFollow() {
    const body = $("dhFollowBody"), today = denverDate();
    $("dhFollowCount").textContent = tasks.length ? String(tasks.length) : "";
    if (followErr) body.innerHTML = `<div class="dh-empty">${esc(followErr)} <button type="button" class="dh-link" data-retry>Retry</button></div>`;
    else if (!tasks.length) body.innerHTML = `<div class="dh-empty">Nothing to follow up on right now.</div>`;
    else body.innerHTML = tasks.map((t, i) => {
      const late = t.due_on && t.due_on < today;
      const extra = t.kind === "reply"
        ? `<a class="btn secondary small dh-act" href="messages.html" data-stop>Messages</a><button type="button" class="btn secondary small dh-act" data-done="${i}">Done</button>`
        : t.kind === "linkedin" ? `<button type="button" class="btn secondary small dh-act" data-done="${i}">Done</button>` : "";
      return `<div class="mobile-card clickable-row dh-row" role="button" tabindex="0" data-i="${i}">
        <div class="mc-main"><div class="mc-name">${esc(t.company_name || t.full_name || "(no name)")}</div><div class="mc-sub"><b>${esc(KIND[t.kind])}</b>${t.full_name ? " · " + esc(t.full_name) : ""}</div></div>
        <div class="dh-side">${extra}<span class="dh-day ${late ? "late" : ""}">${late ? "Overdue" : t.seq_day ? "Day " + esc(t.seq_day) : "Today"}</span></div></div>`;
    }).join("");
    autoOpen();
  }
  $("dhFollowBody").addEventListener("click", async (e) => {
    if (e.target.closest("[data-retry]")) return loadFollowups();
    if (e.target.closest("[data-stop]")) return;
    const done = e.target.closest("[data-done]");
    if (done) {
      const t = tasks[+done.dataset.done]; done.disabled = true;
      const { error } = await supabase.rpc("complete_sequence_task", { p_task_id: t.id, p_outcome: "done", p_note: null, p_skip: false });
      if (error) { done.disabled = false; followErr = "Couldn't save that: " + error.message; renderFollow(); return; }
      tasks = tasks.filter((x) => x.id !== t.id); renderFollow(); return;
    }
    const row = e.target.closest("[data-i]");
    if (row) openCard(taskDials, taskDials.findIndex((d) => d.id === tasks[+row.dataset.i].dial_id));
  });
  $("dhFollowBody").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-i]")) { e.preventDefault(); e.target.click(); } });

  // ---- 2. Emails ----------------------------------------------------------------------------------------------
  const readyCount = () => getDials().filter((d) => d.list_id === getList()?.id && isReadyToSend(d)).length;
  async function loadQueue() {
    const { data, error } = await supabase.rpc("email_queue_status", { p_owner: profile.id });
    queueErr = !!error; queue = error ? null : (Array.isArray(data) ? data[0] : data) || null;
    renderEmails();
  }
  function queueLine() {
    if (queueErr) return "Couldn't load today's email count.";
    if (!queue) return "";
    const sent = queue.sent_today ?? 0, cap = queue.capacity_today;
    let s = cap ? `${sent} of ${cap} sent today` : `${sent} sent today`;
    const next = queue.next_send_at;
    if (next) s += ` · next at ${fmtTime(next)}`;
    return s;
  }
  function renderEmails() {
    const list = getList(), n = list ? readyCount() : 0, fix = list ? getDials().filter((d) => d.list_id === list.id && needsFix(d)).length : 0;
    const line = queueLine();
    $("dhEmailsCount").textContent = n ? `${n} ready` : "";
    $("dhEmailsBody").innerHTML = `${line ? `<div class="dh-line">${esc(line)}</div>` : ""}
      ${n ? `<div class="dh-line"><b>${n}</b> ready to send</div><button type="button" class="btn dh-big" id="dhSendBtn">Send emails</button>` : `<div class="dh-empty">No emails waiting to send in this list.</div>`}
      ${fix ? `<button type="button" class="dh-link" id="dhFixBtn">${plural(fix, "email needs", "emails need")} a fix</button>` : ""}`;
    $("dhSendBtn")?.addEventListener("click", () => openSheet(n));
    $("dhFixBtn")?.addEventListener("click", openFix);
    autoOpen();
  }
  const openFix = () => openCopyReview(getList(), { onChanged: onSent });

  function openSheet(n) {
    const list = getList();
    const sheet = document.createElement("div");
    sheet.className = "dh-sheet-bd";
    sheet.innerHTML = `<div class="dh-sheet" role="dialog" aria-label="Send emails">
      <div class="dh-sheet-main"><h2>Send emails</h2>
      <label class="dh-lbl" for="dhCount">How many?</label>
      <input id="dhCount" class="dh-num" type="number" inputmode="numeric" min="1" max="${n}" value="${n}" />
      <div class="dh-chips">${[10, 20].filter((c) => c < n).map((c) => `<button type="button" class="dh-chip" data-n="${c}">${c}</button>`).join("")}<button type="button" class="dh-chip" data-n="${n}">All (${n})</button></div>
      <p class="dh-note">Each of your mailboxes sends up to 20 a day, 8:30am–5pm your time, a few minutes apart.</p></div>
      <div class="dh-sheet-err" id="dhErr" role="alert"></div>
      <div class="dh-sheet-btns"><button type="button" class="btn secondary" id="dhCancel">Cancel</button><button type="button" class="btn" id="dhStart">Start</button></div></div>`;
    document.body.appendChild(sheet);
    const q = (s) => sheet.querySelector(s), input = q("#dhCount"), close = () => sheet.remove();
    sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
    q("#dhCancel").onclick = close;
    sheet.querySelectorAll("[data-n]").forEach((b) => (b.onclick = () => { input.value = b.dataset.n; }));
    q("#dhStart").onclick = async () => {
      const count = Math.max(1, Math.min(n, Math.floor(+input.value || 0)));
      if (!(+input.value >= 1)) { q("#dhErr").textContent = "Enter how many to send."; return; }
      const btn = q("#dhStart"); btn.disabled = true; btn.textContent = "Starting...";
      try {
        started = await startEmails(list.id, count);
        q(".dh-sheet-main").innerHTML = `<h2>Done</h2><p class="dh-result">${esc(resultSentence(started))}</p>`;
        q(".dh-sheet-err").textContent = ""; q(".dh-sheet-btns").innerHTML = `<button type="button" class="btn" id="dhOk">OK</button>`;
        q("#dhOk").onclick = close;
        loadQueue(); onSent && onSent();
      } catch (e) { q("#dhErr").textContent = e.message; btn.disabled = false; btn.textContent = "Start"; }
    };
  }
  function resultSentence(r) {
    const parts = [`Started ${plural(r.started ?? 0, "email", "emails")}`];
    if (r.held_for_copy) parts.push(`${r.held_for_copy} need a fix`);
    if (r.moved_to_backup) parts.push(`${r.moved_to_backup} moved to backup numbers`);
    let s = parts.join(", ") + ".";
    if (r.remaining_ready) s += ` ${r.remaining_ready} still ready.`;
    if (r.est_days_to_send_firsts > 1) s += ` The first emails finish going out in about ${r.est_days_to_send_firsts} business days.`;
    return s;
  }
  async function startEmails(listId, count) {
    const { data: { session } } = await supabase.auth.getSession();
    let res;
    try {
      res = await fetch(SUPABASE_URL + "/functions/v1/start-emails", { method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + (session?.access_token || "") },
        body: JSON.stringify({ list_id: listId, count }) });
    } catch { throw new Error("Couldn't reach the server. Check your connection and try again."); }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new Error(json?.error || `Couldn't start the emails (${res.status}).`);
    return json;
  }

  // ---- public ---------------------------------------------------------------------------------------------------
  const api = {
    refreshFollowups: loadFollowups,
    refreshEmails: renderEmails,
    // The call task still waiting for an outcome on this company (completed when its outcome is saved on the card).
    callTaskFor: (dialId) => tasks.find((t) => t.dial_id === dialId && CALL_KINDS.includes(t.kind)) || null,
    taskDone(id) { tasks = tasks.filter((t) => t.id !== id); renderFollow(); },
    setBackup({ count, title }) {
      backupCount = count; $("dhBackupCount").textContent = count ? String(count) : "";
      if (title) $("dhBackupTitle").textContent = title;
      autoOpen();
    },
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadFollowups(); loadQueue(); } });
  loadFollowups(); loadQueue();
  return api;
}
