"""Weights, persona bank and calls-playbook stats. Used by the first build (staging extract) and the weekly retrain (DB).
A call record here is: {id, track, caller, started_at, outcome, duration_sec, company_name, owner_name, industry,
city, lines: [[speaker, text, ms]], ai: {reached, opener_quote, first_reaction, first_reaction_quote, objections,
result, worked, failed, persona}}."""
import math, re
from collections import Counter, defaultdict
from datetime import datetime, timezone

OUTCOME_W = {"intro_call_scheduled": 3.0, "callback_interested": 3.0, "busy_callback": 1.5}
STAR_CALLER = "Andrew"            # Mason: weight Andrew's latest week especially heavily
STAR_W = 4.0
HALF_LIFE_DAYS = 45
OUTCOME_PLAIN = {"intro_call_scheduled": "you agreed to an intro call", "callback_interested": "you asked them to call back, interested",
                 "busy_callback": "you said call back later", "not_interested": "you said you were not interested",
                 "no_response": "the call ended without a next step", "unable_to_contact": "the call ended without a next step"}
OPENER_FEATURES = {
    "weird_request": r"weird request|strange request|odd request|unusual request",
    "researching": r"\bresearch(ing)?\b",
    "why_you_years": r"\b(years|decade|since \d{4}|been around|been in business)\b",
    "pay_or_buyer": r"\b(pay|paid|compensat|buyer|acquir|client)\w*",
    "how_much_q": r"how much (would|do you think|does)",
    "permission_q": r"(do you have|got) (a (minute|second|sec)|time)|bad time|caught you",
    "ai_named": r"\b(ai|anthropic|openai|artificial intelligence)\b",
    "how_are_you": r"how are you( doing)?\b",
}


OBJ_MAP = {"not_for_sale": "not_selling", "no_data": "wrong_fit", "price_value": "price_or_value", "scam_suspicion": "scam_or_trust",
           "need_partner": "not_decision_maker", "gatekeeper_block": "not_decision_maker"}
REACT_MAP = {"brushoff": "brush_off", "hard_no": "brush_off", "question": "curious", "neutral": "curious"}


def normalize(row, ai):
    """Staging extract (+ the labeled row with lines) or a DB analysis -> the record shape above, one label vocabulary."""
    a = dict(ai or {})
    a["track"] = {"data_sale": "data"}.get(a.get("track"), a.get("track"))
    a["first_reaction"] = REACT_MAP.get(a.get("first_reaction"), a.get("first_reaction"))
    objs = []
    for o in a.get("objections") or []:
        h = o.get("handled")
        objs.append({**o, "type": OBJ_MAP.get(o.get("type"), o.get("type") or "other"),
                     "handled": h in (True, "well", "ok"), "recovered": bool(o.get("recovered"))})
    a["objections"] = objs
    return {"id": row["id"], "caller": row.get("caller"), "started_at": row.get("started_at"), "outcome": row.get("outcome"),
            "duration_sec": row.get("duration_sec"), "company_name": row.get("company_name"), "owner_name": row.get("owner_name"),
            "industry": row.get("industry"), "city": row.get("city") or row.get("owner_state"), "lines": row.get("lines") or [], "ai": a}


IVR_RX = r"press \d|extension|directory|leave a message|record your name|please hold|stay on the line|after the (tone|beep)|mailbox|business hours|your call (will|is)|your party|if you know|voicemail|forwarded"
RESULT_PLAIN = {"meeting_or_callback": "you agreed to talk again", "info_sent": "you asked them to send something by email",
                "soft_no": "you politely said no", "hard_no": "you firmly said no", "hung_up": "you ended the call abruptly",
                "transferred": "you passed them to someone else", "left_message": "", "other": ""}


