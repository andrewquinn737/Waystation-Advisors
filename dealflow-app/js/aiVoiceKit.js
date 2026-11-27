// Voice practice: loads the voice kit (real owner lines, bank vectors, hang-up rates) and the pre-recorded owner clips
// from the private coach-voice bucket, embeds what the intern says in the browser (bge-small, the model the bank was
// built with), and plays clips through a phone-band filter so it sounds like a call.
import { supabase } from "./supabaseClient.js";
import { createBank } from "./aiVoiceEngine.js";

const BUCKET = "coach-voice";
const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";
const kits = {}, buffers = new Map();
let ctx = null, embedder = null, embedTried = false;

async function get(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return data;
}

export async function loadKit(track) {
  if (kits[track]) return kits[track];
  const [k, e] = await Promise.all([get(`kit_${track}.json`), get(`emb_${track}.i8`)]);
  const kit = JSON.parse(await k.text()), emb = new Int8Array(await e.arrayBuffer());
  kits[track] = { kit, bank: createBank(kit, emb) };
  return kits[track];
}

// meaning-based matching needs the small embedding model (~33 MB, cached by the browser after the first call);
// if it can't load, matching falls back to shared words only and still works
export async function loadEmbedder() {
  if (embedder || embedTried) return embedder;
  embedTried = true;
  try {
    const { pipeline } = await import(TRANSFORMERS);
    embedder = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
  } catch (e) { console.warn("voice practice: embedder unavailable, using word match", e); embedder = null; }
  return embedder;
}
export async function embed(text) {
  if (!embedder) return null;
  const out = await embedder(text, { pooling: "cls", normalize: true });
  return out.data;
}

export function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 280;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3600;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3;
    hp.connect(lp); lp.connect(comp); comp.connect(ctx.destination);
    ctx.phoneIn = hp;
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export async function clip(voice, id) {
  const key = `${voice}/${id}`;
  if (!buffers.has(key)) {
    const p = get(`clips/${voice}/${id}.mp3`).then((b) => b.arrayBuffer()).then((a) => audio().decodeAudioData(a))
      .catch((e) => { buffers.delete(key); throw e; });
    buffers.set(key, p);
  }
  return buffers.get(key);
}
export const prefetch = (voice, ids) => Promise.allSettled([...new Set(ids)].map((id) => clip(voice, id)));

// play the clip ids in order (spliced names get a tiny gap); returns { done: Promise, stop() }
export function playParts(voice, ids) {
  const ac = audio(), nodes = [];
  let stopped = false, resolve;
  const done = new Promise((r) => (resolve = r));
  (async () => {
    try {
      const bufs = await Promise.all(ids.map((id) => clip(voice, id)));
      if (stopped) return resolve("stopped");
      let t = ac.currentTime + 0.02;
      bufs.forEach((b, i) => {
        const s = ac.createBufferSource(); s.buffer = b; s.connect(ac.phoneIn); s.start(t); nodes.push(s);
        t += b.duration + (i < bufs.length - 1 ? 0.05 : 0);
      });
      nodes[nodes.length - 1].onended = () => resolve(stopped ? "stopped" : "ended");
    } catch (e) { resolve("error"); }
  })();
  return { done, stop() { stopped = true; nodes.forEach((n) => { try { n.stop(); } catch (_) {} }); resolve("stopped"); } };
}

// the browser's own voice, only when a clip is missing (a name the kit has no recording for)
export function speakFallback(text) {
  return new Promise((r) => {
    if (!window.speechSynthesis) return r("ended");
    const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; u.onend = () => r("ended"); u.onerror = () => r("error");
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  });
}

export function gapMs(kit, words) {
  const q = kit.timing[words <= 3 ? "short" : "long"];
  return q[Math.floor(Math.random() * q.length)];
}
