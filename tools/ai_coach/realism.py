"""Three things that make the practice owner behave like the recorded owners, all built from real calls:
1. hang-up hazard: how likely a real owner is to end the call right after a caller turn, by section, turn number, how
   often they already pushed back and their first reaction (shrunk toward coarser cells when data is thin);
2. whole-call arc: bank lines from calls whose owner behaved like this persona, at the same point in the call and the
   same level of pushback, rank higher, so one practice call follows one kind of real owner;
3. names: real replies are stored with {owner}/{company}/{caller} slots so a real line can be used word for word."""
import re
import taxonomy as T

END = {"hang_up", "ending"}
END_OUTCOMES = {"hard_no", "soft_no", "hung_up", "info_or_email"}   # calls the owner ended
NEG = {"objection", "brush_off"}


def tb(k): return "1" if k <= 1 else "2" if k == 2 else "3-4" if k <= 4 else "5-7" if k <= 7 else "8+"
def nb(n): return str(min(n, 2))


def hkeys(sec, k, neg, fr):
    return ["*", sec, f"{sec}|{tb(k)}", f"{sec}|{tb(k)}|{nb(neg)}", f"{sec}|{tb(k)}|{nb(neg)}|{fr}"]


def annotate(steps, outcome=None):
    """Add k (caller turn number), n (owner pushbacks before it) and e (the owner ended the call with this reply).
    A real hang-up mostly leaves no owner line: the owner's last words ("No, I wouldn't. Thanks.") end the call and
    the caller just says bye. So in a call the owner ended, the last step with an owner reply is the ending."""
    neg = 0
    for k, st in enumerate(steps, 1):
        st["k"], st["n"], st["e"] = k, neg, int(st.get("a") == "hang_up")
        if st.get("a") in NEG: neg += 1
    if outcome in END_OUTCOMES:
        last = max((i for i, st in enumerate(steps) if st.get("r")), default=None)
        if last is not None: steps[last]["e"] = 1
    return steps


def is_end(t): return bool(t.get("e"))


def build_hazard(calls_steps):
    """calls_steps: [(first_reaction, annotated steps)] -> {cell: [turns, endings]}."""
    cnt = {}
    for fr, steps in calls_steps:
        for st in steps:
            sec = T.section_of_any(st["m"]) or "other"
            end = bool(st.get("e"))
            for key in hkeys(sec, st["k"], st["n"], fr):
                c = cnt.setdefault(key, [0, 0]); c[0] += 1; c[1] += end
            if end: break
    # shrinkage pulls thin late-call cells toward the calmer early-call average, so the raw table ends too few calls;
    # one scale factor makes the expected number of endings equal the real number (held-out check in HANDOFF.md)
    ends = sum(1 for _, st in calls_steps if any(x.get("e") for x in st))
    exp = 0.0
    for fr, steps in calls_steps:
        for st in steps:
            exp += _raw(cnt, st["m"], st["k"], st["n"], fr)
            if st.get("e"): break
    cnt["_scale"] = round(ends / exp, 3) if exp else 1.0
    return cnt


def _raw(table, move, k, neg, fr, prior=10):
    sec = T.section_of_any(move) or "other"
    est = None
    for key in hkeys(sec, k, neg, fr):
        n, e = table.get(key, (0, 0))
        est = e / max(n, 1) if est is None else (e + prior * est) / (n + prior)
    return est or 0.0


def hazard(table, move, k, neg, fr, prior=10):
    """P(owner ends the call after this caller turn). Each finer cell is shrunk toward its parent."""
    if not table: return 0.0
    return round(min(.95, _raw(table, move, k, neg, fr, prior) * table.get("_scale", 1.0)), 4)


# ------------------------------------------------------------------------------------------------- arc
def profile(c, outcome_score):
    """What kind of owner a call had."""
    return {"fr": (c.get("ai") or {}).get("first_reaction"), "oc": outcome_score}


def arc_bonus(t, prof, k, neg, guide=None):
    """Multiplier for a bank turn t given the persona's profile and where the practice call is now."""
    b = 1.0
    cp = t.get("p") or {}
    if prof.get("fr") and cp.get("fr") == prof["fr"]: b *= 1.25
    if prof.get("oc") is not None and cp.get("oc") is not None: b *= 1.25 if abs(cp["oc"] - prof["oc"]) <= 2 else .85
    if t.get("k"): b *= 1 + .3 / (1 + abs(t["k"] - k) / 2)
    if t.get("n") is not None: b *= 1.2 if nb(t["n"]) == nb(neg) else .9
    if guide and t.get("c") == guide: b *= 1.6
    return b


def guide_call(bank_turns, prof, exclude=None):
    """The real call closest to this persona (same first reaction, nearest outcome, longest), used as the arc."""
    best, key = None, None
    for t in bank_turns:
        cp = t.get("p") or {}
        if t.get("c") == exclude or cp.get("fr") != prof.get("fr"): continue
        s = (-abs((cp.get("oc") or 0) - (prof.get("oc") or 0)), t.get("k") or 0)
        if key is None or s > key: best, key = t.get("c"), s
    return best


# ------------------------------------------------------------------------------------------------- names
def _rx(words): return re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")\b", re.I) if words else None
GENERIC = {"inc", "llc", "the", "and", "co", "company", "group", "services", "of", "corp", "ltd", "&"}


def mask(text, owner=None, company=None, caller=None):
    if not text: return text
    first = (owner or "").split()[0] if owner else ""
    for slot, words in (("{owner}", [w for w in (owner or "").split() if len(w) > 2] + ([first] if first else [])),
                        ("{caller}", [w for w in (caller or "").split()[:1] if len(w) > 2]),
                        ("{company}", [w for w in re.findall(r"[A-Za-z']+", company or "") if len(w) > 3 and w.lower() not in GENERIC])):
        rx = _rx(sorted(set(words), key=len, reverse=True))
        if rx: text = rx.sub(slot, text)
    return re.sub(r"(\{(owner|company|caller)\}\s*)+", lambda m: m.group(1).strip() + " ", text).strip()


def unmask(text, persona, turns):
    caller = next((m.group(1) for t in turns if t["role"] == "intern"
                   for m in [re.search(r"\b(?:my name is|this is|it'?s) ([A-Z][a-z]+)", t["text"])] if m), "")
    comp = (persona.get("company") or "").split(",")[0]
    out = text.replace("{owner}", persona.get("name") or "").replace("{company}", comp).replace("{caller}", caller)
    return re.sub(r"\s+([,.?!])", r"\1", re.sub(r"\s{2,}", " ", out)).strip()