def talk_stats(owner_lines):
    """Per-owner calibration: how long and how questioning this person really was."""
    ws = sorted(len(t.split()) for t in owner_lines if not re.search(IVR_RX, t, re.I)) or [3]
    q = sum("?" in t for t in owner_lines) / max(1, len(owner_lines))
    return {"words_median": ws[len(ws) // 2], "words_p90": ws[min(len(ws) - 1, int(len(ws) * 0.9))],
            "turns": len(owner_lines), "question_share": round(q, 2)}


def greeting_of(lines):
    """How the owner answered 'is this <name>?' / the hello: plain confirm or guarded, plus the real words."""
    turns, cur = [], None
    for sp, t, *_ in lines:
        r = "i" if sp == "intern" else "o"
        if turns and turns[-1][0] == r: turns[-1][1] += " " + t
        else: turns.append([r, t])
    for k, (r, t) in enumerate(turns[:-1]):
        if r == "i" and re.search(r"\bis (this|that)\b|speaking with|how are you", t, re.I) and turns[k + 1][0] == "o":
            reply = turns[k + 1][1][:120]
            style = "guarded" if re.search(r"\bwho\b|what is this|what's this|what company|calling (from|with)", reply, re.I) else "confirm"
            return {"style": style, "quote": reply}
    return {"style": "confirm", "quote": ""}


FOLLOWUP_RX = r"\b(again|calling (you )?back|call(ing)? you back|we spoke|following up|follow up|we talked|returning your call|you called)\b"


def answer_line(lines):
    """What the owner said on pickup: their line before the caller's first words, else a plain hello."""
    if not lines or lines[0][0] == "intern": return "Hello?"
    t = lines[0][1].strip()
    if re.search(IVR_RX, t, re.I) or len(t.split()) > 12: return "Hello?"
    if re.match(r"(thanks|thank you),? \w+\.?$|mister|mr\.?|ms\.?", t, re.I): return "Hello?"
    if len(t.split()) < 2 and not re.match(r"(hello|hi|yeah|yes|this is)", t, re.I): return "Hello?"
    return t


def parse_dt(s):
    if not s: return None
    try: return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError: return None


def star_week(now):
    """The last completed Mon-Sun week before `now`, plus the current partial week."""
    from datetime import timedelta
    monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return monday - timedelta(days=7), now


def weight(c, now=None):
    now = now or datetime.now(timezone.utc)
    w = OUTCOME_W.get(c.get("outcome"), 1.0)
    dt = parse_dt(c.get("started_at"))
    if dt:
        age = max(0.0, (now - dt).total_seconds() / 86400)
        w *= 0.5 ** (age / HALF_LIFE_DAYS)
        lo, hi = star_week(now)
        if STAR_CALLER.lower() in (c.get("caller") or "").lower() and lo <= dt <= hi: w *= STAR_W
    return round(max(w, 0.05), 3)


def is_conversation(c):
    a = c.get("ai") or {}
    owner = [l for l in c["lines"] if l[0] == "owner"]
    return a.get("reached") == "decision_maker" and len(owner) >= 4


def track_of(c):
    t = (c.get("ai") or {}).get("track")
    return {"data_sale": "data", "data": "data", "ma": "ma"}.get(t)


def opener_features(q):
    q = (q or "").lower()
    return {k: bool(re.search(rx, q)) for k, rx in OPENER_FEATURES.items()}


def persona_from_call(c):
    a = c.get("ai") or {}
    ps = a.get("persona") or {}
    owner_lines = [l[1] for l in c["lines"] if l[0] == "owner"]
    first = answer_line(c["lines"])
    react = a.get("first_reaction") or "neutral"
    react = REACT_MAP.get(react, react)
    if react not in ("hostile", "brush_off", "busy", "curious", "engaged"): react = "curious"
    n = len(owner_lines)
    patience = "low" if n < 8 or react in ("hostile", "brush_off") and n < 14 else ("high" if n > 30 else "medium")
    sig = [s for s in (ps.get("signature_phrases") or []) if isinstance(s, str) and 3 <= len(s) <= 160][:6]
    objs = [{"type": o.get("type") or "other", "quote": o.get("prospect_quote") or ""}
            for o in a.get("objections") or [] if o.get("prospect_quote")]
    owner_first = (c.get("owner_name") or "").split()[0] if c.get("owner_name") else None
    intern_open = " ".join(l[1] for l in c["lines"][:4] if l[0] == "intern")
    followup = bool(re.search(FOLLOWUP_RX, intern_open, re.I))
    return {
        "name": owner_first, "company": c.get("company_name"), "industry": c.get("industry"), "city": c.get("city"),
        "role": ps.get("role") or "owner", "tone": ps.get("tone"), "talk_style": ps.get("talk_style"),
        "patience": patience, "first_reaction": react, "first_reaction_quote": a.get("first_reaction_quote") or "",
        "objections": objs, "what_moved_them": a.get("worked") or "", "what_lost_them": a.get("failed") or "",
        "outcome": c.get("outcome"), "outcome_plain": OUTCOME_PLAIN.get(c.get("outcome"), ""),
        "signature_phrases": sig, "answer_line": first[:200], "talk": talk_stats(owner_lines),
        "greeting": greeting_of(c["lines"]), "followup": followup,
        "result_plain": RESULT_PLAIN.get(a.get("result"), ""),
        "src": {"caller": c.get("caller"), "started_at": c.get("started_at"), "outcome": c.get("outcome")},
    }


def persona_rows(calls, now=None, version=1):
    """One persona per real conversation (deduped by company, highest weight wins)."""
    best = {}
    for c in calls:
        t = track_of(c)
        if not t or not is_conversation(c): continue
        p = persona_from_call(c)
        key = (t, (c.get("company_name") or c["id"]).lower())
        w = weight(c, now)
        if key in best and best[key]["weight"] >= w: continue
        label = f"{p['first_reaction'].replace('_', ' ').title()} {p.get('industry') or 'business'} owner"
        if p["objections"]: label += ", " + ", ".join(sorted({o['type'].replace('_', ' ') for o in p['objections']})[:3])
        best[key] = {"track": t, "source_call_id": c["id"], "label": label[:120], "persona": p,
                     "first_reaction": p["first_reaction"], "objection_types": sorted({o["type"] for o in p["objections"]}),
                     "outcome": c.get("outcome"), "weight": w, "active": not p["followup"], "version": version}
    return list(best.values())


def stats(calls, track, now=None):
    """Weighted numbers the playbook is written from (so the model can't invent them)."""
    cs = [c for c in calls if track_of(c) == track and (c.get("ai") or {}).get("reached") == "decision_maker"]
    tot = sum(weight(c, now) for c in cs) or 1
    react = Counter()
    for c in cs: react[(c["ai"].get("first_reaction") or "neutral")] += weight(c, now)
    feat = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])     # with: weight, good-weight; without: weight, good-weight
    for c in cs:
        good = (c["ai"].get("first_reaction") not in ("hostile", "brush_off")) and len([l for l in c["lines"] if l[0] == "owner"]) >= 6
        f = opener_features(c["ai"].get("opener_quote"))
        w = weight(c, now)
        for k, v in f.items():
            i = 0 if v else 2
            feat[k][i] += w; feat[k][i + 1] += w * good
    obj = defaultdict(lambda: [0.0, 0.0, 0.0])           # weight, handled-weight, recovered-weight
    for c in cs:
        w = weight(c, now)
        for o in c["ai"].get("objections") or []:
            t = o.get("type") or "other"
            obj[t][0] += w; obj[t][1] += w * bool(o.get("handled")); obj[t][2] += w * bool(o.get("recovered"))
    pct = lambda a, b: round(100 * a / b) if b else None
    return {
        "conversations": len(cs), "positive": sum(c.get("outcome") in OUTCOME_W and OUTCOME_W[c["outcome"]] >= 3 for c in cs),
        "first_reaction_pct": {k: pct(v, tot) for k, v in react.most_common()},
        "opener_feature_keep_talking_pct": {k: {"with": pct(v[1], v[0]), "without": pct(v[3], v[2]), "share_using": pct(v[0], v[0] + v[2])}
                                            for k, v in feat.items()},
        "objections": {k: {"share": pct(v[0], tot), "handled_pct": pct(v[1], v[0]), "recovered_pct": pct(v[2], v[0])}
                       for k, v in sorted(obj.items(), key=lambda kv: -kv[1][0])},
    }


def top_examples(calls, track, n=14, now=None):
    cs = [c for c in calls if track_of(c) == track and is_conversation(c)]
    cs.sort(key=lambda c: -weight(c, now) * (1 + len(c["ai"].get("objections") or [])) ** 0.3)
    return cs[:n]


def example_text(c, max_lines=34):
    a = c["ai"]
    body = "\n".join(f"{'Intern' if s == 'intern' else 'Owner'}: {t}" for s, t, *_ in c["lines"][:max_lines])
    return (f"[call {c['id'][:8]} | caller {c.get('caller')} | outcome {c.get('outcome')} | weight {weight(c)}]\n"
            f"Worked: {a.get('worked') or '-'} | Failed: {a.get('failed') or '-'}\n{body}")
