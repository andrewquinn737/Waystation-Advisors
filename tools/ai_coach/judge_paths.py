#!/usr/bin/env python3
"""Judge the expert-system practice owner (engine.plan_reply -> path / bank / model) against real owners.
Same replay as judge.py: real caller lines up to an owner turn, compare the AI reply to the real one.
full  = the persona carries its real call path (production: a practice session on that owner's call)
blind = no path, quotes stripped, and the source call's own lines are excluded from the bank (tests that it
        generalizes to an owner it has never heard).
Usage: python3 judge_paths.py turns.jsonl --track data --n 60 --mode blind --seed 11 --out run.json"""
import argparse, json, os, random, re
from concurrent.futures import ThreadPoolExecutor
import bank, coachlib as cl, prompts as P, engine as E, paths, judge as J, realism as R


def convo(c):
    return c.get("dm", -1) >= 0 and c.get("track") in ("data", "ma") and sum(l[0] == "owner" for l in c["lines"]) >= 4


def replay(c):
    """(turns, test points). Each point: index into turns of an owner reply, and the path position of the caller line
    before it."""
    turns, labeled, pts = [], 0, []
    for i, (s, t, _) in enumerate(c["lines"]):
        if s not in ("intern", "owner"): continue
        role = "intern" if s == "intern" else "prospect"
        lb = (c["labels"][i] or {}) if c.get("labels") else {}
        if turns and turns[-1]["role"] == role: turns[-1]["text"] += " " + t
        else: turns.append({"role": role, "text": t, "line": i, "pos": labeled})
        if role == "intern" and i >= c["dm"] and lb.get("move"): labeled += 1
        if role == "prospect" and i > c["dm"] and len(turns) >= 2 and turns[-2]["role"] == "intern":
            if not pts or pts[-1][0] != len(turns) - 1: pts.append((len(turns) - 1, turns[-2]["pos"], lb.get("act")))
    if turns and turns[0]["role"] == "intern": turns.insert(0, {"role": "prospect", "text": "Hello?"}); pts = [(a + 1, b, x) for a, b, x in pts]
    return turns, pts


def pick(pts, k=4):
    if not pts: return []
    keyp = [p for p in pts[1:-1] if p[2] in ("objection", "brush_off", "guarded_question", "agree_next_step")]
    rest = [p for p in pts[1:-1] if p not in keyp]; random.shuffle(rest)
    out = [pts[0]] + keyp[:k - 2] + [pts[-1]] + rest
    seen, res = set(), []
    for p in out:
        if p[0] not in seen: seen.add(p[0]); res.append(p)
    return sorted(res[:k])


def reply(sb, ses, model):
    said = next((t["text"] for t in reversed(ses["turns"]) if t["role"] == "intern"), "")
    plan, real = E.plan_reply(sb, ses, said)
    if plan and plan.get("say"): return plan
    r = cl.parse_json(cl.run_claude(P.prospect_user(ses["turns"]), P.prospect_system(sb, ses, real), model=model, timeout=120))
    if not isinstance(r, dict): r = {"say": ""}
    r["source"], r["match"] = E.tag_source(r, plan) if plan else ("new", 0)
    r["move"] = (plan or {}).get("move")
    if (plan or {}).get("stay"): r["hang_up"] = False
    return r


def run(sb, calls, track, n, mode, model, workers=5, seed=11):
    random.seed(seed)
    pool = sorted([c for c in calls if c["track"] == track and convo(c)], key=lambda c: c["id"]); random.shuffle(pool)
    by = {}
    for c in pool: by.setdefault((c.get("ai") or {}).get("first_reaction"), []).append(c)
    sample = []
    while len(sample) < n and any(by.values()):
        for key in list(by):
            if by[key] and len(sample) < n: sample.append(by[key].pop())
    rules = P.doc(sb, "shared", "stage_rules_full")
    jobs = []
    for c in sample:
        p = dict(bank.persona_from_call(c), outcome_tx=c.get("outcome_tx"))
        if mode == "blind": p = dict(J.blind(p), exclude_call=c["id"][:8])
        else: p.update(path=R.annotate(paths.call_path(c), c.get("outcome_tx")), path_call=c["id"][:8])
        turns, pts = replay(c)
        last = max((i for i, t in enumerate(turns) if t["role"] == "prospect"), default=-1)
        for ti, pos, act in pick(pts):
            prefix = [dict(t) for t in turns[:ti]]
            for t in reversed(prefix):
                if t["role"] == "prospect": t["path_pos"] = pos; break
            jobs.append({"call": c["id"], "ses": {"persona": p, "track": track, "stage": "full", "rules": rules, "turns": prefix},
                         "prefix": prefix, "real": turns[ti]["text"][:400], "real_act": act, "real_last": ti == last,
                         "first": ti == pts[0][0], "real_end": ti == last and c.get("outcome_tx") in R.END_OUTCOMES})
    def go(j):
        try:
            r = reply(sb, j.pop("ses"), model)
            j.update(ai=cl.no_dashes(str(r.get("say") or ""))[:400], ai_hang=bool(r.get("hang_up")), source=r.get("source"),
                     move=r.get("move"), match=r.get("match"))
        except cl.ClaudeError as e: j.update(ai="", err=str(e))
        return j
    with ThreadPoolExecutor(workers) as ex: jobs = list(ex.map(go, jobs))
    jobs = [j for j in jobs if j.get("ai")]
    batches = [jobs[i:i + 8] for i in range(0, len(jobs), 8)]
    with ThreadPoolExecutor(workers) as ex:
        for b, res in zip(batches, ex.map(J.judge_batch, batches)):
            for j, r in zip(b, res): j["j"] = r
    s = J.summarize(jobs)
    jj = [j for j in jobs if j.get("j")]
    s["source_share"] = {k: round(sum(j["source"] == k for j in jj) / max(1, len(jj)), 3) for k in ("path", "bank", "new")}
    s["stance_by_source"] = {k: J.summarize([j for j in jj if j["source"] == k]).get("stance_match") for k in ("path", "bank", "new")}
    s["hang"] = hang_stats(jj)
    s["sim_by_source"] = {k: J.summarize([j for j in jj if j["source"] == k]).get("sim_avg") for k in ("path", "bank", "new")}
    return jobs, s


def hang_stats(jj):
    """Does the AI owner end the call where real owners did, and as often?"""
    tp = sum(j["ai_hang"] and j["real_end"] for j in jj); ai = sum(j["ai_hang"] for j in jj); re_ = sum(j["real_end"] for j in jj)
    return {"real_end_rate": round(re_ / max(1, len(jj)), 3), "ai_end_rate": round(ai / max(1, len(jj)), 3),
            "caught": f"{tp}/{re_}", "false_ends": ai - tp}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("turns"); ap.add_argument("--track", default="data"); ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--mode", default="blind"); ap.add_argument("--model", default="sonnet"); ap.add_argument("--out")
    ap.add_argument("--seed", type=int, default=11); ap.add_argument("--test", action="store_true"); ap.add_argument("--workers", type=int, default=5)
    a = ap.parse_args()
    import dev_sb
    os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = dev_sb.claude_token(); os.environ.pop("ANTHROPIC_API_KEY", None)
    sb = dev_sb.test_client() if a.test else None
    calls = [json.loads(l) for l in open(a.turns)]
    jobs, s = run(sb, calls, a.track, a.n, a.mode, a.model, workers=a.workers, seed=a.seed)
    print(json.dumps(s, indent=1))
    if a.out: json.dump({"summary": s, "jobs": jobs}, open(a.out, "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
