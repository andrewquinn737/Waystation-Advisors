"""Job handlers for the coach worker. Each takes (sb, job, cfg) and returns a result dict; raising fails the attempt.
LLM output is only proposed; code checks quotes verbatim, clamps scores and writes the rows."""
from datetime import datetime, timezone
import coachlib as cl
import prompts as P

OBJ_TYPES = {"not_interested", "busy", "what_is_this", "who_are_you", "scam_or_trust", "price_or_value", "confidentiality",
             "send_email", "not_decision_maker", "not_selling", "timing", "already_have", "wrong_fit", "other"}
REACTIONS = {"hostile", "brush_off", "busy", "question", "curious", "engaged", "neutral", "na"}


def now(): return datetime.now(timezone.utc).isoformat()


def score(v):
    try:
        f = float(v)
        if f > 10: f = f / 10 if f <= 100 else 10     # model answered out of 100
        return max(0, min(10, int(round(f))))
    except (TypeError, ValueError): return None


def clean_analysis(a, transcript):
    """Verbatim gate on every quote; unknown labels collapse to safe values."""
    a = dict(a or {})
    for k in ("opener_quote", "first_reaction_quote"):
        if a.get(k) and not cl.quote_in(a[k], transcript): a[k] = ""
    a["first_reaction"] = a.get("first_reaction") if a.get("first_reaction") in REACTIONS else "neutral"
    objs = []
    for o in a.get("objections") or []:
        if not isinstance(o, dict): continue
        pq, rq = o.get("prospect_quote") or "", o.get("caller_response_quote") or ""
        if pq and not cl.quote_in(pq, transcript): continue          # an objection we can't find in the call didn't happen
        if rq and not cl.quote_in(rq, transcript): rq = ""
        objs.append({"type": o.get("type") if o.get("type") in OBJ_TYPES else "other", "prospect_quote": pq,
                     "caller_response_quote": rq, "handled": bool(o.get("handled"))})
    a["objections"] = objs
    for k in ("keeps", "fixes"):
        a[k] = [cl.no_dashes(str(x)) for x in (a.get(k) or []) if x][:2]
    a["try_line"] = cl.no_dashes(a.get("try_line") or "")
    ps = a.get("persona") if isinstance(a.get("persona"), dict) else {}
    ps["signature_phrases"] = [x for x in (ps.get("signature_phrases") or []) if isinstance(x, str) and cl.quote_in(x, transcript)][:6]
    a["persona"] = ps
    return a


# ------------------------------------------------------------------------------------------------- real call feedback
def call_feedback(sb, job, cfg):
    cid = job["call_id"]
    if sb.select("ai_call_feedback", f"call_id=eq.{cid}&select=call_id"): return {"skipped": "already has feedback"}
    call = (sb.select("calls", f"id=eq.{cid}&select=id,user_id,list_id,company_name,owner_name,duration_sec") or [None])[0]
    if not call: return {"skipped": "call gone"}
    lines = sb.select("call_lines", f"call_id=eq.{cid}&select=speaker,text,start_ms&order=start_ms.asc")
    if sum(l["speaker"] == "owner" for l in lines) < 3 or sum(l["speaker"] == "intern" for l in lines) < 3:
        return {"skipped": "not a conversation"}
    track = job.get("track") or "data"
    tx = P.call_lines_text(lines)
    user = (f"Track: {track}. Company: {call.get('company_name') or '?'}. Call length: {call.get('duration_sec') or '?'}s.\n\n"
            f"Transcript:\n{tx}\n\nReply with the JSON object only.")
    a = cl.parse_json(cl.run_claude(user, P.feedback_system(sb, track), model=cfg["model_feedback"], timeout=cfg["timeout"]))
    if not isinstance(a, dict): raise RuntimeError("feedback reply was not JSON")
    a = clean_analysis(a, tx)
    ob = score(a.get("objection_score")) if a["objections"] else None
    op = score(a.get("opener_score")) if a.get("reached") in (None, "decision_maker") else None
    sb.insert("ai_call_feedback", [{"call_id": cid, "user_id": call["user_id"], "track": track, "opener_score": op,
              "objection_score": ob, "overall_score": score(a.get("overall_score")), "feedback": P.feedback_text(a),
              "analysis": a}], upsert_on="call_id")
    sb.rpc("_ai_coach_recompute", {"p_user": call["user_id"], "p_track": track})
    return {"opener": op, "objection": ob}


# ------------------------------------------------------------------------------------------------- practice: prospect turn
def practice_turn(sb, job, cfg):
    ses = (sb.select("ai_practice_sessions", f"id=eq.{job['session_id']}&select=*") or [None])[0]
    if not ses or ses["status"] != "active": return {"skipped": "session not active"}
    turns = ses["turns"]
    raw = cl.run_claude(P.prospect_user(turns), P.prospect_system(sb, ses), model=cfg["model_prospect"], timeout=90)
    r = cl.parse_json(raw)
    if not isinstance(r, dict) or not str(r.get("say") or "").strip():
        r = {"say": (raw or "").strip().strip('"')[:400] or "Sorry, who is this?", "hang_up": False}
    t = {"role": "prospect", "text": cl.no_dashes(str(r["say"]).strip())[:600], "at": now()}
    already = any(x.get("opener_ok") is not None for x in turns)
    if r.get("opener_ok") in (True, False) and not already: t["opener_ok"] = r["opener_ok"]
    if r.get("objection") in OBJ_TYPES: t["objection"] = r["objection"]
    if r.get("agreed_next_step"): t["agreed_next_step"] = True
    hung = bool(r.get("hang_up"))
    if hung: t["hang_up"] = True
    upd = {"turns": turns + [t]}
    if hung: upd.update(hung_up=True, status="scoring", ended_at=now())
    sb.update("ai_practice_sessions", {"id": ses["id"], "status": "active"}, upd)
    if hung:
        sb.insert("ai_coach_jobs", [{"kind": "practice_score", "user_id": ses["user_id"], "session_id": ses["id"],
                                     "track": ses["track"], "priority": 2}])
    return {"said": t["text"][:80], "hang_up": hung}


