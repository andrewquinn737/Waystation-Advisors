// Dials home: ONE call sheet sorted by priority, under a one-line Emails bar.
//   Bar:   "X of Y sent today · N ready" + Send (email_queue_status + start-emails)
//   Sheet: ten priority groups built from my_followups (groups 1-2) and the list's dials (groups 3-10); a company shows once,
//          in the highest group it qualifies for. dials.js owns the list data and the company card; this file owns the sheet.
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { escapeHtml as esc } from "./clientForm.js";
import { openCopyReview } from "./copyReview.js";

const TZ = "America/Denver";
const PAGE = 100; // rows rendered per group before "Show more"
const $ = (id) => document.getElementById(id);
const KIND = { call: "Call", call_company: "Call company line", linkedin: "LinkedIn", reply: "Reply" };
const CALL_KINDS = ["call", "call_company"];
const validTz = (z) => { try { new Intl.DateTimeFormat("en-CA", { timeZone: z }); return true; } catch { return false; } };
const localDate = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

// "Ready to send" = a lead on an email sequence whose copy passed the server check and has not started yet.
export const isReadyToSend = (d) => d.sequence === "email5" && d.seq_state === "awaiting_copy" && d.copy_ok === true && !!d.copy_hash;
export const needsFix = (d) => d.sequence === "email5" && d.seq_state === "awaiting_copy" && !isReadyToSend(d);


// Priority groups, top to bottom. Number + label carry the meaning; colour (css/dialsHome.css .dh-gN) is secondary.
const GROUPS = [
  { n: 1, label: "Past due" }, { n: 2, label: "Due today" }, { n: 3, label: "Not called yet" }, { n: 4, label: "Intro calls" },
  { n: 5, label: "Callback · Interested" }, { n: 6, label: "Callback · Busy" }, { n: 7, label: "No response" },
  { n: 8, label: "Finished sequence", closed: true }, { n: 9, label: "Dead number", closed: true }, { n: 10, label: "Not interested", closed: true },
];
const byName = (a, b) => (a.d.company_name || a.d.full_name || "").localeCompare(b.d.company_name || b.d.full_name || "", undefined, { sensitivity: "base" });
const byCallback = (a, b) => (a.d.callback_at ? Date.parse(a.d.callback_at) : Infinity) - (b.d.callback_at ? Date.parse(b.d.callback_at) : Infinity) || byName(a, b);
const SORT = { 1: null, 2: null, 4: byCallback, 5: byCallback, 6: byCallback };
const sameDay = (a, b) => a.toDateString() === b.toDateString();
function callbackText(iso) {
  const d = new Date(iso), now = new Date(), day = 86400000;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();
  const when = sameDay(d, now) ? "Today" : sameDay(d, new Date(now.getTime() + day)) ? "Tomorrow" : sameDay(d, new Date(now.getTime() - day)) ? "Yesterday"
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return { text: `${when} ${time}`, missed: d.getTime() < Date.now() - 30 * 60000 };
}

