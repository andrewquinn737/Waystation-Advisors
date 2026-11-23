"""Round 6 review regressions (TEST project). Part 1: database/security rules over REST as real roles (Caleb = intern on team A, Casey =
intern on team B, Taylor/Austin = team leads A/B). Part 2: browser (Chrome): Calls gear per role, keyboard search, edit-form Esc, stale tab,
CSV state code, Inbox Back, 44px, contrast, picker affordance, admin pages. Never calls, emails or touches the pilot users' data.
Run: python3 test_round6.py   (local server on WS_BASE, default http://localhost:5173/)"""
import json, re, sys, uuid
import sb
from test_sequences import q, uid, lit, api, login, URL, ANON
CALEB, CASEY, TAYLOR, AUSTIN = "test.caleb.hong@example.com", "casey.intern@example.com", "taylor.lead@example.com", "test.austin.price@example.com"
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:300]}"))
TAG = "R6TEST " + uuid.uuid4().hex[:6]
def rpc(who, fn, body): return api(who, "POST", "/rpc/" + fn, body)
def mk_client(owner, name, ctype="seller"):
    return q(f"insert into clients (client_type, full_name, created_by, assigned_to, intern_name) values ('{ctype}', {lit(TAG + ' ' + name)}, '{uid(owner)}', '{uid(owner)}', 'x') returning id")[0]["id"]
def mk_event(cid, owner, etype="meeting", paired=None):
    return q(f"insert into client_events (client_id, event_type, event_date, details, created_by) values ('{cid}', '{etype}', now() + interval '3 days', '{{\"time\":\"10:00\"}}'::jsonb, '{uid(owner)}') returning id")[0]["id"]

def database():
    print("-- database rules")
    cj, cc = mk_client(CALEB, "caleb"), mk_client(CASEY, "casey")
    ej, ec = mk_event(cj, CALEB), mk_event(cc, CASEY)
    # forged pair: Caleb points his event at Casey's
    c, r = api(CALEB, "PATCH", f"/client_events?id=eq.{ej}", {"paired_event_id": ec})
    check("forged paired_event_id: direct write refused", c >= 400 or not r, (c, r))
    q(f"update client_events set paired_event_id = '{ec}' where id = '{ej}'")   # as if it had got in some other way
    c, _ = rpc(CALEB, "set_client_event_confirmed", {"p_event_id": ej, "p_confirmed": True, "p_report": "forged"})
    check("forged pair: confirm does not touch the other team's event", not q(f"select confirmed from client_events where id='{ec}'")[0]["confirmed"], c)
    rpc(CALEB, "update_client_event", {"p_event_id": ej, "p_event_date": "2030-01-01T10:00:00Z", "p_time": "9:00", "p_report": "forged", "p_timezone": "America/Denver"})
    check("forged pair: update does not touch the other team's event", "forged" not in json.dumps(q(f"select details from client_events where id='{ec}'")[0]["details"]), "")
    rpc(CALEB, "delete_client_event", {"p_event_id": ej})
    check("forged pair: delete does not remove the other team's event", len(q(f"select 1 from client_events where id='{ec}'")) == 1, "")
    # a real pair still works end to end
    cj2 = mk_client(CALEB, "caleb2"); cj3 = mk_client(CALEB, "caleb3")
    c, r = rpc(CALEB, "log_shared_client_event", {"p_client_id": cj2, "p_counterpart_client_id": cj3, "p_event_type": "meeting", "p_event_date": "2030-02-01T10:00:00Z", "p_time": "10:00", "p_created_by": uid(CALEB), "p_category": None, "p_timezone": "America/Denver"})
    ev = q(f"select id, paired_event_id from client_events where event_type='meeting' and client_id in ('{cj2}','{cj3}')")
    check("a real shared event still pairs both halves", c in (200, 204) and len(ev) == 2 and all(e["paired_event_id"] for e in ev), (c, ev))
    if ev:
        rpc(CALEB, "set_client_event_confirmed", {"p_event_id": ev[0]["id"], "p_confirmed": True, "p_report": "ok"})
        check("a real pair confirms both halves", all(r["confirmed"] for r in q(f"select confirmed from client_events where event_type='meeting' and client_id in ('{cj2}','{cj3}')")), "")
        rpc(CALEB, "delete_client_event", {"p_event_id": ev[0]["id"]})
        check("a real pair deletes both halves", not q(f"select 1 from client_events where event_type='meeting' and client_id in ('{cj2}','{cj3}')"), "")
    c, r = api(CALEB, "PATCH", f"/client_events?id=eq.{ej}", {"buyer_id": cc})
    check("client_events.buyer_id cannot be written directly", c >= 400 or not r, (c, r))
    # reference columns
    c, r = api(CALEB, "PATCH", f"/clients?id=eq.{cj}", {"intended_buyer_id": cc})
    check("intended_buyer_id: another team's client refused", c >= 400, (c, r))
    c, r = api(CALEB, "PATCH", f"/clients?id=eq.{cj}", {"intended_buyer_id": cj2})
    check("intended_buyer_id: a client in scope still allowed", c in (200, 204), (c, r))
    lst = q("select id, created_by from dial_lists where created_by <> '%s' and created_by in (select id from profiles where team_id=(select team_id from profiles where id='%s')) and deleted_at is null limit 1" % (uid(CALEB), uid(CASEY))) or q(f"select id, created_by from dial_lists where created_by='{uid(CASEY)}' limit 1")
    other_list = q(f"select id from dial_lists where created_by='{uid(CASEY)}' limit 1")
    if other_list:
        c, r = api(CALEB, "POST", "/clients", {"client_type": "seller", "full_name": TAG + " squat", "created_by": uid(CALEB), "source_list_id": other_list[0]["id"]})
        check("source_list_id: another team's list refused", c >= 400, (c, r))
    other_dial = q(f"select id from dials where created_by='{uid(CASEY)}' limit 1")
    if other_dial:
        c, r = api(CALEB, "POST", "/clients", {"client_type": "seller", "full_name": TAG + " squat2", "created_by": uid(CALEB), "source_dial_id": other_dial[0]["id"]})
        check("source_dial_id: another team's dial refused", c >= 400, (c, r))
    # transfer stays on the team
    c, r = rpc(CASEY, "transfer_client_ownership", {"p_client_id": cc, "p_new_owner": uid(TAYLOR)})
    check("transfer: an intern cannot hand a client to another team's lead", c >= 400, (c, r))
    c, r = rpc(CASEY, "transfer_client_ownership", {"p_client_id": cc, "p_new_owner": uid(AUSTIN)})
    check("transfer: to a lead on the same team still works", c in (200, 204), (c, r))
    # test call policy
    c, r = rpc(CALEB, "test_call_policy", {})
    check("test_call_policy: no allowlisted number for an intern", c == 200 and "5024196436" not in json.dumps(r) and r.get("allow") == [], (c, r))
    c, r = rpc("test.admin@example.com", "test_call_policy", {})
    check("test_call_policy: the admin still sees the allow list", c == 200 and "+15024196436" in json.dumps(r), (c, r))
    c, r = rpc(CALEB, "test_call_policy_internal", {})
    check("test_call_policy_internal is not callable by users", c >= 400, (c, r))
    # real cap shown
    acct = q("select id from email_accounts limit 1")
    if acct:
        r = q(f"select * from mailbox_send_counts('{acct[0]['id']}')")
        check("mailbox_send_counts reports at most the real 20/day cap", r and r[0]["daily_limit"] <= 20, r)
    q(f"delete from clients where full_name like '{TAG}%'")

