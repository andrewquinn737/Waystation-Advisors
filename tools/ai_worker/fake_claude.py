#!/usr/bin/env python3
"""Stand-in for the `claude` CLI (set CLAUDE_BIN to this file). Reads the prompt on stdin, emits stream-json like the real
CLI. Behaviour is chosen by keywords in the prompt: AUTHFAIL, RATELIMIT, SAVE, RESUMEFAIL, CRASH, SLOW. Appends one JSON line
per call to $FAKE_CLAUDE_LOG with argv, the env keys it saw and the prompt, so tests can assert on how it was started."""
import json, os, sys, time, uuid
argv = sys.argv[1:]
prompt = sys.stdin.read()
log = os.environ.get("FAKE_CLAUDE_LOG")
if log:
    with open(log, "a") as f:
        f.write(json.dumps({"argv": argv, "env": sorted(os.environ), "prompt": prompt, "token": os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")}) + "\n")
sid = argv[argv.index("--resume") + 1] if "--resume" in argv else str(uuid.uuid4())
def out(o): print(json.dumps({**o, "session_id": sid}), flush=True)
out({"type": "system", "subtype": "init", "tools": [], "model": "fake"})
if "RESUMEFAIL" in prompt and "--resume" in argv:
    out({"type": "result", "subtype": "error_during_execution", "is_error": True, "result": f"No conversation found with session ID: {sid}"}); sys.exit(1)
if "AUTHFAIL" in prompt or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") == "bad":
    out({"type": "assistant", "message": {"id": "m0", "content": [{"type": "text", "text": "Failed to authenticate. API Error: 401 Invalid bearer token"}]},
         "error": "authentication_failed", "is_api_error_message": True})
    out({"type": "result", "subtype": "success", "is_error": True, "result": "Failed to authenticate. API Error: 401 Invalid bearer token", "terminal_reason": "api_error"}); sys.exit(1)
if "RATELIMIT" in prompt:
    out({"type": "assistant", "message": {"id": "m0", "content": [{"type": "text", "text": "You've hit your limit"}]}, "error": "rate_limit", "is_api_error_message": True})
    out({"type": "result", "subtype": "success", "is_error": True, "result": "You've hit your limit · resets 3pm", "terminal_reason": "api_error"}); sys.exit(1)
if "CRASH" in prompt:
    print("Segmentation fault (fake)", file=sys.stderr); sys.exit(2)
def delta(t): out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": t}}})
out({"type": "stream_event", "event": {"type": "message_start", "message": {"id": "m1", "role": "assistant", "content": []}}})
words = ("Looking at the drafts. " if "SAVE" in prompt else "Sure. Here is a short answer: " + prompt.strip()[:60] + ". ").split(" ")
for w in words:
    delta(w + " "); time.sleep(0.25 if "SLOW" in prompt else 0.05)
if "SAVE" in prompt:
    out({"type": "assistant", "message": {"id": "m1", "content": [{"type": "text", "text": "Looking at the drafts. "},
         {"type": "tool_use", "id": "tu1", "name": "mcp__crm__save_rewrite", "input": {"dial_id": "x"}}]}})
    out({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu1", "content": [{"type": "text", "text": "{\n  \"saved\": true,\n  \"copy_ok\": true\n}"}]}]}})
    out({"type": "stream_event", "event": {"type": "message_start", "message": {"id": "m2", "role": "assistant", "content": []}}})
    delta("Shortened 1 email: it now passes.")
    final = "Looking at the drafts.\n\nShortened 1 email: it now passes."
else:
    final = " ".join(words).strip()
out({"type": "assistant", "message": {"id": "m2", "content": [{"type": "text", "text": final}]}})
out({"type": "result", "subtype": "success", "is_error": False, "result": final, "total_cost_usd": 0.0, "terminal_reason": "completed"})
