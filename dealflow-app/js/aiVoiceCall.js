// Voice practice: one live call. Listens all the time (browser speech recognition), decides when the intern finished a
// turn, waits a real owner's reply gap, and plays the owner's real line. The owner stops talking when the intern cuts in,
// makes a small noise during a long pitch, says "Hello?" after a silence, and hangs up at the real rate.
import { plan, monologue, silence, clipParts } from "./aiVoicePlan.js";
import { mask, unmask, overlap } from "./aiVoiceEngine.js";
import { playParts, speakFallback, embed, gapMs, prefetch } from "./aiVoiceKit.js";

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const FINAL_WAIT = 250, STABLE_WAIT = 900, SILENCE_MS = 7000;
const nw = (t) => String(t || "").split(/\s+/).filter(Boolean).length;
export const voiceSupported = () => !!SR && !!(window.AudioContext || window.webkitAudioContext);

export function createCall({ kit, bank, persona, path, voice, opening, onLine, onState, onEnd }) {
  const st = { kit, bank, persona, path, turns: [], seed: `${persona.exclude_call}|${Date.now()}` };
  let rec = null, live = true, playing = null, saying = "", finals = "", interim = "", conf = 1, timer = null, quiet = null;
  let nQuiet = 0, played = {}, thinking = false, hung = false;
  const now = () => new Date().toISOString();

  prefetch(voice, [...path.flatMap((p) => (p.r && clipParts(kit, p.r, persona, [])) || []), ...Object.values(kit.edge).flat().map((e) => e.id)]);

  async function speak(r, { log = true, turn = true } = {}) {
    const say = r.say || unmask(r.r, persona, st.turns);
    if (turn) st.turns.push({ role: "prospect", text: say, at: now(), source: r.src || "", path_pos: r.path_pos, act: r.act, obj: r.obj, opener_ok: r.opener_ok, kind: r.kind, stance: r.stance });
    if (log) onLine("prospect", say, r);
    saying = say; onState("owner");
    let how;
    if (r.parts) { playing = playParts(voice, r.parts); how = await playing.done; } else how = await speakFallback(say);
    playing = null; saying = "";
    if (!live) return;
    if (r.hang || r.flags?.hang_up) { hung = true; onLine("note", "The owner hung up."); return end(); }
    onState("you"); armSilence();
    return how;
  }

  function armSilence() {
    clearTimeout(quiet);
    quiet = setTimeout(async () => {
      if (!live || playing || thinking || (finals + interim).trim()) return;
      nQuiet += 1;
      const r = silence(st, nQuiet);
      if (r) await speak(r);
    }, SILENCE_MS);
  }

  async function commit() {
    clearTimeout(timer);
    const text = (finals + " " + interim).trim(), c = conf;
    finals = ""; interim = ""; played = {};
    if (!live || !text || thinking) return;
    thinking = true; nQuiet = 0; clearTimeout(quiet);
    const t0 = performance.now();
    st.turns.push({ role: "intern", text, at: now() });
    onLine("intern", text);
    onState("thinking");
    try {
      const qv = await embed(mask(text, persona.name, persona.company)).catch(() => null);
      const r = await plan(st, text, { asrConf: c, qv });
      const words = nw(r.say || r.r);
      const wait = Math.max(0, gapMs(kit, words) - (performance.now() - t0));
      await new Promise((ok) => setTimeout(ok, wait));
      thinking = false;
      if (live) await speak(r);
    } catch (e) { thinking = false; console.error(e); onLine("note", "The practice owner missed that. Say it again."); onState("you"); }
  }

  async function onResult(ev) {
    let fin = "", tmp = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) { fin += " " + res[0].transcript; conf = res[0].confidence || conf; } else tmp += " " + res[0].transcript;
    }
    // the mic can hear the owner's own audio: ignore words that are just the line being played
    if (playing && overlap(fin + tmp, saying) >= 0.6) return;
    if (playing && nw(fin + tmp) >= 2) { playing.stop(); onLine("note", "(you cut in)"); }
    finals = (finals + fin).trim(); interim = tmp.trim();
    if (thinking) return;
    clearTimeout(quiet); nQuiet = 0;
    const said = (finals + " " + interim).trim();
    const m = !playing && monologue(st, nw(said), played);
    if (m) {
      played[m.kind] = true;
      if (m.kind === "interrupt") { await speak(m, { turn: false }); return commit(); }
      playParts(voice, m.parts);   // a quiet "mm-hm" while they keep talking
    }
    clearTimeout(timer);
    timer = setTimeout(commit, fin.trim() && !interim ? FINAL_WAIT : STABLE_WAIT);
  }

  function listen() {
    rec = new SR(); rec.lang = "en-US"; rec.continuous = true; rec.interimResults = true;
    rec.onresult = onResult;
    rec.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { onLine("note", "The mic is blocked. Allow it in the browser and start again."); end(); } };
    rec.onend = () => { if (live) try { rec.start(); } catch (_) {} };   // Chrome stops listening now and then
    rec.start();
  }

  async function end() {
    if (!live) return;
    live = false; clearTimeout(timer); clearTimeout(quiet);
    playing && playing.stop(); try { rec && rec.stop(); } catch (_) {}
    onState("ended");
    onEnd(st.turns.map(({ role, text, at, source }) => ({ role, text, at, source })), hung);
  }

  listen();
  speak({ r: opening, say: opening, parts: kit.clips[opening] != null ? [kit.clips[opening]] : null, src: "path", path_pos: 0 });
  return { end, say(text) { finals = text; interim = ""; commit(); }, turns: () => st.turns };
}
