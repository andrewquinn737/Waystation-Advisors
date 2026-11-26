// AI tab step 3: a practice cold call with an AI owner built from a real call. The coach server plays the owner (queued
// through ai_practice_say, polled with ai_practice_get). Speak with the mic (browser speech recognition) or type; the
// owner's replies are read aloud when sound is on. Hanging up scores the call and moves the coach's stage.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function mountPractice(host, { getTrack, onScored, workerOnline }) {
  let ses = null, busy = false, sound = true, rec = null, online = workerOnline;
  host.innerHTML = `<p class="aic-muted">You call an AI owner built from one of our real calls. It answers the way that owner did, and it gets
      easier only when you get better. Talk with the mic or type, like a real call: no notes in brackets.</p>
    <div class="aic-row"><label>Practice <select id="apStage"><option value="">What my coach picks</option><option value="opener">Opening lines</option>
      <option value="objections">Objections</option><option value="full">Full call</option></select></label>
      <label class="aic-check"><input type="checkbox" id="apSound" checked> Read replies aloud</label>
      <button class="btn" id="apStart">Start a practice call</button></div>
    <div id="apWarn"></div>
    <div class="ap-call hidden" id="apCall"><div class="ap-who" id="apWho"></div><div class="ap-log" id="apLog" aria-live="polite"></div>
      <form class="ap-say" id="apForm"><textarea id="apText" rows="2" placeholder="What you say"></textarea>
        <div class="aic-row">${SR ? `<button type="button" class="btn secondary" id="apMic">Hold to talk</button>` : ""}
          <button class="btn" type="submit" id="apSend">Say it</button><button type="button" class="btn danger" id="apEnd">Hang up</button></div></form></div>
    <div id="apResult"></div>`;
  const q = (id) => host.querySelector("#" + id);
  const warn = () => (q("apWarn").innerHTML = online ? "" : `<div class="aic-warn">The coach server is offline, so the practice owner can't answer right now.</div>`);
  warn();
  q("apSound").onchange = (e) => (sound = e.target.checked);

  function line(role, text) {
    const d = document.createElement("div");
    d.className = "ap-line " + (role === "prospect" ? "ap-them" : "ap-me");
    d.innerHTML = `<b>${role === "prospect" ? "Owner" : "You"}</b> ${escapeHtml(text)}`;
    q("apLog").appendChild(d); d.scrollIntoView({ block: "nearest" });
    if (role === "prospect" && sound && window.speechSynthesis) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); }
  }
  const lock = (v) => { busy = v; ["apSend", "apEnd", "apText"].forEach((id) => q(id) && (q(id).disabled = v)); };

  async function waitDone(maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const { data, error } = await supabase.rpc("ai_practice_get", { p_session: ses.session_id });
      if (error) throw error;
      if (!data.pending) return data;
      await sleep(1200);
    }
    return null;
  }

  q("apStart").onclick = async () => {
    if (busy) return;
    lock(true); q("apResult").innerHTML = ""; q("apLog").innerHTML = "";
    const { data, error } = await supabase.rpc("ai_practice_start", { p_track: getTrack(), p_stage: q("apStage").value || null });
    lock(false);
    if (error) { q("apResult").innerHTML = `<div class="error-msg">Could not start: ${escapeHtml(error.message)}</div>`; return; }
    ses = data;
    const p = data.prospect || {};
    q("apWho").innerHTML = `Calling <b>${escapeHtml(p.name || "the owner")}</b> at <b>${escapeHtml(p.company || "a company")}</b>${p.city ? `, ${escapeHtml(p.city)}` : ""} · ${escapeHtml({ opener: "opening lines", objections: "objections", full: "full call" }[data.stage])}`;
    q("apCall").classList.remove("hidden"); q("apForm").classList.remove("hidden"); q("apStart").textContent = "Start over with a new owner";
    line("prospect", data.opening); q("apText").focus();
  };

  q("apForm").onsubmit = async (e) => {
    e.preventDefault();
    const text = q("apText").value.trim();
    if (!text || busy || !ses) return;
    q("apText").value = ""; line("intern", text); lock(true);
    try {
      const { error } = await supabase.rpc("ai_practice_say", { p_session: ses.session_id, p_text: text });
      if (error) throw error;
      const g = await waitDone(45000);
      if (!g) throw new Error("The owner is taking too long to answer. Try saying it again.");
      const turns = g.session.turns || [], last = turns[turns.length - 1];
      if (g.error && last?.role !== "prospect") throw new Error("The practice owner could not answer. Say it again.");
      if (last?.role === "prospect") line("prospect", last.text);
      if (g.session.hung_up) { line("prospect", "(hung up)"); return finish(); }
    } catch (err) { q("apResult").innerHTML = `<div class="error-msg">${escapeHtml(err.message || String(err))}</div>`; }
    lock(false);
  };
  q("apText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); q("apForm").requestSubmit(); } });
  q("apEnd").onclick = () => !busy && ses && finish();

  async function finish() {
    lock(true); q("apResult").innerHTML = `<p class="aic-muted">Scoring your call...</p>`;
    const id = ses.session_id; ses = null;
    const { error } = await supabase.rpc("ai_practice_end", { p_session: id });
    if (error) { q("apResult").innerHTML = `<div class="error-msg">Could not end the call: ${escapeHtml(error.message)}</div>`; lock(false); return; }
    ses = { session_id: id };
    const g = await waitDone(90000).catch(() => null); ses = null; lock(false);
    q("apForm").classList.add("hidden");                      // keep the transcript up so they can reread it
    const r = g?.session?.result;
    if (!r) { q("apResult").innerHTML = `<p class="aic-muted">Scoring is still running. Your score will show in "Your coach" in a minute.</p>`; return; }
    const pass = (v) => (v === null || v === undefined ? "–" : v ? "Passed" : "Not yet");
    q("apResult").innerHTML = `<div class="ap-score"><div class="aic-row"><span>Opener: <b>${pass(r.opener_pass)}</b></span><span>Objections: <b>${pass(r.objections_pass)}</b></span><span>Overall: <b>${r.overall_score ?? "–"}/10</b></span></div>
      <p>${escapeHtml(r.feedback || "")}</p>${r.best_line ? `<p><b>Best line:</b> "${escapeHtml(r.best_line)}"</p>` : ""}${r.fix_line ? `<p><b>Line that cost you most:</b> "${escapeHtml(r.fix_line)}"</p>` : ""}</div>`;
    onScored && onScored();
  }

  if (SR) {
    const mic = q("apMic");
    const start = () => { if (busy || !ses || rec) return; rec = new SR(); rec.lang = "en-US"; rec.interimResults = true;
      const base = q("apText").value; mic.textContent = "Listening... release to send";
      rec.onresult = (ev) => { q("apText").value = (base + " " + Array.from(ev.results).map((r) => r[0].transcript).join(" ")).trim(); };
      rec.onend = () => { rec = null; mic.textContent = "Hold to talk"; if (q("apText").value.trim()) q("apForm").requestSubmit(); };
      rec.start(); };
    const stop = () => rec && rec.stop();
    mic.addEventListener("pointerdown", start); mic.addEventListener("pointerup", stop); mic.addEventListener("pointerleave", stop);
  }
  return { setWorker(v) { online = v; warn(); } };
}
