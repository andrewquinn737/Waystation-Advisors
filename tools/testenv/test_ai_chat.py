"""End-to-end tests for the in-app Claude chat on the TEST project: access rules, post -> job -> worker -> streamed reply,
resume, saved-changes flag, blocked_auth (amber status) and recovery, rate limit. The real worker.py runs as a subprocess
against the TEST database with a FAKE claude (tools/ai_worker/fake_claude.py), so no Claude usage is spent. Test lists are
named 'TEST-AI ...' and the test worker only claims those (LIST_NAME_LIKE), so it never touches the real VM worker's jobs.
Run: python3 test_ai_chat.py"""
import json, os, subprocess, sys, tempfile, time, uuid
import test_sequences as T
from test_sequences import q, lit, uid, rpc, api, check, CALEB, ADMIN, SEC, URL

WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ai_worker")
LOG = tempfile.mktemp(suffix=".fakeclaude.log")
WID = "e2e-test"
procs = []
TLEAD = "test.taylor.lead@example.com" if "test.taylor.lead@example.com" in SEC["accounts"] else "taylor.lead@example.com"

def start_worker(token="tok-e2e"):
    env = {**os.environ, "SUPABASE_URL": URL, "SUPABASE_SERVICE_ROLE_KEY": SEC["service_role"], "CONNECTOR_TOKEN": "e" * 64,
           "CLAUDE_CODE_OAUTH_TOKEN": token, "CLAUDE_BIN": os.path.join(WORKER, "fake_claude.py"), "WORKER_ID": WID, "WORK_DIR": tempfile.mkdtemp(),
           "HEARTBEAT_SECONDS": "2", "POLL_SECONDS": "0.5", "LIST_NAME_LIKE": "TEST-AI %", "FAKE_CLAUDE_LOG": LOG, "CLAUDE_FORWARD_ENV": "FAKE_CLAUDE_LOG",
           "REPROBE_SECONDS": "3600"}
    p = subprocess.Popen([sys.executable, os.path.join(WORKER, "worker.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    procs.append(p); return p
def stop_worker(p):
    if p.poll() is None: p.terminate()
    try: p.wait(timeout=15)
    except subprocess.TimeoutExpired: p.kill()
def wait(pred, timeout=30, every=0.3):
    t = time.time()
    while time.time() - t < timeout:
        v = pred()
        if v: return v
        time.sleep(every)
    return None
def calls(): return [json.loads(l) for l in open(LOG)] if os.path.exists(LOG) else []
def worker_row(): return (q(f"select * from ai_workers where id='{WID}'") or [None])[0]
def post(email, lid, text): return rpc(email, "post_ai_message", p_list_id=lid, p_text=text)
def msgs(tid): return q(f"select role, content, partial, meta from ai_messages where thread_id='{tid}' order by created_at, id")
def job(jid): return q(f"select * from ai_jobs where id='{jid}'")[0]
def status(email=ADMIN): return rpc(email, "ai_chat_status")[1]

# The real worker on the VM ('waystation-vnic') heartbeats to TEST, and ai_chat_status() prefers any online signed-in worker, so the
# global status can't show the test worker's own state. Assertions about THIS test worker read its own row (same 90 s rule).
def mine():
    return (q(f"select id, auth_ok, auth_error, (last_seen > now() - interval '90 seconds') as online from ai_workers where id='{WID}'") or [None])[0]
def others_signed_in():
    return int(q(f"select count(*) c from ai_workers where id<>'{WID}' and auth_ok and last_seen > now() - interval '90 seconds'")[0]["c"])

def cleanup():
    q("delete from ai_threads where list_id in (select id from dial_lists where name like 'TEST-AI %')")
    q("delete from dial_lists where name like 'TEST-AI %'")
    q(f"delete from ai_workers where id='{WID}'")

def run():
    cleanup()
    lid = str(uuid.uuid4())
    q(f"insert into dial_lists (id, name, dial_type, created_by, mandate) values ('{lid}', 'TEST-AI list', 'seller', '{uid(CALEB)}', 'data')")
    q("insert into app_secrets (key, value) values ('ai_chat_enabled', 'true') on conflict (key) do update set value='true'")
    try: _run(lid)
    finally:
        for p in procs: stop_worker(p)
        cleanup()
        q("insert into app_secrets (key, value) values ('ai_chat_enabled', 'true') on conflict (key) do update set value='true'")
    p = sum(1 for _, ok, _ in T.results if ok)
    print(f"\n{p}/{len(T.results)} passed"); raise SystemExit(0 if p == len(T.results) else 1)

def _run(lid):
    # ---------------------------------------------------------------- access rules
    c, r = post(CALEB, lid, "hi")
    check("intern cannot post (even to their own list)", c != 200 and "Admins only" in str(r), (c, r))
    c, r = post(TLEAD, lid, "hi")
    check("team lead cannot post", c != 200 and "Admins only" in str(r), (c, r))
    c, r = rpc(ADMIN, "post_ai_message", p_list_id=lid, p_text="   ")
    check("empty message rejected", c != 200 and "Type a message" in str(r), (c, r))
    c, r = rpc(ADMIN, "post_ai_message", p_list_id=lid, p_text="x" * 4001)
    check("over-long message rejected", c != 200 and "too long" in str(r), (c, r))
    c, r = post(ADMIN, str(uuid.uuid4()), "hi")
    check("unknown list rejected", c != 200 and "List not found" in str(r), (c, r))
    q("update app_secrets set value='false' where key='ai_chat_enabled'")
    c, r = post(ADMIN, lid, "hi")
    check("flag off: admin cannot post, status says disabled", c != 200 and "switched off" in str(r) and status()["enabled"] is False, (c, r))
    q("update app_secrets set value='true' where key='ai_chat_enabled'")
    check("flag on: status enabled for admin", status()["enabled"] is True)
    check("non-admin status reveals nothing", status(CALEB) == {"enabled": False}, status(CALEB))
    c, r = api(ADMIN, "POST", "/rpc/claim_ai_job", {})
    check("admin cannot call claim_ai_job (service role only)", c != 200, (c, r))
    c, r = api(CALEB, "POST", "/rpc/claim_ai_job", {})
    check("intern cannot call claim_ai_job", c != 200, (c, r))
    import urllib.request, urllib.error
    rq = urllib.request.Request(URL + "/rest/v1/rpc/post_ai_message", method="POST", data=json.dumps({"p_list_id": lid, "p_text": "x"}).encode(),
                                headers={"apikey": T.ANON, "Content-Type": "application/json"})
    try: urllib.request.urlopen(rq); anon_ok = True
    except urllib.error.HTTPError: anon_ok = False
    check("anon cannot post", not anon_ok)
    pub = q("select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='ai_messages'")
    check("ai_messages is in the realtime publication", bool(pub))

    # ---------------------------------------------------------------- happy path with the worker
    w = start_worker()
    check("worker heartbeats and reports signed in", wait(lambda: (worker_row() or {}).get("auth_ok") is True, 40), worker_row())
    check("status for admins: online + signed in", wait(lambda: (status().get("worker") or {}).get("auth_ok") and status()["worker"]["online"], 15), status())
    c, r = post(ADMIN, lid, "SLOW shorten the openers")
    check("admin posts: thread + message + job created", c == 200 and r and r["thread_id"] and r["job_id"], (c, r))
    tid, jid = r["thread_id"], r["job_id"]
    c2, r2 = post(ADMIN, lid, "second message while busy")
    check("second post while Claude is working is refused", c2 != 200 and "still working" in str(r2), (c2, r2))
    seen_partial = []
    def streaming():
        for m in msgs(tid):
            if m["role"] == "assistant" and m["partial"] and m["content"]: seen_partial.append(m["content"])
        return job(jid)["status"] == "done"
    check("job completes", wait(streaming, 60, 0.25), job(jid))
    ms = msgs(tid)
    check("user message stored, then one assistant reply, final (not partial)", [m["role"] for m in ms] == ["user", "assistant"] and not ms[1]["partial"], ms)
    check("reply text was visible while streaming (partial rows with content)", len(seen_partial) >= 1 and len(set(seen_partial)) >= 1, seen_partial[:2])
    check("reply contains the answer", "shorten the openers" in ms[1]["content"], ms[1])
    sess = q(f"select claude_session_id from ai_threads where id='{tid}'")[0]["claude_session_id"]
    check("session id saved on the thread", bool(sess))
    first = [c_ for c_ in calls() if "SLOW shorten" in c_["prompt"]][-1]
    check("claude saw the OAuth token only; no Supabase secrets in its environment", first["token"] == "tok-e2e" and not any(k.startswith("SUPABASE") or k == "CONNECTOR_TOKEN" for k in first["env"]), first["env"])
    check("non-admins cannot read the thread, messages or worker status",
          api(CALEB, "GET", f"/ai_messages?thread_id=eq.{tid}") == (200, []) and api(CALEB, "GET", "/ai_threads") == (200, []) and api(CALEB, "GET", "/ai_workers") == (200, []))
    c, rows = api(ADMIN, "GET", f"/ai_messages?thread_id=eq.{tid}&order=created_at")
    check("admins can read the messages", c == 200 and len(rows) == 2, (c, rows))
    c, _ = api(ADMIN, "POST", "/ai_messages", {"thread_id": tid, "role": "assistant", "content": "forged"})
    check("nobody can write messages directly", c != 201 and c != 200, c)
    c, _ = api(ADMIN, "GET", "/ai_jobs")
    check("jobs are not readable by clients", c != 200 or _ == [], (c, _))

    c, r = post(ADMIN, lid, "SAVE it please")
    check("second message accepted after the first finished", c == 200, (c, r))
    check("second job done", wait(lambda: job(r["job_id"])["status"] == "done", 40), job(r["job_id"]))
    last = msgs(tid)[-1]
    check("reply that saved changes carries meta.saved = 1", last["meta"].get("saved") == 1 and "passes" in last["content"], last)
    check("follow-up resumed the same session (--resume <id>)", any("SAVE it" in c_["prompt"] and c_["argv"][c_["argv"].index("--resume") + 1] == sess for c_ in calls() if "--resume" in c_["argv"]), calls()[-1]["argv"])

    c, _ = rpc(ADMIN, "ai_new_thread", p_list_id=lid)
    c3, r3 = post(ADMIN, lid, "fresh start")
    check("new chat: new thread, no resume", c == 200 and r3["thread_id"] != tid and wait(lambda: job(r3["job_id"])["status"] == "done", 40)
          and "--resume" not in [c_ for c_ in calls() if "fresh start" in c_["prompt"]][-1]["argv"])

    # ---------------------------------------------------------------- rate limit
    c, r = post(ADMIN, lid, "RATELIMIT now")
    j = wait(lambda: job(r["job_id"]) if job(r["job_id"])["status"] in ("waiting", "failed") else None, 40)
    check("rate limit: job waits with a future retry_after", j and j["status"] == "waiting" and j["retry_after"] and j["attempts"] == 1, j)
    q(f"update ai_jobs set status='failed', error='test cleanup' where id='{r['job_id']}'")

    # ---------------------------------------------------------------- blocked_auth (amber) and recovery
    stop_worker(w)
    w = start_worker(token="")
    check("no token: heartbeat says not signed in, with the reason", wait(lambda: (worker_row() or {}).get("auth_ok") is False and "empty" in ((worker_row() or {}).get("auth_error") or ""), 40), worker_row())
    if others_signed_in():   # a real worker is signed in, so the global status correctly shows IT; assert on our own worker's row
        st = mine()
        check("amber state for this worker id: online but not signed in", st and st["online"] and st["auth_ok"] is False and st["auth_error"], st)
        check("global status still shows the other (signed-in) worker as healthy", status()["worker"]["auth_ok"] is True, status())
    else:
        wait(lambda: not status()["worker"]["auth_ok"], 10)
        st = status()
        check("status for the UI: online but not signed in (amber)", st["worker"]["online"] and st["worker"]["auth_ok"] is False and st["worker"]["auth_error"], st)
    n_calls = len(calls())
    c, r = post(ADMIN, lid, "edit while signed out")
    check("message accepted while signed out", c == 200, (c, r))
    jb = wait(lambda: job(r["job_id"]) if job(r["job_id"])["status"] == "blocked_auth" else None, 30)
    check("job parked as blocked_auth, claude never started", jb is not None and len(calls()) == n_calls, (jb, len(calls()), n_calls))
    sysm = [m for m in msgs(r["thread_id"]) if m["role"] == "system"]
    check("the thread shows a plain-language system notice", sysm and "isn't signed in" in sysm[-1]["content"], msgs(r["thread_id"]))
    stop_worker(w)
    w = start_worker(token="tok-e2e")
    check("token set: worker signs in", wait(lambda: (worker_row() or {}).get("auth_ok") is True, 40), worker_row())
    check("the parked message now runs and is answered", wait(lambda: job(r["job_id"])["status"] == "done", 45), job(r["job_id"]))
    check("answer is final and follows the system notice", msgs(r["thread_id"])[-1]["role"] == "assistant" and not msgs(r["thread_id"])[-1]["partial"], msgs(r["thread_id"]))
    stop_worker(w)

    # ---------------------------------------------------------------- bad token (401 from the API)
    w = start_worker(token="bad")
    check("rejected token: worker reports not signed in", wait(lambda: (worker_row() or {}).get("auth_ok") is False and "isn't signed in" in ((worker_row() or {}).get("auth_error") or ""), 40), worker_row())
    stop_worker(w)
    # Silent worker -> "Offline". Only our own row is aged; the real VM worker is never touched.
    q(f"update ai_workers set last_seen = now() - interval '1 hour' where id='{WID}'")
    if others_signed_in():
        st = mine()
        check("no heartbeat for 90s: this worker id is offline", st is not None and st["online"] is False, st)
    else:
        st = status()
        check("no heartbeat for 90s: status says offline", st["worker"] is not None and st["worker"]["online"] is False, st)
    q(f"delete from ai_workers where id='{WID}'")

if __name__ == "__main__": run()
