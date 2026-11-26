#!/usr/bin/env python3
"""Judge the practice prospect against real owners. For each held-out real conversation we build that owner's persona,
replay the REAL caller lines up to an owner turn, and compare the AI owner's reply to what the real owner said.
Metrics: stance match (deterministic compare of judge labels), objection-type match, similarity 1-5, reply length ratio,
"too helpful" rate, and the ending (does the AI end the call where the real owner did).
Modes: full = the production persona card; blind = quotes stripped (tests that it generalizes, not parrots).
Usage: python3 judge.py records.jsonl --track data --n 40 --mode full --model sonnet --out judge_run.json"""
import argparse, json, os, random, re, sys
from concurrent.futures import ThreadPoolExecutor
import bank, coachlib as cl, prompts as P

STANCES = ["engaged", "curious_question", "neutral_ack", "guarded_question", "objection", "brush_off", "ending", "agree_next_step"]
JUDGE_SYS = """You compare two replies a small-business owner could give on a cold call: REAL (what the owner actually
said) and AI (a simulation). Label each reply's stance with one of: engaged (talks freely, shares info), curious_question
(asks to learn more, open), neutral_ack (okay/yeah/uh huh, letting the caller go on), guarded_question (asks who/why/how
with suspicion), objection (raises a concern or reason not to), brush_off (polite no, send an email, not interested),
ending (says goodbye or hangs up), agree_next_step (agrees to a call, meeting or contact).
Objection type (or null): not_interested, busy, what_is_this, who_are_you, scam_or_trust, price_or_value,
confidentiality, send_email, not_decision_maker, not_selling, timing, already_have, wrong_fit, other.
sim 1-5: would a listener believe both replies came from the same person in the same mood at this moment? 5 = same
stance, same concern, same register; 3 = same direction, different detail; 1 = opposite.
too_helpful: the AI reply is more patient, polite, articulate or eager than a real busy owner would be here.
Reply with a JSON array, one object per item, in order:
[{"k": 0, "real": "<stance>", "ai": "<stance>", "real_obj": null, "ai_obj": null, "sim": 3, "too_helpful": false}]"""


def turns_of(lines):
    out = []
    for sp, text, *_ in lines:
        role = "intern" if sp == "intern" else "prospect"
        if out and out[-1]["role"] == role: out[-1]["text"] += " " + text
        else: out.append({"role": role, "text": text})
    if out and out[0]["role"] == "intern": out.insert(0, {"role": "prospect", "text": "Hello?"})
    return out


def targets(turns, k=4):
    """Owner turns to test: the reply to the pitch, any with an objection-ish cue, and the last one.
    Skips IVR / receptionist turns and transcription crumbs (under 2 words)."""
    ivr = lambda t: re.search(bank.IVR_RX, t, re.I)
    idx = [i for i, t in enumerate(turns) if t["role"] == "prospect" and i >= 2 and not ivr(t["text"])
           and not ivr(turns[i - 2]["text"]) and len(t["text"].split()) >= 1]
    if not idx: return []
    first = idx[0]
    words = [i for i in idx[1:-1] if re.search(r"\b(not interested|no thanks|email|who|why|how much|scam|confidential|busy|"
                                              r"don't|can't|selling|partner)\b", turns[i]["text"], re.I)]
    pick = [first] + words[:k - 2] + [idx[-1]]
    rest = [i for i in idx if i not in pick]
    random.shuffle(rest)
    pick += rest[:max(0, k - len(set(pick)))]
    return sorted(set(pick))[:k + 1]


def blind(p):
    p = dict(p)
    p["first_reaction_quote"] = ""; p["signature_phrases"] = []
    p["greeting"] = {**(p.get("greeting") or {}), "quote": ""}
    p["objections"] = [{"type": o["type"], "quote": ""} for o in p.get("objections") or []]
    return p


def ask_prospect(sb, persona, track, prefix, model):
    ses = {"persona": persona, "track": track, "stage": "full", "rules": P.doc(sb, "shared", "stage_rules_full")}
    raw = cl.run_claude(P.prospect_user(prefix), P.prospect_system(sb, ses), model=model, timeout=120)
    r = cl.parse_json(raw)
    if not isinstance(r, dict): r = {"say": raw.strip()[:300]}
    return r


def judge_batch(items, model="haiku"):
    body = []
    for k, it in enumerate(items):
        ctx = "\n".join(f"{'Caller' if t['role'] == 'intern' else 'Owner'}: {t['text'][:300]}" for t in it["prefix"][-3:])
        body.append(f"ITEM {k}\nContext:\n{ctx}\nREAL: {it['real']}\nAI: {it['ai']}")
    out = cl.parse_json(cl.run_claude("\n\n".join(body), JUDGE_SYS, model=model, timeout=180))
    out = out if isinstance(out, list) else []
    by = {o.get("k"): o for o in out if isinstance(o, dict)}
    return [by.get(k) or {} for k in range(len(items))]


