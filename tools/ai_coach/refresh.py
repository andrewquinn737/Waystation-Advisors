"""Grow the turn bank from new real calls (run inside the weekly retrain, one track at a time).
1. clean each new call (clean.clean: IVR, echoes, speaker swaps, track from what the caller pitched);
2. Haiku labels every caller move and owner act, plus the outcome read from the transcript (labels outside
   taxonomy.py are dropped in code);
3. add the new calls' turns to the stored bank (a call already in the bank is skipped), rebuild the hang-up hazard
   from every call's turns, and save the bank (ai_kb_docs slug turn_bank, a new version each week).
Returns the labeled calls so retrain can give new personas their real call path."""
import json
from concurrent.futures import ThreadPoolExecutor
import clean as CL, coachlib as cl, paths, realism as R, taxonomy as T

MODEL = "haiku"
BATCH, WORKERS = 5, 4
PITCH = {"data": "The caller (brand Working Signal or Waystation) wants to PAY the business for a copy of old records/data, "
                 "de-identified, licensed to AI companies. The next step is a call with Arieh.",
         "ma": "The caller (Waystation Advisors) represents a BUYER who wants to acquire the business. "
               "The next step is an intro call with the buyer."}
SYS = "You label cold-call transcripts. Reply with JSON only."


def w_outcome(c):
    return round(1 + (T.OUTCOMES.get(c.get("outcome_tx")) or 0) / 5, 2)     # 1.0 (no) .. 3.0 (meeting booked)


def _tx(c, cap=7000):
    return "\n".join(f"{i} {'C' if s == 'intern' else 'P' if s == 'owner' else 'IVR'}: {t[:300]}"
                     for i, (s, t, _) in enumerate(c["lines"]))[:cap]


def _prompt(batch, tr):
    return (f"Label cold-call transcripts. Track: {tr}. {PITCH[tr]}\nLines are numbered. C = caller, P = prospect, IVR = machine.\n"
            f"For every C line give a caller move from: {', '.join(T.CALLER[tr])}.\n"
            f"For every P line give an act from: {', '.join(T.OWNER_ACTS)}. If the act is objection, add the type from: "
            f"{', '.join(T.OBJECTIONS[tr])}.\nSkip IVR lines. Also give the call outcome from: {', '.join(T.OUTCOMES)}, and dm: "
            "the first line number where the owner/decision maker is the one talking (-1 if never).\n"
            'Reply with a JSON array only, one object per call in order: {"k": <call>, "outcome": "...", "dm": n, '
            '"L": [[line, "label"] or [line, "objection", "type"], ...]}\n\n'
            + "\n\n".join(f"CALL {j}\n{_tx(c)}" for j, c in enumerate(batch)))


def _apply(c, e, tr):
    """Model labels -> labels / outcome_tx / dm on the call; anything outside the label sets is dropped."""
    n = len(c["lines"]); lab = [None] * n
    for x in (e or {}).get("L") or []:
        if not isinstance(x, list) or len(x) < 2 or not isinstance(x[0], int) or not 0 <= x[0] < n: continue
        s = c["lines"][x[0]][0]
        if s == "intern" and x[1] in T.CALLER[tr]: lab[x[0]] = {"move": x[1]}
        elif s == "owner" and x[1] in T.OWNER_ACTS:
            lab[x[0]] = {"act": x[1]}
            if x[1] == "objection": lab[x[0]]["obj"] = x[2] if len(x) > 2 and x[2] in T.OBJECTIONS[tr] else "other"
    oc = (e or {}).get("outcome")
    dm = (e or {}).get("dm")
    c.update(labels=lab, outcome_tx=oc if oc in T.OUTCOMES else None,
             dm=dm if isinstance(dm, int) and -1 <= dm < n else -1)
    return c


def _label_batch(batch, tr):
    try:
        arr = cl.parse_json(cl.run_claude(_prompt(batch, tr), SYS, model=MODEL, timeout=300))
    except cl.ClaudeError as e:
        if e.kind in ("auth", "limit"): raise
        arr = None
    by = {x.get("k"): x for x in arr if isinstance(x, dict)} if isinstance(arr, list) else {}
    return [_apply(c, by.get(j), tr) for j, c in enumerate(batch) if by.get(j)]


def label(calls, tr):
    bs = [calls[i:i + BATCH] for i in range(0, len(calls), BATCH)]
    with ThreadPoolExecutor(WORKERS) as ex:
        return [c for out in ex.map(lambda b: _label_batch(b, tr), bs) for c in out]


def regroup(turns):
    """Stored bank turns -> [(first_reaction, steps in call order)] for the hazard."""
    by = {}
    for t in turns: by.setdefault(t["c"], []).append(t)
    return [(ts[0].get("fr"), sorted(ts, key=lambda t: t.get("k") or 0)) for ts in by.values()]


def merge(old, new_calls, track):
    turns = list((old or {}).get("turns") or [])
    have = {t["c"] for t in turns}
    fresh = [c for c in new_calls if c["id"][:8] not in have]
    add = paths.build_bank(fresh, track, w_outcome)["turns"]
    turns += add
    return {"track": track, "turns": turns, "hazard": R.build_hazard(regroup(turns))}, len({t["c"] for t in add})


def run(sb, track, calls, save_doc):
    """calls: retrain.db_calls rows. Returns (labeled calls, stats)."""
    raw = (sb.select("ai_kb_docs", f"track=eq.{track}&slug=eq.turn_bank&select=body") or [{}])[0].get("body")
    old = json.loads(raw) if raw else None
    have = {t["c"] for t in (old or {}).get("turns") or []}
    todo = []
    for c in calls:
        if c["id"][:8] in have: continue
        cc = CL.clean(c)
        if not cc["junk"] and cc["track"] == track: todo.append(cc)
    if not todo: return [], {"bank_new_calls": 0, "bank_turns": len((old or {}).get("turns") or [])}
    done = label(todo, track)
    b, added = merge(old, done, track)
    stats = {"bank_new_calls": added, "bank_labeled": len(done), "bank_turns": len(b["turns"]),
             "bank_hang_scale": b["hazard"].get("_scale")}
    if added and old is not None:          # never start a bank from scratch here: the first build is build_paths.py
        stats["bank_version"] = save_doc(sb, track, "turn_bank", f"Turn bank ({track})", paths.dumps(b), "prompt", 0)
    return done, stats
