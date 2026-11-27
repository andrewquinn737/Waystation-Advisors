// Voice practice: what the owner says next. Order: edge cases (nothing heard, a bad line, the same line twice, rudeness),
// then the owner's own real call path, the real hang-up rate, and the closest real bank line. Only real or plainly
// written short lines come back (no LLM); each reply names the clips that speak it in the persona's voice.
import { mask, unmask, callerName, overlap, rng, pathStep, NEG } from "./aiVoiceEngine.js";
import { context, fitter, fallbackKinds } from "./aiVoiceFit.js";

const RUDE = /\b(f+u+c+k+|shit|bitch|asshole|dick|stupid|shut up|idiot|screw you)\b/i;
const OFFTOPIC = /\b(pizza|weather|football|basketball|lottery|crypto|bitcoin|date|girlfriend|boyfriend|video game)\b/i;
const DIRECT = 0.6, MIN_SIM = 0.35;
const segs = (t) => t.split(/(\{(?:owner|company|caller)\})/).map((s) => s.trim()).filter(Boolean);

export function clipParts(kit, r, persona, turns) {
  // whole line with names filled first (persona path lines were recorded that way), else real line + spliced names
  const fill = r.replace(/\{owner\}/g, persona.name || "").replace(/\{company\}/g, (persona.company || "").split(",")[0]);
  const ids = (list) => list.map((s) => {
    if (s === "{owner}") s = persona.name || ""; else if (s === "{company}") s = (persona.company || "").split(",")[0];
    else if (s === "{caller}") s = callerName(turns);
    return kit.clips[s] ?? null;
  });
  let p = ids(segs(fill));
  if (p.some((x) => x === null)) p = ids(segs(r));
  return p.some((x) => x === null) ? null : p;
}

export function pickEdge(st, kind) {
  const opts = st.kit.edge[kind] || [], r = rng(`${st.seed}|${kind}|${st.turns.length}`);
  const e = opts[Math.floor(r() * opts.length)];
  return e ? { r: e.text, src: `edge:${kind}`, gen: e.src === "gen", parts: [e.id] } : null;
}

function reply(st, t, src, extra) {
  const k = st.turns.filter((x) => x.role === "intern").length;
  const hang = !!extra.hang;
  const out = { r: t.r, src, act: t.a || null, obj: t.o || null, hang, ...extra };
  out.say = unmask(t.r, st.persona, st.turns);
  out.parts = clipParts(st.kit, t.r, st.persona, st.turns);
  out.flags = {};
  if (hang || t.a === "hang_up" || t.a === "ending") out.flags.hang_up = true;
  if (t.a === "objection" && t.o) out.flags.objection = t.o;
  if (t.a === "agree_next_step") out.flags.agreed_next_step = true;
  if (!st.turns.some((x) => x.opener_ok !== undefined) && st.kit.pitch_moves.includes(extra.move))
    out.opener_ok = !["brush_off", "hang_up", "ending", "objection"].includes(t.a);
  out.k = k; out.kind = t.g || null; out.stance = t.s || null;
  return out;
}

