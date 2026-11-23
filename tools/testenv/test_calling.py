"""Calling setup + owners-talked stamp on the TEST project. No call is placed.
1. dials.called_today_date is stamped by trigger when the outcome means an owner was reached (weekly survey "Owners talked to").
2. telnyx-token and deepgram-token answer 200 for a signed-in intern (TEST holds the copied phone secrets + one caller number)."""
import json, uuid, urllib.request, urllib.error, datetime
import sb
from test_sequences import q, uid, lit, login, api, URL, ANON, CALEB

results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))

def fn(name, body):
    r = urllib.request.Request(URL + "/functions/v1/" + name, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + login(CALEB), "apikey": ANON, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=60) as f: return f.status, json.loads(f.read().decode())
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}

def run():
    lid = str(uuid.uuid4())
    q("delete from clients where source_dial_id in (select d.id from dials d join dial_lists l on l.id = d.list_id where l.name like 'TEST-CALLING %')")  # intro-call dials make a client: remove it with the list
    q(f"delete from dial_lists where name like 'TEST-CALLING %'")
    q(f"insert into dial_lists (id, name, dial_type, created_by) values ('{lid}', 'TEST-CALLING {lid[:6]}', 'seller', '{uid(CALEB)}')")
    ids = {}
    for st in ["no_response", "not_interested", "callback_interested", "busy_callback", "intro_call_scheduled", "unable_to_contact"]:
        ids[st] = q(f"insert into dials (list_id, created_by, company_name, full_name, company_phone) values ('{lid}', '{uid(CALEB)}', 'Co {st}', 'Pat', '(801) 555-0100') returning id")[0]["id"]
    today = q("select (now() at time zone coalesce((select nullif(timezone,'') from profiles where id='%s'),'America/Denver'))::date d" % uid(CALEB))[0]["d"]
    for st, did in ids.items():
        c, _ = api(CALEB, "PATCH", f"/dials?id=eq.{did}", {"contact_status": st})
        d = q(f"select called_today_date d from dials where id='{did}'")[0]["d"]
        talked = st in ("not_interested", "callback_interested", "busy_callback", "intro_call_scheduled")
        check(f"{st}: called_today_date {'stamped' if talked else 'left empty'}", c in (200, 204) and ((d == today) if talked else d is None), (c, d, today))
    # re-saving the same status on a later day does not re-stamp; a changed status does
    did = ids["not_interested"]
    q(f"update dials set called_today_date = '2026-01-01' where id='{did}'")
    api(CALEB, "PATCH", f"/dials?id=eq.{did}", {"contact_status": "not_interested", "company_name": "Renamed"})
    check("same status re-saved: date untouched", q(f"select called_today_date d from dials where id='{did}'")[0]["d"] == "2026-01-01")
    api(CALEB, "PATCH", f"/dials?id=eq.{did}", {"contact_status": "busy_callback"})
    check("status changed to another talked outcome: re-stamped", q(f"select called_today_date d from dials where id='{did}'")[0]["d"] == today)
    # the weekly survey's own query (profile.js) now counts them
    c, rows = api(CALEB, "GET", f"/dials?select=id&created_by=eq.{uid(CALEB)}&list_id=eq.{lid}&contact_status=in.(not_interested,callback_interested,busy_callback,intro_call_scheduled)&called_today_date=gte.{today}&called_today_date=lte.{today}")
    check("survey query: 'Owners talked to' = 4", c == 200 and len(rows) == 4, (c, rows))
    q("delete from clients where source_dial_id in (select d.id from dials d join dial_lists l on l.id = d.list_id where l.name like 'TEST-CALLING %')")  # intro-call dials make a client: remove it with the list
    q("delete from dial_lists where name like 'TEST-CALLING %'")

    # CALL LOCK: a non-allowlisted number is refused before any Telnyx call; the test number gets a token
    c, r = fn("telnyx-token", {"to_number": "+18015550123", "owner_state": "UT"})
    check("call lock: telnyx-token refuses a non-test number", c == 403 and r.get("code") == "test_call_blocked" and not r.get("login_token") and "limited to the test number" in r.get("error", ""), (c, r))
    c, r = fn("telnyx-token", {"to_number": "+15024196436", "owner_state": "KY"})
    check("call lock: telnyx-token 200 with a login token for the test number", c == 200 and r.get("login_token") and r.get("from_number"), (c, {k: v for k, v in r.items() if k != "login_token"}))
    c, r = api(CALEB, "POST", "/calls", {"user_id": uid(CALEB), "mode": "native", "to_number": "(801) 555-0123"})
    check("call lock: client cannot create a call row for a non-test number", c >= 400 and "test number" in json.dumps(r), (c, r))
    c, r = api(CALEB, "POST", "/calls?select=id", {"user_id": uid(CALEB), "mode": "native", "to_number": "502-419-6436"})
    check("call lock: client can create a call row for the test number", c in (200, 201), (c, r))
    q(f"delete from calls where to_number='502-419-6436'")
    c, r = api(CALEB, "POST", "/rpc/test_call_policy", {})
    check("call lock: policy no longer hands the allowlisted number to an intern (round 6)", c == 200 and r == {"free": False, "allow": []} and "5024196436" not in json.dumps(r), (c, r))
    c, r = api(CALEB, "POST", "/rpc/test_call_allowed", {"p_number": "(502) 419-6436"})
    check("call lock: test_call_allowed says yes for the test number", c == 200 and r is True, (c, r))
    c, r = api(CALEB, "POST", "/rpc/test_call_allowed", {"p_number": "(801) 555-0123"})
    check("call lock: test_call_allowed says no for any other number", c == 200 and r is False, (c, r))
    cid = q(f"insert into calls (user_id, mode, started_at, to_number, owner_state, transcribed) values ('{uid(CALEB)}', 'in_app', now(), '+15024196436', 'UT', true) returning id")[0]["id"]
    c, r = fn("deepgram-token", {"call_id": cid})
    check("deepgram-token 200 with a token", c == 200 and r.get("token"), (c, r.get("error")))
    q(f"delete from calls where id='{cid}'")

if __name__ == "__main__":
    run(); print(f"\n{sum(results)}/{len(results)} passed")
