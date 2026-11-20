// Today page: what each person should do today (my_tasks view; RLS limits rows by role).
import { requireSession } from "./auth.js";
import { supabase } from "./supabaseClient.js";

const TZ = "America/Denver";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const EMAIL_KINDS = ["email", "followup_email"];
const GROUPS = [
  { id: "reply", title: "Replies to answer", kinds: ["reply"] },
  { id: "call", title: "Calls", kinds: ["call"] },
  { id: "call_company", title: "Company-line calls", kinds: ["call_company"] },
  { id: "linkedin", title: "LinkedIn", kinds: ["linkedin"] },
  { id: "email", title: "Emails sending automatically", kinds: EMAIL_KINDS },
];
const OUTCOMES = [
  { key: "no_answer", label: "No answer" },
  { key: "voicemail", label: "Left voicemail" },
  { key: "talked_callback", label: "Talked – call back", status: "callback_interested" },
  { key: "not_interested", label: "Not interested", status: "not_interested" },
  { key: "intro_booked", label: "Intro booked", status: "intro_call_scheduled" },
];
const KIND_LABEL = { email: "Email", followup_email: "Follow-up email", call: "Call", call_company: "Company-line call", linkedin: "LinkedIn", reply: "Reply" };

const { profile } = await requireSession();
const isLead = profile.role === "team_lead" || profile.role === "admin";
let rows = [];
let today = denverDate();
let busy = new Set();
let pick = profile.role === "admin" ? "me" : "all";

function denverDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nextBusinessDays(iso, n) {
  const out = []; let d = iso;
  while (out.length < n) { d = addDays(d, 1); const wd = new Date(d + "T12:00:00Z").getUTCDay(); if (wd !== 0 && wd !== 6) out.push(d); }
  return out;
}
const fmtTime = (ts) => ts ? new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ts)) : "";
const fmtDay = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const telHref = (p) => "tel:" + String(p).replace(/[^\d+]/g, "");
const webUrl = (u) => (/^https?:\/\//i.test(u) ? u : "https://" + u);

function showMsg(text, ok) {
  const el = $("todayMsg");
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
  el.classList.toggle("ok", !!ok);
}

// Lists whose uploaded copy is waiting for a one-time approval: the first thing to do today.
async function loadApprovals() {
  const box = $("todayApprovals");
  const { data, error } = await supabase.from("dial_lists")
    .select("id, name, created_by, dials(count)")
    .eq("copy_status", "pending_review").is("deleted_at", null)
    .eq("dials.seq_state", "awaiting_copy").limit(50);
  if (error || !data) { box.innerHTML = ""; return; }
  const lists = data.filter((l) => (l.dials?.[0]?.count || 0) > 0);
  box.innerHTML = lists.map((l) => `
    <div class="today-approve">
      <div><strong>Approve emails before they send</strong><br>
        <span class="today-muted">${esc(l.name)} · ${l.dials[0].count} lead${l.dials[0].count === 1 ? "" : "s"} waiting</span></div>
      <button type="button" class="btn small" data-approve-list="${esc(l.id)}">Review</button>
    </div>`).join("");
  box.querySelectorAll("[data-approve-list]").forEach((b) => b.addEventListener("click", () => {
    try { localStorage.setItem("waystation_dials_list_id", b.dataset.approveList); } catch (_) {}
    location.href = "dials.html";
  }));
}

async function load() {
  loadApprovals();
  $("todayBody").innerHTML = '<p class="today-muted">Loading your tasks...</p>';
  today = denverDate();
  const cutoff = nextBusinessDays(today, 5).pop();
  const COLS = "*";
  const [open, done] = await Promise.all([
    supabase.from("my_tasks").select(COLS).in("status", ["pending", "queued", "failed"]).lte("due_on", cutoff).order("due_on").limit(1000),
    supabase.from("my_tasks").select(COLS).eq("status", "done").in("kind", EMAIL_KINDS).eq("due_on", today).limit(1000),
  ]);
  const err = open.error || done.error;
  if (err) {
    $("todayBody").innerHTML = "";
    $("todaySummary").textContent = "";
    showMsg("Couldn't load your tasks: " + err.message + ". Check your connection and tap Refresh.");
    return;
  }
  showMsg("");
  rows = [...(open.data || []), ...(done.data || [])];
  buildPicker();
  render();
}

function buildPicker() {
  const wrap = $("todayPickerWrap");
  const people = new Map();
  rows.forEach((r) => people.set(r.owner_id, r.owner_name));
  people.delete(profile.id);
  if (!isLead || !people.size) { wrap.classList.add("hidden"); if (pick !== "me") pick = "all"; return; }
  const sel = $("todayPicker");
  const opts = [["all", profile.role === "admin" ? "Everyone" : "Me + my interns"], ["me", "Just me"],
    ...[...people].sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([id, n]) => [id, n || "Unnamed"])];
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  sel.value = opts.some(([v]) => v === pick) ? pick : "all";
  pick = sel.value;
  wrap.classList.remove("hidden");
}

