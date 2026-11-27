"""Build the browser voice kit for live practice calls (no server, no LLM per turn).
Per track it writes, under bank/voice/:
  kit_{track}.json   bank turns (compact), hang-up hazard, rules, sections, persona paths, edge-case lines, reply timing,
                     the text -> clip id index and each persona's voice;
  emb_{track}.i8     the bank's caller-line embeddings, int8 (row-major, 384 per turn);
  render.jsonl       every clip to pre-record: {"id", "voice", "text"} (voice_render.py turns these into audio).
Real lines are used word for word. Lines marked "gen" were written for cases with no real example (silence, a bad
connection, a repeated line, a long monologue, rudeness); every gen line is short and plain, like the real ones.
Usage: .venv/bin/python voice_kit.py"""
import hashlib, json, os, re, sys
import numpy as np
import embed, paths, realism as R, taxonomy as T

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "bank", "voice")
STAGE = os.path.expanduser("~/Projects/First Project/staging/ai_call_coach/data")
VOICES = {"m": ["am_michael", "am_puck"], "f": ["af_heart", "af_bella"]}
CALLERS = ["Andrew", "Jacob", "Ian", "Jesse", "Harry", "Nate", "Kayden", "Brian", "Ty", "Tate", "Gavin", "Tim"]
PII = re.compile(r"@|\b\d{3}[-. )]\s*\d{3,4}\b|\(\d{3}\)|\bdot com\b", re.I)
BACKCH = {"yeah.", "okay.", "mhmm.", "yes.", "alright.", "yep.", "right.", "no.", "good.", "correct.", "hello?", "uh-huh.",
          "sure.", "k.", "thanks.", "bye.", "nope.", "okay?", "why?", "it is.", "i am."}

# Edge cases the recorded calls don't cover well. real = a line that occurs in our calls; gen = written for this case.
EDGE = {
    "silence1": [("Hello?", "real"), ("Hello? You there?", "gen")],
    "silence2": [("Hello? I can't hear you.", "gen"), ("Are you there?", "gen")],
    "silence_end": [("Okay, I'm gonna hang up.", "gen"), ("Alright, bye.", "gen")],
    "unclear": [("Say again?", "real"), ("Sorry, what was that?", "gen"), ("You cut out on me there.", "gen"),
                ("I didn't catch that.", "gen")],
    "repeat": [("Yeah, you said that.", "gen"), ("Right, I got that part.", "gen"), ("Okay. And?", "gen")],
    "backchannel": [("Mhmm.", "real"), ("Uh-huh.", "real"), ("Yeah.", "real"), ("Okay.", "real"), ("Right.", "real")],
    "interrupt": [("Okay, hold on. What is this about?", "gen"), ("Sorry, I've only got a minute. What do you need?", "gen"),
                  ("Okay, okay. So what are you asking me?", "gen")],
    "rude": [("Okay, I don't need this. Bye.", "gen"), ("Wow. Alright, I'm done.", "gen")],
    "offtopic": [("Who's calling?", "real"), ("Sorry, who is this?", "gen"), ("I'm sorry, what?", "gen")],
    "lost": [("Sorry, what's this about?", "gen"), ("I'm not following. What do you need?", "gen"), ("Sorry, what are you asking?", "gen")],
    "nudge": [("Yeah?", "real"), ("Go ahead.", "gen"), ("What's the question?", "gen"), ("So what do you need?", "gen")],
    "bye_back": [("Alright, you too. Bye.", "gen"), ("Okay, thanks. Bye.", "gen"), ("Yep, bye now.", "gen")],
    "contact": [("Yeah, just send it to the email on our website.", "gen"), ("Sure. Use the info address on our site.", "gen")],
}


def clean_reply(r):
    """Real reply as spoken, or '' when it can't be voiced: contact details (PII) or a cut-off fragment."""
    r = (r or "").strip()
    if not r or PII.search(r): return ""
    r = destutter(r)
    w = r.split()
    if len(w) <= 2 and r[-1] not in ".?!" and r.lower() not in BACKCH: return ""
    if len(w) > 35: return ""                                   # owners on a cold call don't monologue; long ones rarely fit
    if len(w) > 8 and SPLICE.search(r): return ""               # two transcript pieces run together ("be a With whom?")
    return r


SPLICE = re.compile(r"\b[a-z]{2,} (?!I\b|I'|OK\b)[A-Z][a-z]+")


def destutter(r):
    """'it's never gonna it's never gonna' -> 'it's never gonna' (a voice reading a stutter sounds broken)."""
    w = r.split()
    for n in (4, 3, 2, 1):
        i = 0
        while i + 2 * n <= len(w):
            a = [x.lower().strip(",.") for x in w[i:i + n]]
            if a == [x.lower().strip(",.") for x in w[i + n:i + 2 * n]]: del w[i + n:i + 2 * n]
            else: i += 1
    return " ".join(w)


def voice_for(name, key):
    try:
        import gender_guesser.detector as G
        g = G.Detector().get_gender((name or "").split()[0] if name else "")
    except Exception:
        g = "unknown"
    side = "f" if g in ("female", "mostly_female") else "m" if g in ("male", "mostly_male") else None
    h = int(hashlib.sha1(key.encode()).hexdigest(), 16)
    side = side or ("m" if h % 2 else "f")
    return VOICES[side][(h >> 3) % 2]


