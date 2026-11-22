// Dials home: ONE call sheet sorted by priority, under a one-line Emails bar.
//   Bar:   status only: "X of Y sent today · next 2:14pm" (email_queue_status). Launching/reviewing emails is on campaigns.html (admins).
//   Sheet: eleven priority groups built from my_followups (groups 1-2) and the list's dials (groups 3-11); a company shows once,
//          in the highest group it qualifies for. dials.js owns the list data and the company card; this file owns the sheet.
import { supabase } from "./supabaseClient.js";
import { escapeHtml as esc } from "./clientForm.js";

const TZ = "America/Denver";
const PAGE = 100; // rows rendered per group before "Show more"
const $ = (id) => document.getElementById(id);
const KIND = { call: "Call", call_company: "Call company line", linkedin: "LinkedIn", reply: "Reply" };
const CALL_KINDS = ["call", "call_company"];
const DO = { call: "Call", call_company: "Call the office", linkedin: "Connect on LinkedIn", reply: "Answer their email" };
const validTz = (z) => { try { new Intl.DateTimeFormat("en-CA", { timeZone: z }); return true; } catch { return false; } };
const localDate = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);


// Priority groups, top to bottom. Number + label carry the meaning; colour (css/dialsHome.css) is only a faint 3px stripe.
const GROUPS = [
  { n: 1, label: "Past due" }, { n: 2, label: "Due today" }, { n: 3, label: "Not called yet" }, { n: 4, label: "Intro calls" },
  { n: 5, label: "Callback · Interested" }, { n: 6, label: "Callback · Busy" }, { n: 7, label: "No response" },
  { n: 8, label: "In sequence", closed: true }, // emailing now; no call due yet (shows the next step + date)
  { n: 9, label: "Finished sequence", closed: true }, { n: 10, label: "Dead number", closed: true }, { n: 11, label: "Not interested", closed: true },
];
const byName = (a, b) => (a.d.company_name || a.d.full_name || "").localeCompare(b.d.company_name || b.d.full_name || "", undefined, { sensitivity: "base" });
const byCallback = (a, b) => (a.d.callback_at ? Date.parse(a.d.callback_at) : Infinity) - (b.d.callback_at ? Date.parse(b.d.callback_at) : Infinity) || byName(a, b);
const byNext = (a, b) => String(a.next?.due_on || "9999").localeCompare(String(b.next?.due_on || "9999")) || byName(a, b);
const SORT = { 1: null, 2: null, 4: byCallback, 5: byCallback, 6: byCallback, 8: byNext };
const sameDay = (a, b) => a.toDateString() === b.toDateString();
function callbackText(iso) {
  const d = new Date(iso), now = new Date(), day = 86400000;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();
  const when = sameDay(d, now) ? "Today" : sameDay(d, new Date(now.getTime() + day)) ? "Tomorrow" : sameDay(d, new Date(now.getTime() - day)) ? "Yesterday"
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return { text: `${when} ${time}`, missed: d.getTime() < Date.now() - 30 * 60000 };
}