# ------------------------------------------------------------------------------------------------- practice: score
def practice_score(sb, job, cfg):
    ses = (sb.select("ai_practice_sessions", f"id=eq.{job['session_id']}&select=*") or [None])[0]
    if not ses or ses["status"] == "done": return {"skipped": "already scored"}
    turns = [t for t in ses["turns"] if str(t.get("text") or "").strip()]
    if sum(t["role"] == "intern" for t in turns) == 0:
        res = {"opener_pass": False, "overall_score": 0, "feedback": "You ended the call before saying anything."}
        sb.rpc("_ai_practice_scored", {"p_session": ses["id"], "p_result": res}); return res
    tx = P.transcript_text(turns, me="Intern", them="Prospect")
    user = f"Stage practiced: {ses['stage']}.\n\nTranscript:\n{tx}\n\nReply with the JSON object only."
    r = cl.parse_json(cl.run_claude(user, P.score_system(sb, ses["track"]), model=cfg["model_feedback"], timeout=cfg["timeout"]))
    if not isinstance(r, dict): raise RuntimeError("score reply was not JSON")
    verdict = next((t["opener_ok"] for t in turns if t.get("opener_ok") is not None), None)
    res = {"opener_pass": bool(r.get("opener_pass")) and verdict is not False,      # the prospect brushing off is final
           "opener_score": score(r.get("opener_score")),
           "objections_pass": None if r.get("objections_pass") is None else bool(r["objections_pass"]),
           "objection_score": score(r.get("objection_score")), "overall_score": score(r.get("overall_score")),
           "agreed_next_step": any(t.get("agreed_next_step") for t in turns),
           "feedback": cl.no_dashes(str(r.get("feedback") or "")),
           "best_line": r.get("best_line") if r.get("best_line") and cl.quote_in(r["best_line"], tx) else "",
           "fix_line": r.get("fix_line") if r.get("fix_line") and cl.quote_in(r["fix_line"], tx) else ""}
    if ses["stage"] == "opener": res["objections_pass"] = None
    if not res["opener_pass"] and res["opener_score"] is not None:   # a failed opener can't score as a good one
        res["opener_score"] = min(res["opener_score"], 6)
        if ses["stage"] == "opener" and res["overall_score"] is not None: res["overall_score"] = min(res["overall_score"], 6)
    sb.rpc("_ai_practice_scored", {"p_session": ses["id"], "p_result": res})
    return res


# ------------------------------------------------------------------------------------------------- coach plan refresh
def coach_update(sb, job, cfg):
    u, track = job["user_id"], job["track"]
    fb = sb.select("ai_call_feedback", f"user_id=eq.{u}&track=eq.{track}&select=opener_score,objection_score,overall_score,"
                   "feedback,analysis,created_at&order=created_at.desc&limit=20")
    if not fb: return {"skipped": "no calls yet"}
    def avg(rows, k):
        v = [r[k] for r in rows if r.get(k) is not None]
        return round(sum(v) / len(v), 1) if v else None
    last, prev = fb[:10], fb[10:20]
    stats = {k: {"last10": avg(last, k), "prev10": avg(prev, k)} for k in ("opener_score", "objection_score", "overall_score")}
    pr = sb.select("ai_practice_sessions", f"user_id=eq.{u}&track=eq.{track}&status=eq.done&select=stage,result&order=created_at.desc&limit=10")
    body = [f"Stats: {P.dumps(stats)}", f"Recent practice: {P.dumps([{'stage': p['stage'], **(p.get('result') or {})} for p in pr])[:3000]}",
            "Their last 10 calls (newest first):"]
    for i, r in enumerate(last, 1):
        a = r.get("analysis") or {}
        body.append(f"{i}. opener {r.get('opener_score')}, objections {r.get('objection_score')}. Opening: \"{a.get('opener_quote', '')[:300]}\". "
                    f"First reaction: {a.get('first_reaction')} \"{a.get('first_reaction_quote', '')[:150]}\". "
                    f"Objections: {P.dumps(a.get('objections') or [])[:700]}. Coach notes: {r['feedback'][:400]}")
    advice = cl.no_dashes(cl.run_claude("\n".join(body), P.coach_system(sb, track), model=cfg["model_feedback"], timeout=cfg["timeout"]).strip())
    st = (sb.select("ai_coach_state", f"user_id=eq.{u}&track=eq.{track}&select=conv_count") or [{"conv_count": len(fb)}])[0]
    sb.update("ai_coach_state", {"user_id": u, "track": track},
              {"advice": advice, "advice_at": now(), "convos_at_advice": st["conv_count"], "updated_at": now()})
    return {"words": len(advice.split())}


def weekly_retrain(sb, job, cfg):
    import retrain
    return retrain.run(sb, job.get("track") or "data", cfg)


HANDLERS = {"call_feedback": call_feedback, "practice_turn": practice_turn, "practice_score": practice_score,
            "coach_update": coach_update, "weekly_retrain": weekly_retrain}
