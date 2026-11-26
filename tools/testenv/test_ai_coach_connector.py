"""AI coach tools on the claude-connector (TEST project). Needs the coach worker running against TEST for the
practice steps (tools/ai_coach/worker.py); the read-only tools work without it.
Run: python3 test_ai_coach_connector.py   (leaves no data behind except one scored practice session and its token)"""
import time
from test_claude_connector import call, tool, mint
from test_sequences import CALEB, check

tok = mint(CALEB)
code, r = call(tok, "tools/list")
names = {t["name"] for t in r["result"]["tools"]}
for n in ("get_my_coaching", "get_call_feedback", "start_practice_call", "practice_say", "end_practice_call", "read_coach_doc"):
    check(f"tool listed: {n}", n in names)
code, r = call(tok, "prompts/list")
check("prompts include coach_me + practice_call", {"coach_me", "practice_call"} <= {p["name"] for p in r["result"]["prompts"]})

code, c, err = tool(tok, "get_my_coaching", track="data")
check("get_my_coaching returns stage", code == 200 and not err and isinstance(c, dict) and c.get("stage") in ("opener", "objections", "full"), c)
check("get_my_coaching has advice + counter", bool(c.get("coach_advice")) and "next_coach_update_in" in c, c)
code, f, err = tool(tok, "get_call_feedback", track="data")
check("get_call_feedback returns calls", code == 200 and not err and f, str(f)[:200])
code, g, err = tool(tok, "read_coach_doc", track="data", slug="guide")
check("read_coach_doc guide", code == 200 and not err and "How practice gets harder" in str(g), str(g)[:200])
code, g, err = tool(tok, "read_coach_doc", track="data", slug="../../etc")
check("read_coach_doc rejects junk slug", err or "not found" in str(g).lower() or not g, str(g)[:200])

code, s, err = tool(tok, "start_practice_call", track="data", stage="opener")
check("start_practice_call", code == 200 and not err and s.get("session_id") and s.get("owner_says"), s)
sid = s["session_id"]
code, a, err = tool(tok, "practice_say", session_id=sid, text="Hey, is this the owner? My name is Caleb, I have a bit of a weird request.")
if not err and isinstance(a, dict) and a.get("pending"):
    for _ in range(20):
        time.sleep(2); code, a, err = tool(tok, "get_practice_reply", session_id=sid)
        if not (isinstance(a, dict) and a.get("pending")): break
check("practice_say gets an owner reply", not err and isinstance(a, dict) and a.get("owner_says"), a)
code, e, err = tool(tok, "end_practice_call", session_id=sid)
for _ in range(30):
    if isinstance(e, dict) and e.get("result"): break
    time.sleep(3); code, e, err = tool(tok, "get_practice_reply", session_id=sid)
check("end_practice_call scores", isinstance(e, dict) and e.get("result") is not None, str(e)[:300])
print("done")