export function initDialsHome({ profile, getList, getDials, openCard, isSheet, isHidden, rowIcons, wireIcons }) {
  let tasks = [], taskDials = [], followErr = "", queue = null, queueErr = false;
  let nextByDial = new Map(); // dial_id -> its next upcoming step (for group 8 "In sequence")
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
    // next upcoming step per company in a running sequence (one query; RLS limits rows to what this person may see)
    const { data: up } = await supabase.from("sequence_tasks").select("dial_id, kind, due_on, seq_day")
      .in("status", ["pending", "queued"]).gt("due_on", localDate(tz)).order("due_on").limit(5000);
    nextByDial = new Map();
    for (const u of up || []) if (!nextByDial.has(u.dial_id)) nextByDial.set(u.dial_id, u);
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
    if (running) return 8; // in sequence, nothing due today (due steps were already placed in groups 1-2)
    if (st === "no_response") return 7;
    if (st === "unable_to_contact") return 10;
    if (st === "not_interested") return 11;
    if (st === "uncontacted") return d.sequence === "email5" && d.seq_state === "completed" ? 9 : 3;
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
      const g = groupFor(d); if (g) buckets[g - 1].push(g === 8 ? { d, next: nextByDial.get(d.id) } : { d });
    }
    return GROUPS.map((g, i) => {
      const items = buckets[i], sort = SORT[g.n] === undefined ? byName : SORT[g.n];
      if (sort) items.sort(sort); // groups 1-2 keep the task order (replies first, then oldest due)
      return { ...g, items };
    }).filter((g) => g.items.length);
  }

  // ---- render --------------------------------------------------------------------------------------------------
  // Only groups 1-3 (past due, due today, not called yet) start open; the rest are one tap away.
  const isOpen = (g) => (openState.has(g.n) ? openState.get(g.n) : g.n <= 3);
  function rowHtml(g, it) {
    const { d, t } = it, who = [d.full_name, [d.city, d.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    const bits = [g.label];
    if (t) {
      // follow-up: say what to do, plainly, first
      bits.length = 0;
      bits.push(`<b class="dh-do">${esc(DO[t.kind] || KIND[t.kind])}</b>`);
      bits.push(it.late ? `${it.late} day${it.late === 1 ? "" : "s"} late` : "today");
    } else if (g.n === 8) {
      const nx = it.next, NEXT = { email: "Email", followup_email: "Follow-up email", ...KIND };
      if (d.seq_state === "awaiting_copy") bits.push("First email not sent yet");
      else if (nx) bits.push(`Next: ${esc(NEXT[nx.kind] || nx.kind)} · ${esc(new Date(nx.due_on + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}`);
      else bits.push("Waiting for the first email to send");
    } else if (d.callback_at && [4, 5, 6].includes(g.n)) {
      const c = callbackText(d.callback_at);
      bits.push(`${c.missed ? "Missed · " : ""}${esc(c.text)}`);
    }
    const done = t ? actionHtml(t, d) : "";
    const icons = done || !rowIcons ? "" : rowIcons(d);
    return `<div class="mobile-card clickable-row dh-row dh-g${g.n}" role="button" tabindex="0" data-d="${esc(d.id)}">
      <div class="mc-main"><div class="mc-name">${esc(d.company_name || d.full_name || "(no name)")}</div>
        <div class="dh-meta">${bits.join(" · ")}</div>
        <div class="mc-sub">${esc(who || "—")}</div></div>
      <div class="dh-side">${done}${icons}</div></div>`;
  }
  // One clear button per follow-up: what to do, in words. Calls open the company card too, so the outcome is right there.
  function actionHtml(t, d) {
    const first = esc(String(d.full_name || "").trim().split(/\s+/)[0] || "");
    if (t.kind === "call" || t.kind === "call_company") {
      const num = t.kind === "call" ? (d.mobile_phone || d.company_phone) : (d.company_phone || d.mobile_phone);
      const label = t.kind === "call" ? (first ? `Call ${first}` : "Call") : "Call office";
      // Same call path as the company card's phone icon (.contact-action-call, handled in dials.js): in-app call or the phone's
      // dialer, and the contact is recorded for today either way.
      const method = num === d.mobile_phone ? "mobile" : "company";
      return num ? `<button type="button" class="btn small dh-act dh-go contact-action-call" data-dial-id="${esc(d.id)}" data-tel="${esc(num)}" data-method="${method}">${label}</button>`
                 : `<button type="button" class="btn small dh-act dh-go" data-open="${esc(d.id)}">Open</button>`;
    }
    const doneBtn = `<button type="button" class="btn secondary small dh-act" data-done="${esc(t.id)}">Done</button>`;
    if (t.kind === "linkedin") {
      const url = d.linkedin || ("https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent([d.full_name, d.company_name].filter(Boolean).join(" ")));
      return `<a class="btn small dh-act dh-go" href="${esc(url)}" target="_blank" rel="noopener" data-stop>Open LinkedIn</a>${doneBtn}`;
    }
    if (t.kind === "reply") {
      return `<a class="btn small dh-act dh-go" href="messages.html?from=${encodeURIComponent(d.email || "")}" data-stop>Read reply</a>${doneBtn}`;
    }
    return doneBtn;
  }
  function bodyHtml(g) {
    const n = Math.min(g.items.length, shown.get(g.n) || PAGE), more = g.items.length - n;
    return g.items.slice(0, n).map((it) => rowHtml(g, it)).join("") +
      (more > 0 ? `<button type="button" class="dh-more" data-more="${g.n}">Show ${Math.min(PAGE, more)} more (${more} left)</button>` : "");
  }
  function sectionHtml(g) {
    const open = isOpen(g);
    return `<section class="dh-grp dh-g${g.n}${open ? " open" : ""}" data-g="${g.n}">
      <button type="button" class="dh-gh" aria-expanded="${open}"><i class="dh-num">${g.n}</i><span class="dh-gl">${esc(g.label)} · ${g.items.length}</span><span class="dh-chev" aria-hidden="true"></span></button>
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
    const call = e.target.closest("[data-open]");
    if (call) return api.openCall(call.dataset.open);
    if (e.target.closest(".contact-action-call")) return; // dials.js places the call, then asks us to open the card
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

  // ---- Emails bar: status only (people with no mailbox don't see it) ---------------------------------------------
  async function loadQueue() {
    const { data, error } = await supabase.rpc("email_queue_status", { p_owner: profile.id });
    queueErr = !!error; queue = error ? null : (Array.isArray(data) ? data[0] : data) || null;
    renderEmails();
  }
  function queueLine() {
    if (queueErr || !queue || !(queue.mailboxes || []).length) return "";
    const sent = queue.sent_today ?? 0, cap = queue.capacity_today;
    const next = queue.next_send_at ? new Date(queue.next_send_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).replace(/\s/g, "").toLowerCase() : "";
    return [cap ? `${sent} of ${cap} sent today` : `${sent} sent today`, next ? `next ${next}` : ""].filter(Boolean).join(" · ");
  }
  function renderEmails() {
    const bar = $("dhBar"); if (!bar) return;
    const line = queueLine();
    bar.hidden = !line;
    bar.textContent = line;
  }


  // ---- public ---------------------------------------------------------------------------------------------------
  const api = {
    // Open the company card (so the outcome can be logged straight after a call) in the order shown on screen.
    // A company on the sheet may be one whose task was loaded separately (not in the list's own dials array).
    dialById: (id) => taskDials.find((d) => d.id === id) || null,
    openCall(id) { const set = visibleDials(); openCard(set, set.findIndex((x) => x.id === id)); },
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
