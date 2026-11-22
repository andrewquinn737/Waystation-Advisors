"""Calling + transcripts stage on TEST (copied live data). No call is placed unless --live-call is given (max 2, to +15024196436 only).
  python3 test_call_stage.py --metrics   # before/after rates on the copied data
  python3 test_call_stage.py             # checks (outcome link trigger, summary fn, catch-up, constraints)
Test data is prefixed TEST-CALL and deleted afterwards."""
import json, sys, uuid, time, urllib.request, urllib.error
import sb
from test_sequences import q, uid, login, api, URL, ANON, CALEB

results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))

def metrics():
    m = q("""with c as (select *, (select count(*) from call_lines l where l.call_id=calls.id) n from calls where direction='outbound')
      select count(*) calls,
        round(100.0*count(*) filter (where mode='native')/count(*),1) native_pct,
        round(100.0*count(*) filter (where skip_reason='mic_denied')/count(*),1) mic_denied_pct,
        round(100.0*count(*) filter (where skip_reason in ('all_party_state','area_code_all_party'))/count(*),1) consent_skip_pct,
        count(*) filter (where n>0) calls_with_lines,
        count(*) filter (where n>0 and summary is null) lines_no_summary,
        round(100.0*count(*) filter (where n>0 and summary is null)/nullif(count(*) filter (where n>0),0),1) no_summary_pct,
        count(*) filter (where transcribed and n=0) flagged_transcribed_no_lines,
        count(*) filter (where call_outcome is not null) outcome_linked,
        round(100.0*count(*) filter (where call_outcome is not null)/count(*),1) outcome_linked_pct,
        count(*) filter (where call_notes is not null) notes_linked,
        count(*) filter (where ended_at is null) never_ended
      from c""")[0]
    return m

def run():
    # constraint accepts the new fall-back reasons
    cid = q(f"insert into calls (user_id, mode, started_at, to_number, skip_reason, company_name) values ('{uid(CALEB)}', 'native', now(), '+15024196436', 'mic_busy', 'TEST-CALL x') returning id")[0]["id"]
    check("skip_reason accepts mic_busy / not_connected / mic_missing", True)
    for r in ("not_connected", "mic_missing"):
        q(f"update calls set skip_reason='{r}' where id='{cid}'")
    q(f"delete from calls where id='{cid}'")

    # outcome link
    lid = str(uuid.uuid4())
    q("delete from dial_lists where name like 'TEST-CALL %'")
    q(f"insert into dial_lists (id, name, dial_type, created_by) values ('{lid}', 'TEST-CALL {lid[:6]}', 'seller', '{uid(CALEB)}')")
    did = q(f"insert into dials (list_id, created_by, company_name, full_name, company_phone) values ('{lid}', '{uid(CALEB)}', 'TEST-CALL Co', 'Pat', '(502) 419-6436') returning id")[0]["id"]
    old = q(f"insert into calls (user_id, mode, started_at, to_number, dial_id, list_id) values ('{uid(CALEB)}','in_app', now()-interval '2 days', '+15024196436', '{did}', '{lid}') returning id")[0]["id"]
    cid = q(f"insert into calls (user_id, mode, started_at, to_number, dial_id, list_id, answered, transcribed) values ('{uid(CALEB)}','in_app', now()-interval '3 minutes', '+15024196436', '{did}', '{lid}', true, true) returning id")[0]["id"]
    c, _ = api(CALEB, "PATCH", f"/dials?id=eq.{did}", {"call_notes": "Asked for a callback Tuesday"})
    r = q(f"select call_outcome, call_notes from calls where id='{cid}'")[0]
    check("notes typed during the call land on the call row", r["call_notes"] == "Asked for a callback Tuesday" and r["call_outcome"] is None, r)
    c, _ = api(CALEB, "PATCH", f"/dials?id=eq.{did}", {"contact_status": "busy_callback", "callback_at": "2026-12-01T15:00:00Z"})
    r = q(f"select call_outcome, contact_status_after, call_notes, callback_at from calls where id='{cid}'")[0]
    check("category -> call_outcome + contact_status_after + notes + callback_at on the latest call", r["call_outcome"] == "busy_callback" and r["contact_status_after"] == "busy_callback" and r["call_notes"] and r["callback_at"], r)
    check("older call (2 days) untouched", q(f"select call_outcome from calls where id='{old}'")[0]["call_outcome"] is None)
    api(CALEB, "PATCH", f"/dials?id=eq.{did}", {"contact_status": "not_interested"})
    check("changing the category re-links the same call", q(f"select call_outcome from calls where id='{cid}'")[0]["call_outcome"] == "not_interested")

    # summary: 2 lines -> deterministic note; 5 lines -> deepgram summary; 0 lines -> too_short
    for i, (sp, tx) in enumerate([("owner", "Hello this is Pat"), ("intern", "Hi Pat, calling for a client interested in your company")]):
        q(f"insert into call_lines (call_id, speaker, text, start_ms, end_ms) values ('{cid}','{sp}','{tx}',{i*1000},{i*1000+900})")
    q(f"update calls set ended_at=now() where id='{cid}'")
    c, r = fn("call-summary", {"call_id": cid})
    check("2-line call gets a summary (was skipped as too_short)", c == 200 and r.get("summary") and "Very short call" in r["summary"], (c, r))
    q(f"update calls set summary=null where id='{cid}'")
    for i, (sp, tx) in enumerate([("owner", "Acme, Pat speaking."), ("intern", "Hi Pat, I am calling on behalf of a client who is interested in acquiring companies like Acme."), ("owner", "Not really interested, we are not for sale."), ("intern", "Understood, thank you for your time."), ("owner", "Bye.")], 2):
        q(f"insert into call_lines (call_id, speaker, text, start_ms, end_ms) values ('{cid}','{sp}','{tx}',{i*1000},{i*1000+900})")
    c, r = fn("call-summary", {"call_id": cid})
    check("5-line call gets a model summary", c == 200 and r.get("summary") and "Very short call" not in r["summary"], (c, r))
    # catch-up job picks up a transcribed call with 1 line and no summary
    c2 = q(f"insert into calls (user_id, mode, started_at, ended_at, to_number, dial_id, answered, transcribed) values ('{uid(CALEB)}','in_app', now()-interval '2 days', now()-interval '2 days'+interval '9 sec', '+15024196436', '{did}', true, true) returning id")[0]["id"]
    q(f"insert into call_lines (call_id, speaker, text, start_ms, end_ms) values ('{c2}','owner','Hello?',0,500)")
    q("select public.call_summary_catchup()")
    for _ in range(12):
        time.sleep(3)
        s = q(f"select summary from calls where id='{c2}'")[0]["summary"]
        if s: break
    check("catch-up job summarizes a 1-line call 2 days old", bool(s), s)
    q(f"delete from callback_tasks where dial_id='{did}'"); q(f"delete from calls where dial_id='{did}'"); q("delete from dial_lists where name like 'TEST-CALL %'")

def fn(name, body):
    key = q("select value from app_secrets where key='CALL_SUMMARY_INTERNAL_KEY'")[0]["value"]
    r = urllib.request.Request(URL + "/functions/v1/" + name, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + ANON, "apikey": ANON, "x-internal-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=90) as f: return f.status, json.loads(f.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}

if __name__ == "__main__":
    if "--metrics" in sys.argv: print(json.dumps(metrics(), indent=1))
    else: run(); print(f"\n{sum(results)}/{len(results)} passed")
