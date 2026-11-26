#!/usr/bin/env python3
"""Waystation AI Call Coach worker. Runs next to tools/ai_worker on the Oracle VM, on the same Claude subscription token.

Loop: claim_ai_coach_job (priority order: practice turns first, someone is waiting) -> handler -> finish_ai_coach_job.
Concurrency 3 by default. A usage limit or a signed-out token puts the job back and pauses claiming for a while.
Config (env): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_BIN, COACH_CONCURRENCY,
COACH_MODEL_PROSPECT (default sonnet), COACH_MODEL_FEEDBACK (default sonnet), COACH_WORK_DIR, WORKER_ID."""
import os, signal, socket, sys, threading, time, traceback
from concurrent.futures import ThreadPoolExecutor
import coachlib as cl
import handlers

VERSION = "1.0.0"


def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)


class CoachWorker:
    def __init__(self, sb, env=None):
        e = env if env is not None else os.environ
        self.sb = sb
        self.id = "coach-" + (e.get("WORKER_ID") or socket.gethostname())
        self.concurrency = int(e.get("COACH_CONCURRENCY") or 3)
        self.cfg = {"model_prospect": e.get("COACH_MODEL_PROSPECT") or "sonnet",
                    "model_feedback": e.get("COACH_MODEL_FEEDBACK") or "sonnet",
                    "model_bulk": e.get("COACH_MODEL_BULK") or "haiku",
                    "timeout": int(e.get("COACH_TIMEOUT") or 240)}
        self.pause_until = 0.0
        self.stopping = threading.Event()
        os.makedirs(e.get("COACH_WORK_DIR") or "/tmp/ai-coach", exist_ok=True)
        os.environ.setdefault("COACH_WORK_DIR", e.get("COACH_WORK_DIR") or "/tmp/ai-coach")

    def run_job(self, job):
        jid, kind = job["id"], job["kind"]
        t = time.time()
        try:
            res = handlers.HANDLERS[kind](self.sb, job, self.cfg)
            self.sb.rpc("finish_ai_coach_job", {"p_id": jid, "p_result": res})
            log(f"{kind} {jid[:8]} done in {time.time() - t:.1f}s {str(res)[:120]}")
        except cl.ClaudeError as e:
            if e.kind in ("auth", "limit"):
                self.pause_until = time.time() + (600 if e.kind == "auth" else 300)
                self.sb._req("PATCH", f"ai_coach_jobs?id=eq.{jid}", {"status": "queued", "attempts": max(0, job["attempts"] - 1),
                             "error": str(e)}, {"Prefer": "return=minimal"})
                log(f"{kind} {jid[:8]} paused: {e}")
            else:
                self.fail(job, e)
        except Exception as e:
            self.fail(job, e)

    def beat(self, ok):
        from datetime import datetime, timezone
        self.sb._req("POST", "ai_workers?on_conflict=id", {"id": self.id, "last_seen": datetime.now(timezone.utc).isoformat(),
                     "auth_ok": ok, "version": VERSION}, {"Prefer": "resolution=merge-duplicates,return=minimal"})

    def fail(self, job, e):
        log(f"{job['kind']} {job['id'][:8]} failed: {e!r}"); traceback.print_exc()
        try: self.sb.rpc("finish_ai_coach_job", {"p_id": job["id"], "p_error": str(e)[:500]})
        except Exception as e2: log("could not record failure:", e2)
        if job["kind"] == "practice_turn" and job["attempts"] >= 3:      # don't leave the intern staring at a dead call
            try:
                ses = self.sb.select("ai_practice_sessions", f"id=eq.{job['session_id']}&select=turns")
                if ses:
                    turns = ses[0]["turns"] + [{"role": "prospect", "text": "Sorry, you're breaking up. Call me back.", "hang_up": True}]
                    self.sb.update("ai_practice_sessions", {"id": job["session_id"]}, {"turns": turns, "hung_up": True})
            except Exception: pass

    def loop(self):
        log(f"{self.id} v{VERSION} starting, concurrency {self.concurrency}, models {self.cfg}")
        pool, active = ThreadPoolExecutor(self.concurrency), []
        last_beat = 0.0
        while not self.stopping.is_set():
            try:
                active[:] = [f for f in active if not f.done()]
                if time.time() < self.pause_until:
                    if time.time() - last_beat > 30: self.beat(False); last_beat = time.time()
                    self.stopping.wait(5); continue
                claimed = False
                while len(active) < self.concurrency:
                    job = self.sb.rpc("claim_ai_coach_job", {"p_worker": self.id})   # also heartbeats ai_workers
                    last_beat = time.time()
                    if not job: break
                    claimed = True
                    active.append(pool.submit(self.run_job, job))
                if not claimed and time.time() - last_beat > 30:      # all slots busy: heartbeat without claiming
                    self.beat(True); last_beat = time.time()
            except Exception as e:
                log("loop error:", e)
            self.stopping.wait(0.7)
        pool.shutdown(wait=True)


def main():
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not os.environ.get(k): sys.exit(f"missing environment variable {k}")
    w = CoachWorker(cl.Sb(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]))
    for s in (signal.SIGTERM, signal.SIGINT): signal.signal(s, lambda *_: w.stopping.set())
    w.loop()


if __name__ == "__main__":
    main()
