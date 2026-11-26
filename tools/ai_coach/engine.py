"""Runtime glue between the path store (paths.py) and the handlers: loads the turn bank per track, picks real owner
replies for practice, and assembles the outcome-first grade with peer examples."""
import json, os, time
import paths, taxonomy as T
import prompts as P

_banks = {}
BANK_DIR = os.environ.get("AI_COACH_BANK_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "bank"))


def bank(sb, track):
    """Turn bank from ai_kb_docs (slug turn_bank), else a local file; cached 10 min."""
    hit = _banks.get(track)
    if hit and time.time() - hit[0] < 600: return hit[1]
    raw = ""
    if sb is not None:      # read on its own: the bank is big and holds transcripts (kind prompt = admin-only)
        try: raw = (sb.select("ai_kb_docs", f"track=eq.{track}&slug=eq.turn_bank&select=body") or [{}])[0].get("body") or ""
        except Exception: raw = ""
    if not raw:
        p = os.path.join(BANK_DIR, f"turn_bank_{track}.json")
        raw = open(p).read() if os.path.exists(p) else ""
    b = paths.Bank(json.loads(raw)) if raw else None
    _banks[track] = (time.time(), b)
    return b


def grade_weights(sb, track):
    """Section weights calibrated from our calls (calibrate.py -> ai_kb_docs grade_weights); even split until then."""
    try: w = json.loads(P.doc(sb, track, "grade_weights") or "{}")
    except ValueError: w = {}
    return {"outcome": w.get("outcome", .5), "sections": w.get("sections") or {s: .125 for s in T.SECTIONS[track]}}


# ------------------------------------------------------------------------------------------------- practice
def plan_reply(sb, ses, intern_text):
    """-> (decision, real_lines_text). decision is a finished reply when the source call has the real answer to this
    move; otherwise None and the model chooses from real_lines (or writes new)."""
    b = bank(sb, ses["track"])
    if not b: return None, ""
    p = ses.get("persona") or {}
    move, conf, nb = b.classify(intern_text)
    prev = [t for t in ses["turns"] if t["role"] == "prospect"]
    pos = next((t["path_pos"] for t in reversed(prev) if "path_pos" in t), 0)
    path = p.get("path") or []
    j = paths.path_step(path, pos, move, conf)
    meta = {"move": move, "conf": conf}
    if j is not None and path[j].get("r") and conf >= .45:
        st = path[j]
        out = {"say": st["r"], "source": "path", "path_pos": j + 1, **meta,
               **paths.flags_from_act(st.get("a"), st.get("o"), move, any(t.get("opener_ok") is not None for t in prev))}
        return out, ""
    cands = b.candidates(intern_text, move, p, nb)
    lines = []
    if j is not None and path[j].get("r"): lines.append(f'0. PATH (what you really said here): "{path[j]["r"]}"')
    for i, c in enumerate(cands, 1):
        lines.append(f'{i}. BANK (an owner like you, after the caller\'s "{c["t"][:120]}"): "{c["r"]}"')
    meta["path_pos"] = j + 1 if j is not None else pos
    meta["cands"] = [path[j]["r"]] if j is not None else []
    meta["cands"] += [c["r"] for c in cands]
    return meta, "\n".join(lines)


def tag_source(r, meta):
    """Code decides the source the model claims: a 'real' line must actually overlap the real candidate it names."""
    say, cands = str(r.get("say") or ""), meta.get("cands") or []
    best = max((paths.overlap(c, say) for c in cands), default=0)
    src = r.get("source") if r.get("source") in ("path", "bank") and best >= .5 else "new"
    return src, round(best, 2)


# ------------------------------------------------------------------------------------------------- grading
def overall(sb, track, a):
    """Outcome first, then each section scored by the owner's reaction, weighted by what predicts the outcome."""
    w = grade_weights(sb, track)
    oc = T.OUTCOMES.get(a.get("outcome"))
    secs = {k: v["score"] for k, v in (a.get("sections") or {}).items() if isinstance(v, dict) and v.get("score") is not None}
    if not secs and oc is None: return None
    sw = sum(w["sections"].get(k, .1) for k in secs) or 1
    sec = sum(v * w["sections"].get(k, .1) for k, v in secs.items()) / sw if secs else None
    if oc is None: return round(sec)
    if sec is None: return oc
    return max(0, min(10, round(w["outcome"] * oc + (1 - w["outcome"]) * sec)))


def peer_examples(sb, track, section, intern_line, n=2):
    """Lines other callers used in this part of the call that drew a good owner reaction, closest to what this intern
    said first."""
    b = bank(sb, track)
    if not b or not section: return []
    moves = T.SECTIONS[track].get(section, set())
    nb = b.near(intern_line or "", 300) if intern_line else [(i, .01) for i in range(len(b.turns))]
    out, seen = [], set()
    for i, s in nb:
        t = b.turns[i]
        if t["m"] not in moves or T.REACTION_VALUE.get(t.get("a"), 0) < 1 or t.get("w", 0) < 1: continue
        key = t["t"][:60]
        if key in seen or len(t["t"].split()) < 6: continue
        seen.add(key); out.append({"line": t["t"], "owner_reply": t["r"][:200], "move": t["m"]})
        if len(out) >= n: break
    return out
