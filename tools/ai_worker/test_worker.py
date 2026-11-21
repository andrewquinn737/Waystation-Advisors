"""Unit tests for the worker: stream parser (recorded real + synthetic lines) and the job state machine (in-memory backend +
fake claude). No network. Run: python3 test_worker.py"""
import json, os, sys, tempfile, uuid
from datetime import timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import worker as W

HERE = os.path.dirname(os.path.abspath(__file__))
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))

def feed_file(p):
    st = W.StreamState()
    for l in open(p):
        if l.strip(): st.feed(json.loads(l))
    return st

# ---------------------------------------------------------------- parser
s = feed_file(f"{HERE}/samples/real_auth_invalid-test-token.jsonl")
check("parser: real 401 capture -> auth_failed, no fake reply text", s.auth_failed and s.text == "" and not s.ok, vars(s))
s = feed_file(f"{HERE}/samples/real_auth_EMPTY.jsonl")
check("parser: real 'Not logged in' capture -> auth_failed", s.auth_failed and s.text == "" and "Not logged in" not in s.text, vars(s))

def ev(o): return o
s = W.StreamState()
lines = [{"type": "system", "subtype": "init", "session_id": "S1"},
         {"type": "stream_event", "event": {"type": "message_start", "message": {"id": "a"}}},
         {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello "}}},
         {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "there."}}},
         {"type": "assistant", "message": {"id": "a", "content": [{"type": "text", "text": "Hello there."}, {"type": "tool_use", "id": "t1", "name": "mcp__crm__save_rewrite", "input": {}}]}},
         {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": '{"saved": true}'}]}]}},
         {"type": "assistant", "message": {"id": "b", "content": [{"type": "text", "text": "Done."}]}},   # no deltas for b: full text used
         {"type": "assistant", "message": {"id": "c", "content": [{"type": "tool_use", "id": "t2", "name": "mcp__crm__save_rewrite", "input": {}}]}},
         {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t2", "content": '{"saved": false, "rejected": true}'}]}},
         {"type": "result", "subtype": "success", "is_error": False, "result": "Done.", "session_id": "S1"}]
changes = [s.feed(l) for l in lines]
check("parser: deltas then non-delta turn joined by a blank line, no duplicate of streamed text", s.text == "Hello there.\n\nDone.", repr(s.text))
check("parser: text-change flags", changes[2] and changes[3] and not changes[0] and changes[6], changes)
check("parser: saved counts only successful saves (rejected one ignored)", s.saved == 1 and s.tool_calls == 2, (s.saved, s.tool_calls))
check("parser: session id + ok", s.session_id == "S1" and s.ok)
s = W.StreamState(); s.feed({"type": "result", "is_error": False, "result": "Only result text"})
check("parser: result text used when nothing streamed", s.text == "Only result text")
s = W.StreamState(); s.feed({"type": "result", "is_error": True, "result": "You've hit your limit · resets 3pm"})
check("parser: usage limit detected with reset time", s.limited and s.limit_until and s.limit_until.hour == 15 and not s.ok, vars(s))
s = W.StreamState(); s.feed({"type": "assistant", "message": {"id": "z", "content": [{"type": "text", "text": "Overloaded"}]}, "error": "rate_limit", "is_api_error_message": True})
check("parser: assistant rate_limit error is not shown as a reply", s.limited and s.text == "")
s = W.StreamState(); s.feed({"type": "result", "is_error": True, "result": "No conversation found with session ID: abc"})
check("parser: resume failure detected", s.resume_failed and not s.auth_failed)
s = W.StreamState(); s.feed({"type": "system", "subtype": "api_retry", "error": "overloaded", "error_status": 529})
check("parser: transient api_retry alone is not a limit", not s.limited and not s.auth_failed)

# ---------------------------------------------------------------- state machine with an in-memory backend
class Mem:
    def __init__(self): self.msgs, self.jobs, self.threads, self.hb = {}, {}, {}, []
    def add_message(self, thread, role, content, partial=False, meta=None):
        i = str(uuid.uuid4()); self.msgs[i] = dict(id=i, thread_id=thread, role=role, content=content, partial=partial, meta=meta or {}); return i
    def update_message(self, mid, **f): self.msgs[mid].update(f)
    def delete_message(self, mid): self.msgs.pop(mid, None)
    def update_job(self, jid, **f): self.jobs.setdefault(jid, {}).update(f)
    def update_thread(self, tid, **f): self.threads.setdefault(tid, {}).update(f)
    def heartbeat(self, *a): self.hb.append(a)
    def claim(self, *a): return None

LOG = tempfile.mktemp(suffix=".log")
def mk(token="tok-test", **extra):
    be = Mem()
    env = {"CLAUDE_BIN": f"{HERE}/fake_claude.py", "CLAUDE_CODE_OAUTH_TOKEN": token, "SUPABASE_URL": "https://x.supabase.co",
           "CONNECTOR_TOKEN": "c" * 64, "WORK_DIR": tempfile.mkdtemp(), "WORKER_ID": "t", "POLL_SECONDS": "0.1", "CLAUDE_FORWARD_ENV": "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_LOG": LOG, **extra}
    os.environ["FAKE_CLAUDE_LOG"] = LOG
    return W.Worker(be, env), be

def claim(prompt, session=None, attempts=1, history=None):
    tid, jid = str(uuid.uuid4()), str(uuid.uuid4())
    return {"job": {"id": jid, "prompt": prompt, "attempts": attempts}, "thread": {"id": tid, "created_by": "u", "claude_session_id": session},
            "list": {"id": "L1", "name": "Acme list", "mandate": "ma"}, "guidelines": {"body": "BE PLAIN", "version": "v1"},
            "history": history or [{"role": "user", "content": prompt}]}

def last_call(): return [json.loads(l) for l in open(LOG)][-1]
def only_msg(be): return list(be.msgs.values())[-1]

w, be = mk(); c = claim("shorten the openers please")
w.handle(c)
m = only_msg(be)
check("job ok: done, reply final (not partial), text from stream", be.jobs[c["job"]["id"]]["status"] == "done" and m["role"] == "assistant" and not m["partial"] and "shorten the openers" in m["content"], (be.jobs, m))
check("job ok: session id saved to thread", be.threads[c["thread"]["id"]].get("claude_session_id"))
call = last_call()
check("claude started with no built-in tools, only mcp__crm__*, strict mcp, dontAsk",
      call["argv"][call["argv"].index("--tools") + 1] == "" and "mcp__crm__*" in call["argv"] and "--strict-mcp-config" in call["argv"]
      and call["argv"][call["argv"].index("--permission-mode") + 1] == "dontAsk" and "--include-partial-messages" in call["argv"], call["argv"])
sp = call["argv"][call["argv"].index("--append-system-prompt") + 1]
check("system prompt has the rules, the list id and the guidelines", "Never launch" in sp and "check_draft before save_rewrite" in sp and "L1" in sp and "BE PLAIN" in sp)
check("prompt goes on stdin, not argv (lead text stays out of ps)", call["prompt"].strip() == "shorten the openers please" and "shorten the openers please" not in " ".join(call["argv"]))
check("claude env has the OAuth token and none of our Supabase secrets",
      call["token"] == "tok-test" and not any(k.startswith("SUPABASE") or k == "CONNECTOR_TOKEN" for k in call["env"]), call["env"])
mcp = json.load(open(os.path.join(w.work_dir, "mcp.json")))
check("mcp config points at the connector url, file is 0600", mcp["mcpServers"]["crm"]["url"].endswith("/functions/v1/claude-connector/mcp/" + "c" * 64)
      and oct(os.stat(os.path.join(w.work_dir, "mcp.json")).st_mode & 0o777) == "0o600")

w, be = mk(); c = claim("please SAVE it"); w.handle(c)
check("saved changes recorded in message meta", only_msg(be)["meta"] == {"saved": 1} and "passes" in only_msg(be)["content"], only_msg(be))

w, be = mk(); c = claim("what next", session="SESS-1"); w.handle(c)
check("resume: --resume <session> used", "--resume" in last_call()["argv"] and last_call()["argv"][last_call()["argv"].index("--resume") + 1] == "SESS-1")

w, be = mk(); c = claim("RESUMEFAIL now", session="OLD", history=[{"role": "user", "content": "first q"}, {"role": "assistant", "content": "first a"}, {"role": "user", "content": "RESUMEFAIL now"}]); w.handle(c)
calls = [json.loads(l) for l in open(LOG)][-2:]
check("resume failure: retried without --resume, history replayed", "--resume" in calls[0]["argv"] and "--resume" not in calls[1]["argv"]
      and "first q" in calls[1]["prompt"] and "first a" in calls[1]["prompt"] and calls[1]["prompt"].count("RESUMEFAIL now") == 1, calls[1]["prompt"])
check("resume failure: job still done, new session stored", be.jobs[c["job"]["id"]]["status"] == "done" and be.threads[c["thread"]["id"]].get("claude_session_id") != "OLD")

w, be = mk(); c = claim("AUTHFAIL"); w.handle(c)
check("auth failure: job blocked_auth, worker auth_ok false, message is a system notice", be.jobs[c["job"]["id"]]["status"] == "blocked_auth"
      and not w.auth_ok and "isn't signed in" in w.auth_error and only_msg(be)["role"] == "system" and not only_msg(be)["partial"]
      and "401" not in only_msg(be)["content"], (be.jobs, w.auth_error, be.msgs))

w, be = mk(token=""); c = claim("hello"); n = len(open(LOG).readlines()) if os.path.exists(LOG) else 0; w.handle(c)
check("empty token: blocked_auth without starting claude, clear error", be.jobs[c["job"]["id"]]["status"] == "blocked_auth" and not w.auth_ok
      and "CLAUDE_CODE_OAUTH_TOKEN is empty" in w.auth_error and len(open(LOG).readlines()) == n, w.auth_error)

w, be = mk(); c = claim("RATELIMIT please"); w.handle(c)
j = be.jobs[c["job"]["id"]]
check("rate limit: job waiting with a future retry_after, notice shown", j["status"] == "waiting" and j["retry_after"] > W.iso(W.now()) and only_msg(be)["role"] == "system"
      and "usage limit" in only_msg(be)["content"], (j, be.msgs))
check("rate limit: does not mark the login as broken", w.auth_error == "Checking the Claude token...")

w, be = mk(); c = claim("CRASH", attempts=1); w.handle(c)
check("crash attempt 1: back to waiting, empty reply row removed", be.jobs[c["job"]["id"]]["status"] == "waiting" and not be.msgs)
w, be = mk(); c = claim("CRASH", attempts=3); w.handle(c)
check("crash attempt 3: failed with a visible message", be.jobs[c["job"]["id"]]["status"] == "failed" and "Something went wrong" in only_msg(be)["content"], be.msgs)

w, be = mk(CLAUDE_BIN="/nonexistent/claude"); c = claim("hi", attempts=3); w.handle(c)
check("missing claude binary: failed with a clear message", be.jobs[c["job"]["id"]]["status"] == "failed" and "not installed" in only_msg(be)["content"], be.msgs)

# debounce: many tiny deltas -> far fewer message updates than deltas
w, be = mk(); upd = []; orig = be.update_message
be.update_message = lambda mid, **f: (upd.append(f), orig(mid, **f))[1]
c = claim("SLOW " + "x" * 30); w.handle(c)
check("streaming: partial row updated while running, debounced, final one is partial=false", 1 <= len(upd) <= 8 and upd[-1].get("partial") is False and any("content" in u and "partial" not in u for u in upd), (len(upd), upd[:2]))

# probe
w, be = mk(); w.probe(); check("probe with a good token -> auth ok", w.auth_ok and w.auth_error is None)
w, be = mk(token="bad"); w.probe(); check("probe with a rejected token -> auth not ok with clear error", not w.auth_ok and "isn't signed in" in w.auth_error, w.auth_error)
w, be = mk(token=""); w.probe(); check("probe with no token -> explains it", not w.auth_ok and "empty" in w.auth_error)

p = sum(results); print(f"\n{p}/{len(results)} passed"); sys.exit(0 if p == len(results) else 1)