function visibleRows() {
  if (pick === "all") return rows;
  const id = pick === "me" ? profile.id : pick;
  return rows.filter((r) => r.owner_id === id);
}

function render() {
  const vis = visibleRows();
  const due = vis.filter((r) => r.due_on <= today);
  const upcoming = vis.filter((r) => r.due_on > today && r.status !== "done");
  const actionable = (r) => !EMAIL_KINDS.includes(r.kind);
  const things = due.filter(actionable).length;
  const overdue = due.filter((r) => actionable(r) && r.due_on < today).length;
  const auto = due.filter((r) => EMAIL_KINDS.includes(r.kind) && ["pending", "queued"].includes(r.status)).length;
  const failed = due.filter((r) => EMAIL_KINDS.includes(r.kind) && r.status === "failed").length;
  $("todaySummary").textContent = `${things} ${things === 1 ? "thing" : "things"} today · ${overdue} overdue · ${auto} emails sending automatically` + (failed ? ` · ${failed} failed` : "");

  const body = $("todayBody");
  if (!due.length) {
    body.innerHTML = `<div class="today-empty"><strong>You're all caught up.</strong><br>Nothing is due today${upcoming.length ? "; see Coming up below." : "."}</div>`;
  } else {
    const people = [...new Set(due.map((r) => r.owner_id))];
    if (people.length > 1) {
      body.innerHTML = people.map((id) => {
        const mine = due.filter((r) => r.owner_id === id);
        return `<h2 class="today-person">${esc(mine[0].owner_name || "Unnamed")}</h2>${renderBuckets(mine)}`;
      }).join("");
    } else body.innerHTML = renderBuckets(due);
  }
  renderUpcoming(upcoming);
}

function renderBuckets(list) {
  const buckets = [["Overdue", "overdue", list.filter((r) => r.due_on < today)], ["Today", "", list.filter((r) => r.due_on === today)]];
  return buckets.filter(([, , l]) => l.length).map(([label, cls, l]) =>
    `<h3 class="today-bucket ${cls}">${label} (${l.length})</h3>` + GROUPS.map((g) => {
      const items = l.filter((r) => g.kinds.includes(r.kind));
      if (!items.length) return "";
      return `<h4 class="today-group">${g.title} <span class="count">(${items.length})</span></h4>` + items.map(card).join("");
    }).join("")).join("");
}

function leadLink(r) {
  return `<a href="dials.html?dial=${encodeURIComponent(r.dial_id)}" title="Open this lead in Dials">${esc(r.company_name || "(no company)")}</a>`;
}

function card(r) {
  const meta = [r.full_name, [r.city, r.state].filter(Boolean).join(", "), r.list_name].filter(Boolean).map(esc).join(" · ");
  const day = `Day ${esc(r.seq_day)} of ${esc(r.sequence || "")}`;
  const badge = r.due_on < today ? `<span class="today-badge overdue">Due ${esc(fmtDay(r.due_on))}</span>` : "";
  let inner = "";
  if (EMAIL_KINDS.includes(r.kind)) inner = emailStatus(r);
  else if (r.kind === "linkedin") {
    const url = r.linkedin ? webUrl(r.linkedin) : "https://www.linkedin.com/search/results/people/?keywords=" + encodeURIComponent([r.full_name, r.company_name].filter(Boolean).join(" "));
    inner = `<div class="today-actions"><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open profile</a>
      <button class="btn secondary" data-act="done" data-id="${esc(r.id)}">Done</button><button class="btn secondary" data-act="skip" data-id="${esc(r.id)}">Skip</button></div>`;
  } else if (r.kind === "reply") {
    inner = `<div class="today-actions"><a class="btn" href="messages.html">Open messages</a>
      <button class="btn secondary" data-act="done" data-id="${esc(r.id)}">Done</button></div>`;
  } else inner = callActions(r);
  return `<div class="today-card ${r.status === "failed" ? "failed" : ""}" data-card="${esc(r.id)}">
    <div class="today-co">${leadLink(r)}</div>
    <div class="today-meta">${badge}${meta}${meta ? " · " : ""}${day}</div>${inner}</div>`;
}