def run(sb, recs, track, n, mode, model, workers=5, seed=7):
    random.seed(seed)
    pool = [c for c in recs if bank.track_of(c) == track and bank.is_conversation(c)]
    pool.sort(key=lambda c: c["id"]); random.shuffle(pool)
    by_react = {}
    for c in pool: by_react.setdefault(c["ai"].get("first_reaction"), []).append(c)
    sample, i = [], 0                                           # round-robin over first reactions: every owner type tested
    while len(sample) < n and any(by_react.values()):
        for key in list(by_react):
            if by_react[key] and len(sample) < n: sample.append(by_react[key].pop())
    jobs = []
    for c in sample:
        p = bank.persona_from_call(c)
        p = blind(p) if mode == "blind" else p
        ts = turns_of(c["lines"])
        for ti in targets(ts):
            jobs.append({"call": c["id"], "persona": p, "prefix": ts[:ti], "real": ts[ti]["text"][:400],
                         "real_last": ti == max(j for j, t in enumerate(ts) if t["role"] == "prospect"), "first": ti == 2 or ti == targets(ts)[0]})
    def go(j):
        try:
            r = ask_prospect(sb, j["persona"], track, j["prefix"], model)
            j["ai"], j["ai_hang"] = str(r.get("say") or "")[:400], bool(r.get("hang_up"))
        except cl.ClaudeError as e:
            j["ai"], j["err"] = "", str(e)
        return j
    with ThreadPoolExecutor(workers) as ex: jobs = list(ex.map(go, jobs))
    jobs = [j for j in jobs if j.get("ai")]
    batches = [jobs[i:i + 8] for i in range(0, len(jobs), 8)]
    with ThreadPoolExecutor(workers) as ex:
        for b, res in zip(batches, ex.map(judge_batch, batches)):
            for j, r in zip(b, res): j["j"] = r
    return jobs, summarize(jobs)


def summarize(jobs):
    jj = [j for j in jobs if j.get("j")]
    if not jj: return {"n": 0}
    m = lambda xs: round(sum(xs) / len(xs), 3) if xs else None
    first = [j for j in jj if j["first"]]
    objs = [j for j in jj if j["j"].get("real_obj")]
    wr = lambda s: max(1, len(s.split()))
    return {
        "n_calls": len({j["call"] for j in jj}), "n_turns": len(jj),
        "stance_match": m([j["j"].get("real") == j["j"].get("ai") for j in jj]),
        "first_reaction_match": m([j["j"].get("real") == j["j"].get("ai") for j in first]),
        "objection_type_match": m([j["j"].get("real_obj") == j["j"].get("ai_obj") for j in objs]),
        "sim_avg": m([float(j["j"].get("sim") or 0) for j in jj]),
        "too_helpful_rate": m([bool(j["j"].get("too_helpful")) for j in jj]),
        "len_ratio_median": sorted(wr(j["ai"]) / wr(j["real"]) for j in jj)[len(jj) // 2],
        "ending_match": m([j["ai_hang"] == (j["j"].get("real") == "ending") for j in jj if j["real_last"]]),
        "confusion": confusion(jj),
    }


def confusion(jj):
    c = {}
    for j in jj:
        k = f"{j['j'].get('real')}->{j['j'].get('ai')}"
        c[k] = c.get(k, 0) + 1
    return dict(sorted(c.items(), key=lambda kv: -kv[1])[:14])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("records"); ap.add_argument("--track", default="data"); ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--mode", default="full"); ap.add_argument("--model", default="sonnet"); ap.add_argument("--out")
    ap.add_argument("--seed", type=int, default=7); ap.add_argument("--rejudge", help="re-score a saved run's replies")
    a = ap.parse_args()
    import dev_sb
    os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = dev_sb.claude_token(); os.environ.pop("ANTHROPIC_API_KEY", None)
    sb = dev_sb.test_client()
    if a.rejudge:
        jobs = [j for j in json.load(open(a.rejudge))["jobs"] if j.get("ai")]
        for b in [jobs[i:i + 8] for i in range(0, len(jobs), 8)]:
            for j, r in zip(b, judge_batch(b)): j["j"] = r
        s = summarize(jobs)
    else:
        recs = [json.loads(l) for l in open(a.records)]
        jobs, s = run(sb, recs, a.track, a.n, a.mode, a.model, seed=a.seed)
    print(json.dumps(s, indent=1))
    if a.out: json.dump({"summary": s, "jobs": jobs, "args": vars(a)}, open(a.out, "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
