// Voice practice: does a real owner line fit this moment of the call? Uses the reply tags (tools/ai_coach/voice_tags.py:
// stance + kind per line) and what has been said so far. A real owner doesn't ask who's calling after the caller said
// who they are, ask what it's about after the pitch, agree after saying no, answer a meeting ask with "I have no idea",
// or say "mhmm" to a full pitch. Pure functions, no DOM, so node tests run them.
const ASK_MOVES = new Set(["ask_meeting", "callback_offer", "get_contact", "ask_selling", "fit_question"]);
const ASK_RX = /\b(would you be open|open to|quick call|hop on|set up a|schedule|does \w+( at \w+)? work|can we do|are you free|grab your email|best email|send you|would you consider|interested in)\b/i;
const BYE_RX = /\b(have a (good|great|nice)|take care|bye|thanks for your time|talk (to you )?soon)\b/i;
const FILLER_RX = /^(uh+|um+|so|like|yeah|okay|ok|sure|right|hmm+|well|and|mhmm|yep)[\s,.!?]*((uh+|um+|so|like|yeah|okay|ok|sure|right|hmm+|well|and|mhmm|yep)[\s,.!?]*)*$/i;
const PITCH = /\b(buy|buying|records|data|acquir\w*|sell|selling|business|invest\w*|client|buyer|pay)\b/i;
const NAMED = /\b(my name|this is|calling (from|with)|waystation|working signal)\b/i;
const ANSWERS = new Set(["decline", "accept", "defer", "question", "what"]);

export function context(st, said, move) {
  const me = st.turns.filter((t) => t.role === "intern"), them = st.turns.filter((t) => t.role === "prospect");
  const words = said.split(/\s+/).filter(Boolean).length;
  const declined = them.some((t) => t.kind === "decline") || them.filter((t) => t.stance === "-").length >= 2;
  return {
    late: me.length >= 3,
    heard: new Set(me.map((t) => t.text).concat(said).join(" ").toLowerCase().match(/[a-z']+/g) || []),
    named: me.some((t) => NAMED.test(t.text)),
    pitched: me.some((t) => t.text.split(/\s+/).length >= 10 && PITCH.test(t.text)),
    pitchLine: words >= 12 && PITCH.test(said),
    declined,
    ask: ASK_MOVES.has(move) || ASK_RX.test(said),
    asked: /\?\s*$/.test(said),
    bye: BYE_RX.test(said) && words <= 14 && !ASK_RX.test(said),
    filler: words <= 5 && FILLER_RX.test(said.trim()),
  };
}

// the kinds of real line to fall back on when nothing close fits
export function fallbackKinds(c) {
  if (c.ask) return c.declined ? ["decline", "defer"] : ["decline", "defer", "question"];
  if (c.pitched) return c.declined ? ["decline", "question"] : ["question", "decline", "what"];
  return c.named ? ["what", "question"] : ["who", "what"];
}

const COMMON = new Set("what that this with your from they them have about just like know think yeah okay well sure right there here when where would could should really thing things stuff something business company call calling time today owner".split(" "));
// the owner echoes a word from the original caller's line ("What's NGL?") that this caller never said
function echoes(t, heard) {
  const orig = new Set((t.t || "").toLowerCase().match(/[a-z']+/g) || []);
  return ((t.r || "").toLowerCase().match(/[a-z']+/g) || []).some((w) => (w.length >= 3 || /^[a-z]{2,}$/.test(w) && w === w.toUpperCase())
    && !COMMON.has(w) && orig.has(w) && !heard.has(w) && !/^\{/.test(w));
}
// a few domain words an owner only says if the caller brought the topic up
const TOPIC = /\b(ngl|oil|gas|oilfield|disposal|pipeline|data center|swd|frac|well|wells|ai)\b/gi;

export function fitter(c, callers, caller) {
  const other = callers.filter((n) => n !== caller);
  const otherRx = other.length ? new RegExp(`\\b(${other.join("|")}|waystation|working signal)\\b`, "i") : /\b(waystation|working signal)\b/i;
  return (t) => {
    const r = t.r || "", g = t.g;
    if (otherRx.test(r)) return false;                  // a line naming the original call's caller or firm
    if (/^hello[?.!]*$/i.test(r.trim())) return false;   // "Hello?" mid-call is the silence case, not a reply
    if (/(,|\b(but|and|so|like|the|a|to|i|i'm|is|of))\s*$/i.test(r.trim())) return false;   // cut off mid-sentence
    if (t.t && echoes(t, c.heard)) return false;
    if (c.late && /\b(how are you|how're you|good morning|good afternoon)\b/i.test(r)) return false;   // greetings belong to the opener
    if ((r.match(TOPIC) || []).some((w) => !c.heard.has(w.toLowerCase().split(" ")[0]))) return false;
    if (!g) return true;
    if (g === "who" && (c.named || caller)) return false;
    if (g === "what" && c.pitched) return false;
    if (c.declined && (g === "accept" || t.s === "+")) return false;
    if (c.ask && !ANSWERS.has(g)) return false;
    if (c.ask && c.declined && g === "accept") return false;
    if (c.asked && (g === "ack" || g === "bye")) return false;
    if (c.pitchLine && g === "ack") return false;
    return true;
  };
}