export async function plan(st, text, { asrConf = 1, qv = null } = {}) {
  const { kit, bank, persona } = st, said = String(text || "").trim();
  const prevIntern = st.turns.filter((t) => t.role === "intern").slice(0, -1).pop();
  // edge cases first: a person would react to these before thinking about the pitch
  if (said.split(/\s+/).filter(Boolean).length < 1 || asrConf < 0.35) return pickEdge(st, "unclear");
  if (RUDE.test(said)) return { ...pickEdge(st, "rude"), hang: true, flags: { hang_up: true } };
  if (prevIntern && said.length > 15 && overlap(prevIntern.text, said) >= 0.8 && overlap(said, prevIntern.text) >= 0.8)
    return pickEdge(st, "repeat");
  const q = mask(said, persona.name, persona.company);
  const { move, conf, nb } = bank.classify(q, qv);
  const prev = st.turns.filter((t) => t.role === "prospect");
  const pos = [...prev].reverse().find((t) => t.path_pos !== undefined)?.path_pos ?? 0;
  const path = st.path || [];
  let j = pathStep(path, pos, move, conf, q, bank.section);
  const base = { move, conf };
  const caller = callerName(st.turns);
  const used = new Set(prev.map((t) => t.text.toLowerCase()));   // a person doesn't say the exact same line twice
  const cx = context(st, said, move), fit = fitter(cx, kit.callers, caller);
  const ok = (t) => (!t.r.includes("{caller}") || kit.callers.includes(caller)) && !used.has(unmask(t.r, persona, st.turns).toLowerCase()) && fit(t);
  const okEnd = (t) => ok(t) && !/\?\s*$/.test(t.r) && !["who", "what", "question"].includes(t.g);
  const k = st.turns.filter((t) => t.role === "intern").length;
  const pickKind = (kinds, n = 6) => {
    const pool = bank.byKind(kinds, persona, ok, move).slice(0, n);
    return pool.length ? pool[Math.floor(rng(`${st.seed}|g|${k}`)() * pool.length)] : null;
  };
  if (cx.bye) {   // the caller is wrapping up: say bye back and hang up
    const b = pickKind(["bye"]);
    return b ? reply(st, b, "bank", { ...base, path_pos: pos, hang: true }) : { ...pickEdge(st, "bye_back"), ...base, hang: true, flags: { hang_up: true } };
  }
  if (cx.filler) return { ...pickEdge(st, "nudge"), ...base, path_pos: pos };
  if (j !== null && path[j].r && !fit(path[j])) j = null;
  if (j !== null && path[j].r && (conf >= 0.45 || path[j].m !== move))
    return reply(st, path[j], "path", { ...base, path_pos: j + 1, hang: !!path[j].e || path[j].a === "hang_up" });
  const neg = prev.filter((t) => t.obj || NEG.has(t.act)).length;
  const npos = j !== null ? j + 1 : pos, onPath = j !== null && !!path[j].r;
  const draw = rng(`${st.seed}|${k}`)();
  if (!onPath && draw < bank.hazard(move, k, neg, persona.first_reaction)) {
    const e = bank.candidates(move, persona, nb, { n: 1, ending: true, ok: okEnd })[0] || bank.endings(move, persona, okEnd)[0];
    if (e) return reply(st, e, "bank", { ...base, path_pos: npos, hang: true });
  }
  if (OFFTOPIC.test(said) && conf < 0.45) return { ...pickEdge(st, "offtopic"), ...base, path_pos: npos };
  const cands = bank.candidates(move, persona, nb, { n: 6, ending: false, ok });
  if (!onPath && cands[0] && cands[0].m === move && cands[0].sim >= DIRECT) return reply(st, cands[0], "bank", { ...base, path_pos: npos });
  // where the old engine asked an LLM: the owner's own real line if it fits, else the best real bank line
  if (onPath) return reply(st, path[j], "path", { ...base, path_pos: j + 1, hang: !!path[j].e });
  if (cands[0] && cands[0].sim >= MIN_SIM) return reply(st, cands[0], "bank", { ...base, path_pos: npos, loose: true });
  // the closest real caller lines often have no owner reply (the caller kept talking): look wider, then take a real
  // owner's reply to the same kind of line
  const wide = bank.candidates(move, persona, bank.near(q, qv, 120), { n: 3, ending: false, ok });
  if (wide[0] && wide[0].sim >= 0.3) return reply(st, wide[0], "bank", { ...base, path_pos: npos, loose: true });
  if (conf >= 0.3) {
    const pool = bank.byMove(move, persona, ok).slice(0, 8);
    if (pool.length) return reply(st, pool[Math.floor(rng(`${st.seed}|m|${k}`)() * pool.length)], "move", { ...base, path_pos: npos, loose: true });
  }
  const g = pickKind(fallbackKinds(cx));
  if (g) return reply(st, g, "kind", { ...base, path_pos: npos, loose: true });
  return { ...pickEdge(st, "lost"), ...base, path_pos: npos };
}

// a long monologue: the owner makes a small noise, then cuts in (called by the voice loop as words pile up)
export function monologue(st, nWords, played) {
  if (nWords >= 70 && !played.interrupt) return { ...pickEdge(st, "interrupt"), kind: "interrupt" };
  if (nWords >= 28 && !played.back) return { ...pickEdge(st, "backchannel"), kind: "back" };
  return null;
}
// the caller goes quiet after the owner spoke: "Hello?", then "Are you there?", then the owner hangs up
export function silence(st, n) {
  if (n >= 3) return { ...pickEdge(st, "silence_end"), hang: true, flags: { hang_up: true } };
  return pickEdge(st, n === 1 ? "silence1" : "silence2");
}
