// AI tab: step 1 connect Claude/ChatGPT (the personal connector link), step 2 the coach (advice rewritten every 10 graded
// conversations + per-call feedback), step 3 practice calls with an AI owner (js/aiPractice.js).
import { supabase } from "./supabaseClient.js";
import { requireSession } from "./auth.js";
import { escapeHtml } from "./clientForm.js";
import { mountClaudeConnect } from "./claudeConnect.js";
import { mountPractice } from "./aiPractice.js";
import { mountVoice } from "./aiVoice.js";

const session = await requireSession();
if (!session) throw new Error("redirecting to login");
const { profile } = session;

const $ = (id) => document.getElementById(id);
const STAGES = { opener: "Opening lines", objections: "Objections", full: "Full calls" };
const STAGE_HELP = {
  opener: "Practice owners shut you down fast until your first three lines land. Pass three in a row to move on.",
  objections: "Your opener works. Practice owners now push back with the objections you handle worst.",
  full: "Openers and objections are solid. Practice owners now play whole calls.",
};
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const score = (n) => (n === null || n === undefined ? "–" : `${n}/10`);
const md = (t) => escapeHtml(t || "").replace(/^# .+\n*/m, "").replace(/^#{2,3} (.+)$/gm, "<h4>$1</h4>")
  .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/^\s*(?:[-*]|\d+\.) (.+(?:\n {2,}.+)*)$/gm, (_, x) => `<li>${x.replace(/\n +/g, " ")}</li>`)
  .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`).replace(/<\/h4>\n+/g, "</h4>").replace(/\n{2,}/g, "<br><br>");

let track = null, practice = null, voice = null;

mountClaudeConnect($("aicConnectBody"), { profile, title: "Your AI link", chatgpt: true,
  blurb: "Add this link to Claude or ChatGPT to run practice calls and get coaching there too. Ask it to \"run a practice call\" or \"coach me\"." });

function setTrack(t) {
  track = t;
  document.querySelectorAll("[data-track]").forEach((b) => b.classList.toggle("active", b.dataset.track === t));
}
document.querySelectorAll("[data-track]").forEach((b) => (b.onclick = () => { setTrack(b.dataset.track); load(); }));

function feedbackHtml(f) {
  const a = f.analysis || {};
  const objs = (a.objections || []).map((o) => `<li>${escapeHtml((o.type || "").replace(/_/g, " "))}: ${o.handled ? "handled" : "missed"}${o.prospect_quote ? ` ("${escapeHtml(o.prospect_quote)}")` : ""}</li>`).join("");
  const list = (xs, h) => (xs && xs.length ? `<p><b>${h}</b></p><ul>${xs.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : "");
  const extra = list(a.keeps, "Keep doing") + list(a.fixes, "Fix") + (a.try_line ? `<p><b>Try next time:</b> "${escapeHtml(a.try_line)}"</p>` : "");
  return `<details class="aic-call"><summary><span>${escapeHtml(f.company_name || "Call")}</span><span class="aic-muted">${escapeHtml(when(f.created_at))}</span>
      <span class="aic-scores">Opener ${score(f.opener_score)} · Objections ${score(f.objection_score)} · Overall ${score(f.overall_score)}</span></summary>
    <div class="aic-fb">${f.feedback ? md(f.feedback) : ""}${extra}${objs ? `<ul class="aic-objs">${objs}</ul>` : ""}</div></details>`;
}

async function load() {
  const body = $("aicCoachBody");
  const { data, error } = await supabase.rpc("ai_coach_overview", { p_track: track });
  if (error) { body.innerHTML = `<div class="error-msg">Could not load your coach: ${escapeHtml(error.message)}</div><button class="btn secondary small" id="aicRetry">Try again</button>`; $("aicRetry").onclick = load; return; }
  if (!track) setTrack(data.track);
  const s = data.state || {}, fb = data.feedback || [];
  const left = Math.max(0, 10 - ((s.conv_count || 0) - (s.convos_at_advice || 0)));
  const OBJ = { not_interested: "\"not interested\"", busy: "\"I'm busy\"", what_is_this: "\"what is this?\"", who_are_you: "\"who are you?\"",
    scam_or_trust: "\"is this a scam?\"", price_or_value: "price", confidentiality: "confidentiality", send_email: "\"send me an email\"",
    not_decision_maker: "not the decision maker", not_selling: "\"not selling\"", timing: "timing", already_have: "\"we already have one\"", wrong_fit: "wrong fit" };
  const focus = (s.objection_focus || []).filter((x) => x !== "other").map((x) => OBJ[x] || x.replace(/_/g, " "));
  body.innerHTML = `
    <div class="aic-stage"><span class="aic-badge">${escapeHtml(STAGES[s.stage] || "Opening lines")}</span><span class="aic-muted">${escapeHtml(STAGE_HELP[s.stage] || STAGE_HELP.opener)}</span></div>
    ${focus.length ? `<div class="aic-muted">Objections to work on: <b>${escapeHtml(focus.join(", "))}</b></div>` : ""}
    <div class="aic-advice">${s.advice ? md(s.advice) : `<p class="aic-muted">Your coach writes advice once you have 10 real conversations graded. Until then, use practice calls and the guide below.</p>`}</div>
    <div class="aic-muted">${s.advice_at ? `Updated ${escapeHtml(when(s.advice_at))} · ` : ""}${s.conv_count || 0} conversations graded · next update in ${left} conversation${left === 1 ? "" : "s"}</div>
    ${data.worker_online ? "" : `<div class="aic-warn">The coach server is offline right now. New feedback and practice replies will wait until it is back.</div>`}
    <h3>Your recent calls</h3>
    ${fb.length ? fb.map(feedbackHtml).join("") : `<p class="aic-muted">No graded calls yet. Every call you make where you reach someone gets feedback here within a few minutes.</p>`}
    <details class="aic-guide"><summary>How the coach works</summary><div id="aicGuide" class="aic-fb">Loading...</div></details>`;
  body.querySelector(".aic-guide").addEventListener("toggle", loadGuide, { once: true });
  if (!voice) voice = mountVoice($("aicVoiceBody"), { getTrack: () => track, onScored: load }) || {};
  if (!practice) {
    practice = mountPractice($("aicPracticeBody"), { getTrack: () => track, onScored: load, workerOnline: data.worker_online });
  }
  else practice.setWorker(data.worker_online);
}

async function loadGuide() {
  const { data } = await supabase.from("ai_kb_docs").select("body").in("track", [track, "shared"]).eq("slug", "guide").limit(1);
  $("aicGuide").innerHTML = data?.[0] ? md(data[0].body) : "The guide isn't loaded yet.";
}

load();
