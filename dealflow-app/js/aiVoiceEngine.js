// Voice practice: the owner's reply picker, run in the browser (a port of tools/ai_coach engine.py + paths.py, with no LLM).
// Every reply is a real owner line: the persona's own call path first, then the closest real caller line in the bank, and
// the real hang-up rate decides when the owner ends the call. No DOM here, so node tests run it too.
const STOP = new Set("the a an and or to of i you we it is that this for in on at with be so um uh like just yeah okay ok".split(" "));
const GENERIC = new Set(["inc", "llc", "the", "and", "co", "company", "group", "services", "of", "corp", "ltd", "&"]);
const NEG = new Set(["objection", "brush_off"]);
const words = (t) => (String(t || "").toLowerCase().match(/[a-z']+/g) || []);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function toks(t) {
  const w = words(t).filter((x) => !STOP.has(x));
  return w.concat(w.slice(1).map((b, i) => w[i] + "_" + b));
}
export function overlap(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size) return 0;
  let n = 0; A.forEach((x) => B.has(x) && n++);
  return n / A.size;
}
export function rng(seed) {   // mulberry32 over a string hash: the same call replays the same draws
  let h = 1779033703;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 3432918353) >>> 0;
  return () => { h = (h + 0x6d2b79f5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function mask(text, owner, company, caller) {
  if (!text) return text;
  const first = owner ? owner.split(/\s+/)[0] : "";
  const sets = [["{owner}", (owner || "").split(/\s+/).filter((w) => w.length > 2).concat(first ? [first] : [])],
    ["{caller}", (caller || "").split(/\s+/).slice(0, 1).filter((w) => w.length > 2)],
    ["{company}", ((company || "").match(/[A-Za-z']+/g) || []).filter((w) => w.length > 3 && !GENERIC.has(w.toLowerCase()))]];
  for (const [slot, ws] of sets) {
    const u = [...new Set(ws)].sort((a, b) => b.length - a.length);
    if (u.length) text = text.replace(new RegExp("\\b(" + u.map(esc).join("|") + ")\\b", "gi"), slot);
  }
  return text.replace(/(\{(owner|company|caller)\}\s*)+/g, (m, g) => g.trim() + " ").trim();
}
export function callerName(turns) {
  for (const t of turns) {
    const m = t.role === "intern" && /\b(?:my name is|this is|it'?s) ([A-Z][a-z]+)/.exec(t.text);
    if (m) return m[1];
  }
  return "";
}
export function unmask(text, persona, turns) {
  const out = text.replace(/\{owner\}/g, persona.name || "").replace(/\{company\}/g, (persona.company || "").split(",")[0])
    .replace(/\{caller\}/g, callerName(turns));
  return out.replace(/\s{2,}/g, " ").replace(/\s+([,.?!])/g, "$1").trim();
}

export function createBank(kit, emb) {
  const T = kit.turns, n = T.length || 1, df = new Map(), sec = {};
  for (const [s, ms] of Object.entries(kit.sections)) for (const m of ms) sec[m] = s;
  for (const t of T) new Set(toks(t.t)).forEach((k) => df.set(k, (df.get(k) || 0) + 1));
  const idf = new Map([...df].map(([k, v]) => [k, Math.log((n + 1) / (v + 1)) + 1]));
  const vec = (text) => {
    const tf = new Map(); toks(text).forEach((k) => tf.set(k, (tf.get(k) || 0) + 1));
    const v = new Map([...tf].map(([k, c]) => [k, c * (idf.get(k) || 2)]));
    const nr = Math.sqrt([...v.values()].reduce((a, x) => a + x * x, 0)) || 1;
    v.forEach((x, k) => v.set(k, x / nr)); return v;
  };
  const vecs = T.map((t) => vec(t.t)), post = new Map();
  vecs.forEach((v, i) => v.forEach((_, k) => (post.get(k) || post.set(k, []).get(k)).push(i)));
  const rules = kit.rules.filter(([m]) => kit.caller_moves.includes(m)).map(([m, rx]) => [m, new RegExp(rx, "i")]);
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k);

  function near(text, qv, k = 25) {
    const q = vec(text), sc = new Map();
    q.forEach((x, key) => (post.get(key) || []).forEach((i) => sc.set(i, (sc.get(i) || 0) + x * vecs[i].get(key))));
    if (!emb || !qv) return top(sc, k);
    const d = kit.dim, cos = new Float32Array(T.length);
    for (let i = 0; i < T.length; i++) { let s = 0; const o = i * d; for (let j = 0; j < d; j++) s += emb[o + j] * qv[j]; cos[i] = s / 127; }
    const pool = new Set(top(Array.from(cos, (c, i) => [i, c]), 3 * k).map((x) => x[0]));
    top(sc, 3 * k).forEach(([i]) => pool.add(i));
    const out = [...pool].map((i) => [i, Math.round((0.7 * Math.max(0, (cos[i] - 0.5) / 0.5) + 0.3 * (sc.get(i) || 0)) * 1e4) / 1e4]);
    return top(out, k);
  }
  function classify(text, qv) {
    const nb = near(text, qv), votes = new Map();
    nb.slice(0, 12).forEach(([i, s]) => votes.set(T[i].m, (votes.get(T[i].m) || 0) + s));
    rules.forEach(([m, rx]) => rx.test(text) && votes.set(m, (votes.get(m) || 0) + 0.8));
    if (!votes.size) return { move: "other", conf: 0, nb };
    const [mv, tv] = top(votes, 1)[0], sum = [...votes.values()].reduce((a, b) => a + b, 0) || 1;
    return { move: mv, conf: Math.round((tv / sum) * 100) / 100, nb };
  }
  function candidates(move, persona, nb, { n = 6, ending = null, ok = () => true } = {}) {
    const out = [], seen = new Set();
    for (const [i, s] of nb) {
      const t = T[i];
      if ((t.m !== move && s < 0.5) || !t.r || seen.has(t.r) || (persona.exclude_call && t.c === persona.exclude_call)) continue;
      if (ending !== null && !!t.e !== ending) continue;
      if (!ok(t)) continue;
      const sc = s * (1 + 0.3 * Math.log1p(t.w || 1)) * (t.m === move ? 1.3 : 1) * (t.fr === persona.first_reaction ? 1.5 : 1);
      out.push({ ...t, score: sc, sim: s }); seen.add(t.r);
    }
    return out.sort((a, b) => b.score - a.score).slice(0, n);
  }
  function endings(move, persona, ok = () => true) {
    const pool = T.filter((t) => t.e && t.r && t.c !== persona.exclude_call && ok(t));
    const same = pool.filter((t) => sec[t.m] === sec[move]);
    return (same.length ? same : pool).sort((a, b) => (b.w || 1) - (a.w || 1));
  }
  function hazard(move, k, neg, fr, prior = 10) {
    const hz = kit.hazard; if (!hz || !Object.keys(hz).length) return 0;
    const s = sec[move] || "other", tb = k <= 1 ? "1" : k === 2 ? "2" : k <= 4 ? "3-4" : k <= 7 ? "5-7" : "8+", nb = String(Math.min(neg, 2));
    let est = null;
    for (const key of ["*", s, `${s}|${tb}`, `${s}|${tb}|${nb}`, `${s}|${tb}|${nb}|${fr}`]) {
      const [c, e] = hz[key] || [0, 0];
      est = est === null ? e / Math.max(c, 1) : (e + prior * est) / (c + prior);
    }
    return Math.min(0.95, (est || 0) * (hz._scale || 1));
  }
  // real owner replies to any caller line of this kind (when no close line has a reply): the same first reaction first
  const byM = {};
  T.forEach((t) => t.r && !t.e && (byM[t.m] = byM[t.m] || []).push(t));
  function byMove(move, persona, ok = () => true) {
    return (byM[move] || []).filter((t) => t.c !== persona.exclude_call && ok(t))
      .map((t) => ({ ...t, score: (t.w || 1) * (t.fr === persona.first_reaction ? 1.5 : 1) * (t.r.split(" ").length <= 25 ? 1 : 0.5) }))
      .sort((a, b) => b.score - a.score);
  }
  // short real lines of a kind (from the tag pass), most-used first: the last fallback before a written line
  function byKind(kinds, persona, ok = () => true, move = null) {
    const seen = new Set();
    return T.filter((t) => t.r && kinds.includes(t.g) && t.c !== persona.exclude_call && t.r.split(" ").length <= 14 && ok(t)
      && !seen.has(t.r) && seen.add(t.r))
      .map((t) => ({ ...t, score: (t.w || 1) * (t.fr === persona.first_reaction ? 1.5 : 1) * (t.m === move ? 3 : sec[t.m] === sec[move] ? 2 : 1) }))
      .sort((a, b) => b.score - a.score);
  }
  return { near, classify, candidates, endings, hazard, byMove, byKind, section: (m) => sec[m] };
}

export function pathStep(path, pos, move, conf, said, section) {
  for (let j = pos; j < Math.min(path.length, pos + 3); j++) if (path[j].m === move) return j;
  for (let j = pos; j < Math.min(path.length, pos + 3); j++) {
    const t = path[j].t || "";
    if (said && t.length > 15 && overlap(t, said) >= 0.7 && overlap(said, t) >= 0.7) return j;
  }
  if (conf < 0.45 && pos < path.length && section(path[pos].m) === section(move)) return pos;
  return null;
}
export { NEG };