export function initDialsHome({ profile, getList, getDials, openCard, onSent, isSheet, isHidden, rowIcons, wireIcons }) {
  let tasks = [], taskDials = [], followErr = "", queue = null, queueErr = false, started = null;
  let emptyText = "You're all caught up.", groups = [];
  const tz = validTz(profile?.timezone) ? profile.timezone : TZ;
  const wrap = () => $("dialsTableWrap");
  const openState = new Map(), shown = new Map(); // group n -> open? / rows rendered

  // ---- tasks (my_followups) -------------------------------------------------------------------------------------
  const rank = (t) => (t.kind === "reply" ? 0 : 1);
  async function loadFollowups() {
    const { data, error } = await supabase.from("my_followups").select("*").limit(500);
    if (error) { followErr = "Couldn't load follow-ups."; if (isSheet()) renderSheet(); return; }
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
    if (isSheet()) renderSheet();
  }

  // ---- the sheet: which group does a company belong in? ------------------------------------------------------------
  // Active email sequence with nothing due: not shown (it surfaces when a step is due). Appointments (4-6) always show.
  function groupFor(d) {
    const st = d.contact_status || "uncontacted", running = d.sequence === "email5" && (d.seq_state === "active" || d.seq_state === "awaiting_copy");
    if (st === "intro_call_scheduled") return 4;
    if (st === "callback_interested") return 5;
    if (st === "busy_callback") return 6;
    if (running) return 0;
    if (st === "no_response") return 7;
    if (st === "unable_to_contact") return 9;
    if (st === "not_interested") return 10;
    if (st === "uncontacted") return d.sequence === "email5" && d.seq_state === "completed" ? 8 : 3;
    return 0;
  }
  function buildGroups() {
    const today = localDate(tz), list = getList(), mine = list ? getDials().filter((d) => d.list_id === list.id) : [];
    const cur = new Map(mine.map((d) => [d.id, d])), buckets = GROUPS.map(() => []), placed = new Set();
    // groups 1-2: one row per company, from its most urgent open task (replies first)
    const per = new Map();
    for (const t of tasks) (per.get(t.dial_id) || per.set(t.dial_id, []).get(t.dial_id)).push(t);
    const dialOf = new Map(taskDials.map((d) => [d.id, d]));
    for (const [id, ts] of per) {
      const d = cur.get(id) || dialOf.get(id); if (!d) continue;
      const late = ts.filter((t) => t.due_on && t.due_on < today), pool = late.length ? late : ts;
      const t = pool.slice().sort((a, b) => rank(a) - rank(b) || String(a.due_on).localeCompare(String(b.due_on)))[0];
      buckets[late.length ? 0 : 1].push({ d, t, late: late.length ? dayDiff(today, t.due_on) : 0 });
      placed.add(id);
    }
    for (const d of mine) {
      if (placed.has(d.id) || (isHidden && isHidden(d))) continue;
      const g = groupFor(d); if (g) buckets[g - 1].push({ d });
    }
    return GROUPS.map((g, i) => {
      const items = buckets[i], sort = SORT[g.n] === undefined ? byName : SORT[g.n];
      if (sort) items.sort(sort); // groups 1-2 keep the task order (replies first, then oldest due)
      return { ...g, items };
    }).filter((g) => g.items.length);
  }

  // ---- render --------------------------------------------------------------------------------------------------
  const isOpen = (g) => (openState.has(g.n) ? openState.get(g.n) : !g.closed);
  function rowHtml(g, it) {
    const { d, t } = it, who = [d.full_name, [d.city, d.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    const bits = [];
    if (t) {
      bits.push(`<b>${esc(KIND[t.kind])}</b>`);
      if (t.seq_day) bits.push(`Day ${esc(t.seq_day)}`);
      if (it.late) bits.push(`<span class="dh-late">${it.late}d late</span>`);
      if (t.kind === "reply") bits.push(`<a class="dh-msg" href="messages.html" data-stop>Messages</a>`);
    } else if (d.callback_at && [4, 5, 6].includes(g.n)) {
      const c = callbackText(d.callback_at);
      bits.push(`<span class="${c.missed ? "dh-late" : "dh-when"}">${c.missed ? "Missed · " : ""}${esc(c.text)}</span>`);
    }
    const done = t && (t.kind === "reply" || t.kind === "linkedin") ? `<button type="button" class="btn secondary small dh-act" data-done="${esc(t.id)}">Done</button>` : "";
    const icons = done || !rowIcons ? "" : rowIcons(d);
    return `<div class="mobile-card clickable-row dh-row dh-g${g.n}" role="button" tabindex="0" data-d="${esc(d.id)}">
      <div class="mc-main"><div class="mc-name">${esc(d.company_name || d.full_name || "(no name)")}</div>
        <div class="mc-sub">${esc(who || "—")}</div>
        <div class="dh-meta"><span class="dh-tag"><i>${g.n}</i>${esc(g.label)}</span>${bits.length ? `<span class="dh-bits">${bits.join(" · ")}</span>` : ""}</div></div>
      <div class="dh-side">${done}${icons}</div></div>`;
  }
  function bodyHtml(g) {
    const n = Math.min(g.items.length, shown.get(g.n) || PAGE), more = g.items.length - n;
    return g.items.slice(0, n).map((it) => rowHtml(g, it)).join("") +
      (more > 0 ? `<button type="button" class="dh-more" data-more="${g.n}">Show ${Math.min(PAGE, more)} more (${more} left)</button>` : "");
  }
  function sectionHtml(g) {
    const open = isOpen(g);
    return `<section class="dh-grp dh-g${g.n}${open ? " open" : ""}" data-g="${g.n}">
      <button type="button" class="dh-gh" aria-expanded="${open}"><i class="dh-num">${g.n}</i><span class="dh-gl">${esc(g.label)}</span><span class="dh-gc">${g.items.length}</span><span class="dh-chev" aria-hidden="true"></span></button>
      <div class="dh-gb">${open ? bodyHtml(g) : ""}</div></section>`;
  }
  function mountRows(root) { if (wireIcons) wireIcons(root); }
  function renderSheet(empty) {
    if (typeof empty === "string") emptyText = empty;
    const w = wrap(); if (!w) return;
    groups = buildGroups();
    const err = followErr ? `<div class="dh-empty">${esc(followErr)} <button type="button" class="dh-link" data-retry>Retry</button></div>` : "";
    w.innerHTML = err + (groups.length ? groups.map(sectionHtml).join("") : `<div class="dh-empty dh-done">${esc(emptyText)}</div>`);
    mountRows(w);
  }
  // Order of the rows on screen (prev/next in the company card follows it).
  const visibleDials = () => groups.filter(isOpen).flatMap((g) => g.items.slice(0, shown.get(g.n) || PAGE).map((it) => it.d));
  function redrawGroup(n) {
    const g = groups.find((x) => x.n === n), sec = wrap().querySelector(`[data-g="${n}"]`); if (!g || !sec) return;
    sec.outerHTML = sectionHtml(g);
    mountRows(wrap().querySelector(`[data-g="${n}"]`));
  }
  const cardClick = (e) => {
    if (e.target.closest("[data-retry]")) return loadFollowups();
    if (e.target.closest("[data-stop], .contact-actions")) return;
    const more = e.target.closest("[data-more]");
    if (more) { const n = +more.dataset.more; shown.set(n, (shown.get(n) || PAGE) + PAGE); return redrawGroup(n); }
    const head = e.target.closest(".dh-gh");
    if (head) { const g = groups.find((x) => x.n === +head.parentElement.dataset.g); openState.set(g.n, !isOpen(g)); return redrawGroup(g.n); }
    const done = e.target.closest("[data-done]");
    if (done) return finishTask(done);
    const row = e.target.closest("[data-d]");
    if (row) { const set = visibleDials(); openCard(set, set.findIndex((d) => d.id === row.dataset.d)); }
  };
  async function finishTask(btn) {
    btn.disabled = true;
    const { error } = await supabase.rpc("complete_sequence_task", { p_task_id: btn.dataset.done, p_outcome: "done", p_note: null, p_skip: false });
    if (error) { btn.disabled = false; followErr = "Couldn't save that: " + error.message; return renderSheet(); }
    tasks = tasks.filter((x) => x.id !== btn.dataset.done); renderSheet();
  }
  // One delegated listener on the wrapper (dials.js re-renders its inner html, never the wrapper itself).
  $("dialsTableWrap").addEventListener("click", (e) => { if (isSheet()) cardClick(e); });
  $("dialsTableWrap").addEventListener("keydown", (e) => { if (isSheet() && (e.key === "Enter" || e.key === " ") && e.target.matches("[data-d]")) { e.preventDefault(); e.target.click(); } });

  // ---- Emails bar ----------------------------------------------------------------------------------------------
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
    return cap ? `${sent} of ${cap} sent today` : `${sent} sent today`;
  }
  // One line: "X of Y sent today · N ready" + Send. Nothing ready: just the status text (plus a fix link when copy needs one).
  function renderEmails() {
    const bar = $("dhBar"); if (!bar) return;
    const list = getList(), n = list ? readyCount() : 0, fix = list ? getDials().filter((d) => d.list_id === list.id && needsFix(d)).length : 0;
    const line = [queueLine(), n ? `${n} ready` : ""].filter(Boolean).join(" · ");
    bar.hidden = !line && !fix;
    bar.innerHTML = `<span class="dh-bar-text">${esc(line)}</span>
      ${fix ? `<button type="button" class="dh-link" id="dhFixBtn">${plural(fix, "needs", "need")} a fix</button>` : ""}
      ${n ? `<button type="button" class="btn small dh-send" id="dhSendBtn">Send</button>` : ""}`;
    $("dhSendBtn")?.addEventListener("click", () => openSheet(n));
    $("dhFixBtn")?.addEventListener("click", openFix);
  }
  const openFix = () => openCopyReview(getList(), { onChanged: onSent });

  function openSheet(n) {
    const list = getList();
    const sheet = document.createElement("div");
    sheet.className = "dh-sheet-bd";
    sheet.innerHTML = `<div class="dh-sheet" role="dialog" aria-label="Send emails">
      <div class="dh-sheet-main"><h2>Send emails</h2>
      <label class="dh-lbl" for="dhCount">How many?</label>
      <input id="dhCount" class="dh-cnt" type="number" inputmode="numeric" min="1" max="${n}" value="${n}" />
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
    renderSheet,
    // The call task still waiting for an outcome on this company (completed when its outcome is saved on the card).
    callTaskFor: (dialId) => tasks.find((t) => t.dial_id === dialId && CALL_KINDS.includes(t.kind)) || null,
    taskDone(id) { tasks = tasks.filter((t) => t.id !== id); if (isSheet()) renderSheet(); },
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadFollowups(); loadQueue(); } });
  loadFollowups(); loadQueue();
  return api;
}