def admin_delete_keeps_tasks():
    print("-- account delete keeps sequence tasks (edge function)")
    import urllib.request, urllib.error
    ad = "test.admin@example.com"
    email = f"r6del.{uuid.uuid4().hex[:6]}@example.com"
    req = urllib.request.Request(URL + "/functions/v1/admin-create-account", method="POST", data=json.dumps({"email": email, "password": "R6-pass-" + uuid.uuid4().hex[:8], "full_name": TAG + " del", "role": "intern"}).encode(),
                                 headers={"Authorization": "Bearer " + login(ad), "apikey": ANON, "Content-Type": "application/json"})
    try: out = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e: out = {"error": e.read().decode()[:200]}
    nid = out.get("user_id") or out.get("id") or (out.get("user") or {}).get("id")
    if not nid:
        nid = (q(f"select id from profiles where full_name={lit(TAG + ' del')}") or [{}])[0].get("id")
    check("test account created", bool(nid), out)
    if not nid: return
    lid = q(f"insert into dial_lists (name, dial_type, created_by) values ({lit(TAG + ' L')}, 'seller', '{nid}') returning id")[0]["id"]
    did = q(f"insert into dials (list_id, created_by, company_name, full_name, company_phone) values ('{lid}', '{nid}', 'R6 Co', 'Pat', '(801) 555-0100') returning id")[0]["id"]
    tid = q(f"insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on, status) values ('{did}', '{lid}', '{nid}', 1, 1, 'call', current_date, 'pending') returning id")
    check("a task exists for the account", bool(tid), tid)
    req = urllib.request.Request(URL + "/functions/v1/admin-delete-account", method="POST", data=json.dumps({"user_id": nid}).encode(),
                                 headers={"Authorization": "Bearer " + login(ad), "apikey": ANON, "Content-Type": "application/json"})
    try: urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as e: check("delete call ok", False, e.read().decode()[:200])
    left = q(f"select owner_id from sequence_tasks where dial_id='{did}'")
    check("account deleted: its sequence tasks survive and belong to the admin", len(left) == 1 and left[0]["owner_id"] == uid(ad), left)
    q(f"delete from sequence_tasks where dial_id='{did}'"); q(f"delete from dials where list_id='{lid}'"); q(f"delete from dial_lists where id='{lid}'")

if __name__ == "__main__":
    which = sys.argv[1:] or ["db", "delete", "browser"]
    if "db" in which: database()
    if "delete" in which: admin_delete_keeps_tasks()
    if "browser" in which:
        from test_round6_ui import browser
        browser(check)
    ok = sum(results); print(f"\n{ok}/{len(results)} passed")
    sys.exit(0 if ok == len(results) else 1)