function callActions(r) {
  const company = r.kind === "call_company";
  const primary = company ? r.company_phone : r.mobile_phone;
  const fallback = company ? r.mobile_phone : r.company_phone;
  const num = primary || fallback;
  let call = '<span class="today-muted">No phone number on file</span>', hint = "";
  if (num) {
    call = `<a class="btn today-call" href="${esc(telHref(num))}">Call ${esc(num)}</a>`;
    if (!primary) hint = `<div class="today-hint">${company ? "No company line on file; this is the owner's mobile." : "No mobile on file; this is the company line."}</div>`;
  }
  return `${hint}<div class="today-actions">${call}</div>
    <input class="today-note" type="text" maxlength="500" placeholder="Note (optional)" data-note="${esc(r.id)}" />
    <div class="today-actions">${OUTCOMES.map((o) => `<button class="btn secondary small" data-act="outcome" data-outcome="${o.key}" data-id="${esc(r.id)}">${o.label}</button>`).join("")}
    <button class="btn secondary small" data-act="skip" data-id="${esc(r.id)}">Skip</button></div>`;
}

function emailStatus(r) {
  const to = r.email ? ` to ${esc(r.email)}` : "";
  if (r.status === "failed") return `<div class="today-status err">Failed: ${esc(r.last_error || r.email_error || "unknown error")}</div>`;
  if (r.status === "done") return `<div class="today-status ok">Sent${to}${r.email_sent_at ? " at " + esc(fmtTime(r.email_sent_at)) : ""}</div>`;
  if (r.status === "queued") return `<div class="today-status">Sending ~${esc(fmtTime(r.email_send_at) || "soon")}${to}</div>`;
  return `<div class="today-status today-muted">Waiting for send window${to}${r.last_error ? " (" + esc(r.last_error) + ")" : ""}</div>`;
}

function renderUpcoming(list) {
  const box = $("todayUpcoming");
  box.classList.toggle("hidden", !list.length);
  if (!list.length) return;
  $("todayUpcomingSummary").textContent = `Coming up (next 5 business days): ${list.length}`;
  const days = [...new Set(list.map((r) => r.due_on))].sort();
  $("todayUpcomingBody").innerHTML = days.map((d) => `<h4 class="today-group">${esc(fmtDay(d))}</h4>` +
    list.filter((r) => r.due_on === d).map((r) =>
      `<div class="today-card"><div class="today-co">${leadLink(r)}</div><div class="today-meta">${esc(KIND_LABEL[r.kind] || r.kind)} · ${[r.full_name, r.owner_name && r.owner_id !== profile.id ? r.owner_name : ""].filter(Boolean).map(esc).join(" · ")}</div></div>`).join("")).join("");
}

async function complete(id, kind, outcomeKey) {
  if (busy.has(id)) return;
  const r = rows.find((x) => x.id === id);
  if (!r) return;
  busy.add(id);
  const cardEl = document.querySelector(`[data-card="${CSS.escape(id)}"]`);
  cardEl?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  cardEl?.classList.add("leaving");
  const noteEl = cardEl?.querySelector("[data-note]");
  const note = noteEl ? noteEl.value.trim() : "";
  const skip = kind === "skip";
  const outcome = skip ? "skipped" : outcomeKey || "done";
  const idx = rows.indexOf(r);
  rows.splice(idx, 1); // optimistic
  let warn = "";
  try {
    const { error } = await supabase.rpc("complete_sequence_task", { p_task_id: id, p_outcome: outcome, p_note: note || null, p_skip: skip });
    if (error) throw error;
    const st = OUTCOMES.find((o) => o.key === outcomeKey)?.status;
    if (st) {
      // RPC first: a terminal status stops the sequence, which would cancel this task before the outcome was saved.
      const { error: e2 } = await supabase.from("dials").update({ contact_status: st }).eq("id", r.dial_id);
      if (e2) warn = `Saved the outcome for ${r.company_name}, but couldn't update the lead's status (${e2.message}). Set it in Dials.`;
    }
    showMsg(warn);
  } catch (e) {
    rows.splice(idx, 0, r); // restore
    showMsg(`Couldn't save ${r.company_name || "that task"}: ${e.message || e}. It's back in your list; try again.`);
  } finally {
    busy.delete(id);
    render();
  }
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-act]");
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  complete(b.dataset.id, act === "skip" ? "skip" : act, act === "outcome" ? b.dataset.outcome : null);
});
$("todayPicker").addEventListener("change", (e) => { pick = e.target.value; render(); });
$("todayRefresh").addEventListener("click", load);
document.addEventListener("visibilitychange", () => { if (!document.hidden && denverDate() !== today) load(); });

await load();