def segments(text):
    """'Is {owner} there?' -> ['Is', '{owner}', 'there?'] (slots are spliced in at play time)."""
    return [s.strip() for s in re.split(r"(\{(?:owner|company|caller)\})", text) if s.strip()]


class Clips:
    def __init__(self): self.ids, self.jobs = {}, []
    def need(self, text, voices):
        cid = self.ids.setdefault(text, hashlib.sha1(text.encode()).hexdigest()[:12])   # stable: a re-build keeps old clips
        for v in voices: self.jobs.append((cid, v, text))
        return cid


TAGS = {}


# real lines the tag pass kept but a blind judge found make no sense out of their original call
DROP = ("find my business just out of curiosity", "oh, is it chrome", "in 2020. yeah", "it's totally different",
        "not me.", "it is? your name's what", "we... can do that", "we can do that.", "they all do. yes")


def tagged(r):
    """A reply the Haiku tag pass marked as garbled or call-specific is dropped; else (reply, stance, kind)."""
    g = TAGS.get(r)
    if r and any(d in r.lower() for d in DROP): return "", None, None
    if r and g and not g["ok"] and r.lower() not in BACKCH: return "", None, None
    return r, (g or {}).get("s"), (g or {}).get("k")


def build(track, personas, clips, allv):
    b = json.load(open(os.path.join(HERE, "bank", f"turn_bank_{track}.json")))
    turns = []
    for t in b["turns"]:
        r, sg, kd = tagged(clean_reply(t.get("r")))
        for s in segments(r) if r else []:
            if not s.startswith("{"): clips.need(s, allv)
        turns.append({k: t.get(k) for k in ("m", "t", "a", "o", "k", "n", "e", "c", "w", "fr")} | {"r": r, "s": sg, "g": kd})
    emb = embed.bank_matrix(track, [t["t"] for t in b["turns"]])
    q = np.clip(np.round(emb * 127), -127, 127).astype(np.int8)
    q.tofile(os.path.join(OUT, f"emb_{track}.i8"))
    pp = {}
    for row in personas:
        if row["track"] != track or not row.get("active", True): continue
        p = row["persona"]
        v = voice_for(p.get("name"), p.get("path_call") or p.get("name") or "")
        steps = R.annotate([dict(s) for s in p.get("path") or []], p.get("outcome_tx"))
        out = []
        for s in steps:
            r = R.mask(s.get("r") or "", owner=p.get("name"), company=p.get("company"))
            if r and PII.search(r): r = EDGE["contact"][0][0]
            r = clean_reply(r) if r != EDGE["contact"][0][0] else r
            r, sg, kd = tagged(r)
            fill = r.replace("{owner}", p.get("name") or "").replace("{company}", (p.get("company") or "").split(",")[0])
            for sg in segments(fill): sg.startswith("{") or clips.need(sg, [v])
            out.append({"m": s["m"], "t": R.mask(s["t"], owner=p.get("name"), company=p.get("company")), "r": r,
                        "a": s.get("a"), "o": s.get("o"), "e": s.get("e", 0), "s": sg, "g": kd})
        ans = p.get("answer_line") or "Hello?"
        clips.need(ans, [v])
        for nm in filter(None, [p.get("name"), (p.get("company") or "").split(",")[0]]): clips.need(nm, [v])
        pp[p["path_call"]] = {"v": v, "path": out}
    return {"track": track, "turns": turns, "hazard": b.get("hazard") or {}, "dim": int(emb.shape[1]),
            "rules": [[m, rx] for m, rx in paths.RULES], "sections": {s: sorted(ms) for s, ms in T.SECTIONS[track].items()},
            "caller_moves": sorted(T.CALLER[track]), "pitch_moves": sorted(paths.PITCH_MOVES), "personas": pp,
            "neg_acts": sorted(R.NEG)}


def main():
    os.makedirs(OUT, exist_ok=True)
    personas = json.load(open(os.path.join(STAGE, "personas_v2.json")))
    tp = os.path.join(OUT, "_tags.json")
    if os.path.exists(tp): TAGS.update(json.load(open(tp)))   # from voice_tags.py (run it after a bank change)
    allv = [v for vs in VOICES.values() for v in vs]
    clips = Clips()
    edge = {k: [{"text": t, "src": s, "id": clips.need(t, allv)} for t, s in v] for k, v in EDGE.items()}
    for nm in CALLERS: clips.need(nm, allv)
    kits = {tr: build(tr, personas, clips, allv) for tr in ("data", "ma")}
    timing = {"short": [180, 260, 340, 450, 600, 800, 1100], "long": [260, 380, 520, 700, 900, 1200, 1600],
              "note": "reply gap after the caller stops, ms (quantiles; medians from our calls: short 450, long 790)"}
    for tr, k in kits.items():
        k.update(edge=edge, timing=timing, clips=clips.ids, voices=VOICES, callers=CALLERS)
        json.dump(k, open(os.path.join(OUT, f"kit_{tr}.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    seen = set()
    with open(os.path.join(OUT, "render.jsonl"), "w") as f:
        for cid, v, text in clips.jobs:
            if (cid, v) in seen: continue
            seen.add((cid, v)); f.write(json.dumps({"id": cid, "voice": v, "text": text}) + "\n")
    print("clips", len(clips.ids), "renders", len(seen), {tr: (len(k["turns"]), len(k["personas"])) for tr, k in kits.items()},
          {tr: os.path.getsize(os.path.join(OUT, f"kit_{tr}.json")) // 1024 for tr in kits}, "KB")


if __name__ == "__main__":
    sys.exit(main())
