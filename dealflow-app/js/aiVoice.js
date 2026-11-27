// Voice practice panel: a live phone-style call with a practice owner. The owner speaks real recorded lines from our
// calls (no server per turn), the browser hears the intern, and the whole call is scored after the owner hangs up.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { loadKit, loadEmbedder, audio } from "./aiVoiceKit.js";
import { createCall, voiceSupported } from "./aiVoiceCall.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = { owner: "Owner is talking", you: "Your turn", thinking: "...", ended: "Call ended" };

export function mountVoice(host, { getTrack, onScored } = {}) {
  host.innerHTML = `<h3>Live voice call <span class="aic-muted">(beta)</span></h3>
    <p class="aic-muted">Talk out loud like a real dial. The owner answers in a recorded voice with lines real owners said, cuts you off
    if you ramble, and can hang up. Use headphones so the mic doesn't pick up the owner. Works in Chrome.</p>
    <div class="aic-row"><select id="avStage"><option value="">My current stage</option><option value="opener">Opening lines</option>
    <option value="objections">Objections</option><option value="full">Full call</option></select>
    <button class="btn" id="avStart">Start voice call</button><button class="btn hidden" id="avEnd">Hang up</button>
    <span class="av-state" id="avState"></span></div>
    <div class="ap-who" id="avWho"></div><div class="ap-log hidden" id="avLog"></div><div id="avResult"></div>`;
  const q = (id) => host.querySelector("#" + id);
  if (!voiceSupported()) {
    q("avStart").disabled = true;
    q("avResult").innerHTML = `<div class="aic-warn">This browser can't run voice calls. Open the coach in Chrome.</div>`;
    return {};
  }
  let call = null, ses = null;

  const line = (role, text) => {
    const d = document.createElement("div");
    d.className = role === "note" ? "ap-line av-note" : `ap-line ${role === "prospect" ? "ap-them" : "ap-me"}`;
    d.innerHTML = role === "note" ? escapeHtml(text) : `<b>${role === "prospect" ? "Owner" : "You"}</b> ${escapeHtml(text)}`;
    q("avLog").appendChild(d); q("avLog").scrollTop = q("avLog").scrollHeight;
  };

  q("avStart").onclick = async () => {
    if (call) return;
    audio();                                  // the click unlocks audio playback
    q("avStart").disabled = true; q("avResult").innerHTML = ""; q("avLog").innerHTML = "";
    q("avState").textContent = "Dialing...";
    try {
      const track = getTrack();
      const [{ data, error }, kb] = await Promise.all([
        supabase.rpc("ai_practice_start_voice", { p_track: track, p_stage: q("avStage").value || null }),
        loadKit(track), loadEmbedder()]);
      if (error) throw error;
      ses = data;
      const p = data.prospect || {}, v = data.voice || {}, kp = kb.kit.personas[v.path_call] || {};
      const persona = { name: p.name || "", company: p.company || "", first_reaction: v.first_reaction, exclude_call: v.path_call };
      q("avWho").innerHTML = `Calling <b>${escapeHtml(p.name || "the owner")}</b> at <b>${escapeHtml(p.company || "a company")}</b>${p.city ? `, ${escapeHtml(p.city)}` : ""}`;
      q("avLog").classList.remove("hidden"); q("avEnd").classList.remove("hidden");
      await sleep(900 + Math.random() * 1400);   // it rings
      call = createCall({ kit: kb.kit, bank: kb.bank, persona, path: kp.path || [], voice: kp.v || "am_michael",
        opening: data.opening || "Hello?", onLine: line,
        onState: (s) => (q("avState").textContent = STATE[s] || ""), onEnd: finish });
    } catch (e) {
      q("avResult").innerHTML = `<div class="error-msg">Could not start the call: ${escapeHtml(e.message || String(e))}</div>`;
      q("avStart").disabled = false; q("avState").textContent = ""; call = null;
    }
  };
  q("avEnd").onclick = () => call && call.end();

  async function finish(turns, hung) {
    q("avEnd").classList.add("hidden"); q("avResult").innerHTML = `<p class="aic-muted">Scoring your call...</p>`;
    const id = ses.session_id; call = null; ses = null;
    const { error } = await supabase.rpc("ai_practice_end_voice", { p_session: id, p_turns: turns, p_hung: !!hung });
    q("avStart").disabled = false; q("avStart").textContent = "Call another owner";
    if (error) { q("avResult").innerHTML = `<div class="error-msg">Could not save the call: ${escapeHtml(error.message)}</div>`; return; }
    if (!turns.some((t) => t.role === "intern")) { q("avResult").innerHTML = `<p class="aic-muted">You didn't say anything, so there's nothing to score.</p>`; return; }
    let r = null;
    for (const t0 = Date.now(); Date.now() - t0 < 90000; await sleep(1500)) {
      const { data } = await supabase.rpc("ai_practice_get", { p_session: id });
      if (data && !data.pending) { r = data.session?.result; break; }
    }
    if (!r) { q("avResult").innerHTML = `<p class="aic-muted">Scoring is still running. Your score will show in "Your coach" in a minute.</p>`; return; }
    const pass = (v) => (v === null || v === undefined ? "–" : v ? "Passed" : "Not yet");
    q("avResult").innerHTML = `<div class="ap-score"><div class="aic-row"><span>Opener: <b>${pass(r.opener_pass)}</b></span><span>Objections: <b>${pass(r.objections_pass)}</b></span><span>Overall: <b>${r.overall_score ?? "–"}/10</b></span></div>
      <p>${escapeHtml(r.feedback || "")}</p>${r.best_line ? `<p><b>Best line:</b> "${escapeHtml(r.best_line)}"</p>` : ""}${r.fix_line ? `<p><b>Line that cost you most:</b> "${escapeHtml(r.fix_line)}"</p>` : ""}</div>`;
    onScored && onScored();
  }
  return { end: () => call && call.end() };
}
