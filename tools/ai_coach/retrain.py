"""Weekly retrain (cron 'ai-coach-weekly', Monday 09:00 UTC, one job per track).
1. Pull the last RECENT_DAYS of graded real calls (ai_call_feedback.analysis + lines + the dial's outcome).
2. Upsert a persona for every real conversation, then re-weight EVERY persona from its source facts (outcome, caller,
   date), so recency decay and the star-caller week boost move on their own. Keep the top MAX_ACTIVE per track.
3. Rewrite calls_playbook from the current version + this window's weighted stats and examples (the model edits,
   it does not start over), and keep the previous version as calls_playbook_prev.
4. Grow the turn bank from the new calls (refresh.py) and give new personas their real call path.
5. Log ai_training_runs. Also used by the first build (build_from_staging in the staging folder)."""
import json, os
from datetime import datetime, timedelta, timezone
import bank, coachlib as cl, paths, prompts as P, refresh

RECENT_DAYS = 21
MAX_ACTIVE = 300


def chunks(xs, n=150):
    for i in range(0, len(xs), n): yield xs[i:i + n]


def db_calls(sb, track, days=RECENT_DAYS):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")   # no "+" (breaks the query string)
    fb = sb.select("ai_call_feedback", f"track=eq.{track}&created_at=gte.{since}&select=call_id,analysis&limit=5000")
    if not fb: return []
    ids = [f["call_id"] for f in fb]
    calls, lines, dials, names = {}, {}, {}, {}
    for ch in chunks(ids):
        inn = "(" + ",".join(ch) + ")"
        for c in sb.select("calls", f"id=in.{inn}&select=id,user_id,dial_id,company_name,owner_name,industry,started_at,duration_sec"):
            calls[c["id"]] = c
        for l in sb.select("call_lines", f"call_id=in.{inn}&select=call_id,speaker,text,start_ms&order=start_ms.asc&limit=100000"):
            lines.setdefault(l["call_id"], []).append([l["speaker"], l["text"], l["start_ms"]])
    for ch in chunks(sorted({c["dial_id"] for c in calls.values() if c.get("dial_id")})):
        for d in sb.select("dials", f"id=in.({','.join(ch)})&select=id,contact_status"): dials[d["id"]] = d["contact_status"]
    for ch in chunks(sorted({c["user_id"] for c in calls.values() if c.get("user_id")})):
        for p in sb.select("profiles", f"id=in.({','.join(ch)})&select=id,full_name"): names[p["id"]] = p["full_name"]
    out = []
    for f in fb:
        c = calls.get(f["call_id"])
        if not c: continue
        row = {**c, "caller": names.get(c.get("user_id")), "outcome": dials.get(c.get("dial_id")), "lines": lines.get(c["id"], [])}
        out.append(bank.normalize(row, {**(f.get("analysis") or {}), "track": track}))
    return out


def reweight(sb, track, now):
    """Recompute every persona weight from the facts it carries; deactivate the long tail."""
    ps = sb.select("ai_personas", f"track=eq.{track}&select=id,persona,weight,active&limit=10000")
    scored = []
    for p in ps:
        src = (p.get("persona") or {}).get("src") or {}
        w = bank.weight({"outcome": src.get("outcome"), "caller": src.get("caller"), "started_at": src.get("started_at")}, now)
        scored.append((w, p))
    scored.sort(key=lambda x: -x[0])
    changed = 0
    for i, (w, p) in enumerate(scored):
        act = i < MAX_ACTIVE
        if abs(float(p["weight"]) - w) > 0.001 or p["active"] != act:
            sb.update("ai_personas", {"id": p["id"]}, {"weight": w, "active": act}); changed += 1
    return {"personas": len(ps), "reweighted": changed, "active": min(len(ps), MAX_ACTIVE)}


def write_playbook(sb, track, calls, cfg, now=None, current=None):
    """Model edits the playbook; numbers come from bank.stats so it cannot invent them."""
    st = bank.stats(calls, track, now)
    ex = "\n\n".join(bank.example_text(c) for c in bank.top_examples(calls, track, 14, now))
    cur = current if current is not None else P.doc(sb, track, "calls_playbook")
    sysp = P.render(P.doc(sb, "shared", "prompt_playbook"), track_context=P.doc(sb, track, "track_context"),
                    router=P.doc(sb, track, "router"))
    user = (f"CURRENT PLAYBOOK (edit this; empty means write the first version):\n{cur or '(none)'}\n\n"
            f"WEIGHTED STATS FOR THIS WINDOW:\n{json.dumps(st, indent=1)}\n\nHIGHEST-WEIGHT REAL CALLS:\n{ex}\n\n"
            "Reply with the full updated playbook in markdown only.")
    md = cl.run_claude(user, sysp, model=cfg.get("model_playbook") or "sonnet", timeout=600).strip()
    md = cl.no_dashes(md.removeprefix("```markdown").removeprefix("```").removesuffix("```").strip())
    if len(md.split()) < 250: raise RuntimeError("playbook reply too short, keeping the current one")
    return md, st


def save_doc(sb, track, slug, title, body, kind, weight=1):
    old = sb.select("ai_kb_docs", f"track=eq.{track}&slug=eq.{slug}&select=version")
    v = (old[0]["version"] + 1) if old else 1
    sb.insert("ai_kb_docs", [{"track": track, "slug": slug, "title": title, "body": body, "kind": kind, "weight": weight,
                              "version": v, "updated_at": datetime.now(timezone.utc).isoformat()}], upsert_on="track,slug")
    return v


def upsert_personas(sb, rows):
    for ch in chunks(rows, 100):
        sb.insert("ai_personas", ch, upsert_on="track,source_call_id")


def run(sb, track, cfg):
    now = datetime.now(timezone.utc)
    run_row = sb.insert("ai_training_runs", [{"track": track, "notes": "weekly retrain"}])[0]
    calls = db_calls(sb, track)
    try:
        labeled, bst = refresh.run(sb, track, calls, save_doc)
    except cl.ClaudeError as e:                      # the bank waits a week; personas and playbook still update
        labeled, bst = [], {"bank": f"skipped ({e})"}
    new_p = bank.persona_rows(calls, now)
    lab = {c["id"]: c for c in labeled}
    for r in new_p:
        c = lab.get(r["source_call_id"])
        if c: r["persona"].update(path=paths.call_path(c), path_call=c["id"][:8], outcome_tx=c.get("outcome_tx"))
    upsert_personas(sb, new_p)
    rw = reweight(sb, track, now)
    convos = sum(bank.is_conversation(c) for c in calls)
    stats = {"calls_graded": len(calls), "conversations": convos, "new_personas": len(new_p), **rw, **bst}
    if convos >= 8:                                  # too few new conversations: keep last week's playbook as is
        cur = P.doc(sb, track, "calls_playbook")
        md, st = write_playbook(sb, track, calls, cfg, now, cur)
        if cur: save_doc(sb, track, "calls_playbook_prev", "Calls playbook (previous week)", cur, "calls_playbook", 0)
        stats["playbook_version"] = save_doc(sb, track, "calls_playbook", "Calls playbook", md, "calls_playbook", 3)
        stats["window"] = {k: st[k] for k in ("conversations", "positive", "first_reaction_pct")}
    else:
        stats["playbook"] = "unchanged (fewer than 8 new conversations)"
    sb.update("ai_training_runs", {"id": run_row["id"]}, {"finished_at": datetime.now(timezone.utc).isoformat(), "stats": stats})
    return stats
