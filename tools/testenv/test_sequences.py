"""Scenario tests for the sequence engine on the TEST project.
Setup and the clock-driven dispatcher run as the database owner; everything a person does
(prepare, approve, complete, read tasks) goes through the real API with that person's login,
so access rules are exercised exactly like the app. Run: python3 test_sequences.py"""
import sb, json, os, urllib.request, urllib.error, uuid, datetime as dt, traceback

SEC = json.load(open(os.path.expanduser("~/Projects/First Project/.waystation_test_secrets.json")))
URL = f"https://{sb.TEST_REF}.supabase.co"
ANON = [k for k in sb.test_api("/api-keys") if k["name"] == "anon"][0]["api_key"]
SINKS = ["masonquinn10@gmail.com", "mason.alex.quinn@gmail.com", "mason@waystationadvisors.com"]
_tok = {}

def login(email):
    if email not in _tok:
        r = urllib.request.Request(URL + "/auth/v1/token?grant_type=password", method="POST",
            data=json.dumps({"email": email, "password": SEC["accounts"][email]["password"]}).encode(),
            headers={"apikey": ANON, "Content-Type": "application/json"})
        _tok[email] = json.load(urllib.request.urlopen(r))["access_token"]
    return _tok[email]

def api(email, method, path, body=None):
    r = urllib.request.Request(URL + "/rest/v1" + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"apikey": ANON, "Authorization": "Bearer " + login(email), "Content-Type": "application/json",
                 "Prefer": "return=representation"})
    try:
        with urllib.request.urlopen(r) as f:
            d = f.read(); return 200, (json.loads(d) if d else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def rpc(email, fn, **args): return api(email, "POST", "/rpc/" + fn, args)
def q(sql): return sb.test_sql(sql)
def uid(email): return SEC["accounts"][email]["id"]
def lit(v): return "null" if v is None else "'" + str(v).replace("'", "''") + "'"

CALEB, GAVIN, LEAD_A, LEAD_B, ADMIN = ("test.caleb.hong@example.com", "test.gavin.hopkinson@example.com",
    "test.andrew.quinn@example.com", "test.jonah.johnson@example.com", "test.admin@example.com")
results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))

def make_list(owner_email, rows, mandate="data", name=None):
    lid = str(uuid.uuid4())
    q(f"insert into dial_lists (id, name, dial_type, created_by, mandate) values ('{lid}', {lit(name or 'TEST-SEQ ' + lid[:8])}, 'seller', '{uid(owner_email)}', '{mandate}')")
    for r in rows:
        q(f"""insert into dials (list_id, created_by, company_name, full_name, email, company_phone, email_subject, email_1, email_2)
              values ('{lid}', '{uid(owner_email)}', {lit(r.get('co','Acme'))}, {lit(r.get('name','Pat Owner'))}, {lit(r.get('email'))},
                      {lit(r.get('phone','(801) 555-0100'))}, {lit(r.get('subj'))}, {lit(r.get('e1'))}, {lit(r.get('e2'))})""")
    return lid

COPY = dict(subj="Quick question about Acme", e1="Hi Pat,\n\nShort note.\n\nBest,\nCaleb", e2="Hi Pat, circling back.\n\nCaleb")

def cleanup():
    q("delete from dial_lists where name like 'TEST-SEQ %'")

def run():
    cleanup()
    # ---- 1. classification on prepare
    lid = make_list(CALEB, [
        dict(email=SINKS[0], **COPY), dict(email="info@acme.com", **COPY), dict(email=None),
        dict(email="not-an-email", **COPY), dict(email=SINKS[1], co="NoCopy Co"), dict(email="  ", **COPY),
        dict(email="Sales@Acme.com", **COPY), dict(email=SINKS[2], name="Zoë O'Brien-Núñez", co="Café \"Quotes\" & Co", **COPY)])
    code, res = rpc(CALEB, "seq_prepare_list", p_list_id=lid)
    check("prepare: owner can run it", code == 200, res)
    check("prepare: split email/call", res == {"email_sequence": 3, "call_sequence": 5, "missing_copy": 1}, res)
    st = q(f"select copy_status from dial_lists where id='{lid}'")[0]["copy_status"]
    check("prepare: list waits for copy review", st == "pending_review", st)
    calls = q(f"select count(*) n, min(t.due_on) d from sequence_tasks t join dials d on d.id=t.dial_id where t.list_id='{lid}' and d.sequence='call3'")[0]
    check("prepare: call track starts immediately (3 tasks x 5 leads)", calls["n"] == 15, calls)
    code, res = rpc(CALEB, "seq_prepare_list", p_list_id=lid)
    check("prepare: re-running is a no-op", res == {"email_sequence": 0, "call_sequence": 0, "missing_copy": 0}, res)
    code, res = rpc(GAVIN, "seq_prepare_list", p_list_id=lid)
    check("prepare: another intern is refused", code != 200, (code, res))

    # ---- 2. approval
    code, res = rpc(GAVIN, "approve_list_copy", p_list_id=lid)
    check("approve: another intern is refused", code != 200 and "approve" in str(res).lower(), (code, res))
    code, res = rpc(CALEB, "approve_list_copy", p_list_id=lid)
    check("approve: owner approves, 2 start, 1 missing copy", code == 200 and res["started"] == 2 and res["missing_copy"] == 1, res)
    rows = q(f"select d.full_name, d.seq_state, d.sender_account_id, a.owner_id, a.mandate from dials d left join email_accounts a on a.id=d.sender_account_id where d.list_id='{lid}' and d.sequence='email5'")
    check("approve: no mailbox pinned yet (picked at send time)", all(r["sender_account_id"] is None for r in rows), rows)
    check("approve: lead without copy stays awaiting_copy", any(r["seq_state"] == "awaiting_copy" for r in rows), rows)
    code, res = rpc(CALEB, "approve_list_copy", p_list_id=lid)
    check("approve: double-click is harmless", code == 200 and res["started"] == 0, res)
    n = q(f"select count(*) n from sequence_tasks where list_id='{lid}'")[0]["n"]
    check("approve: 15 call + 2x6 email-sequence tasks, no duplicates", n == 27, n)

    # ---- 3. dispatch window + caps (clock-driven)
    q(f"update dials set seq_day0 = '2026-11-23' where list_id='{lid}' and sequence='email5'")  # a Monday
    for d in q(f"select id from dials where list_id='{lid}' and sequence='email5' and seq_state='active'"):
        q(f"select seq_build_tasks('{d['id']}')")
    due = q(f"select t.kind, t.due_on from sequence_tasks t join dials d on d.id=t.dial_id where d.list_id='{lid}' and d.sequence='email5' and d.seq_state='active' order by d.id, step limit 6")
    check("dates: Mon start -> d3 Wed, d4 Thu, d5 Fri, d7 next Tue",
          [x["due_on"] for x in due] == ["2026-11-23", "2026-11-25", "2026-11-25", "2026-11-26", "2026-11-27", "2026-12-01"], due)
    n = q("select sequence_dispatch('2026-11-23 06:30-07') n")[0]["n"]
    check("dispatch: nothing before 8am Denver", n == 0, n)
    n = q("select sequence_dispatch('2026-11-22 12:00-07') n")[0]["n"]
    check("dispatch: nothing on Sunday", n == 0, n)
    n = q("select sequence_dispatch('2026-11-23 17:30-07') n")[0]["n"]
    check("dispatch: nothing after 5pm", n == 0, n)
    n1 = q("select sequence_dispatch('2026-11-23 09:00-07') n")[0]["n"]
    queued = q(f"select s.account_id, s.to_address, s.subject, s.in_reply_to from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id where t.list_id='{lid}'")
    check("dispatch: first emails queued in window", n1 >= 1 and len(queued) == n1, (n1, queued))
    check("dispatch: max one per mailbox per run", len({x["account_id"] for x in queued}) == len(queued), queued)
    own = q(f"""select a.owner_id, a.mandate from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id
                join email_accounts a on a.id=s.account_id where t.list_id='{lid}'""")
    check("dispatch: sends only from the owner's own data mailboxes", own and all(o["owner_id"] == uid(CALEB) and o["mandate"] == "data" for o in own), own)
    pinned = q(f"select count(*) n from dials where list_id='{lid}' and seq_state='active' and sender_account_id is not null")[0]["n"]
    check("dispatch: lead pinned to its mailbox once queued", pinned == n1, (pinned, n1))
    check("dispatch: follow-up not queued before email 1 is sent", all(x["in_reply_to"] is None for x in queued), queued)
    n2 = q("select sequence_dispatch('2026-11-23 09:05-07') n")[0]["n"]
    n3 = q("select sequence_dispatch('2026-11-23 09:10-07') n")[0]["n"]
    total = q(f"select count(*) n from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id where t.list_id='{lid}'")[0]["n"]
    check("dispatch: every first email queued exactly once (2 mailboxes -> both in the first run)", total == 2 and n2 == 0 and n3 == 0, (n1, n2, n3, total))

    # ---- 4. mailbox cap: fill one mailbox, its leads wait
    acct = q(f"select sender_account_id a from dials where list_id='{lid}' and seq_state='active' and sequence='email5' limit 1")[0]["a"]
    lim = q(f"select daily_send_limit l from email_accounts where id='{acct}'")[0]["l"]
    check("cap: Working Signal mailbox limit is 5/day", lim == 5, lim)

    # ---- 5. simulate the send of email 1 -> rebase + threaded follow-up
    s = q(f"""select s.id, s.account_id, s.to_address, s.dial_id from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id
              where t.list_id='{lid}' and t.kind='email' limit 1""")[0]
    mid = q(f"""insert into email_messages (account_id, message_id, direction, from_address, to_addresses, subject, body_text, sent_at, created_by)
               values ('{s['account_id']}', '<t1@x>', 'outbound', 'me@x', '[{{"address":"{s['to_address']}"}}]', 's', 'b', '2026-11-24 10:00-07', '{uid(CALEB)}')
               returning id""")[0]["id"]
    q(f"update scheduled_emails set status='sending' where id='{s['id']}'")
    q(f"update scheduled_emails set status='sent', sent_at='2026-11-24 10:00-07', sent_message_id='{mid}' where id='{s['id']}'")
    d = q(f"select seq_day0, email_1_message_id from dials where id='{s['dial_id']}'")[0]
    check("sent: day 1 re-based to the real send day (Tue)", d["seq_day0"] == "2026-11-24" and d["email_1_message_id"] == "<t1@x>", d)
    fu = q(f"select due_on, status from sequence_tasks where dial_id='{s['dial_id']}' and kind='followup_email'")[0]
    check("sent: follow-up moves to day 3 = Thu", fu["due_on"] == "2026-11-26" and fu["status"] == "pending", fu)
    q("select sequence_dispatch('2026-11-26 09:00-07')")
    fq0 = q(f"select count(*) n from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id where t.dial_id='{s['dial_id']}' and t.kind='followup_email'")[0]["n"]
    check("follow-up: held while the mailbox's inbox isn't being read", fq0 == 0, fq0)
    q(f"update email_accounts set sync_enabled=true, last_synced_at='2026-11-26 08:30-07', last_sync_error=null where id='{s['account_id']}'")
    q("select sequence_dispatch('2026-11-26 09:05-07')")
    q(f"update email_accounts set sync_enabled=false where id='{s['account_id']}'")
    fq = q(f"select s.in_reply_to, s.subject from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id where t.dial_id='{s['dial_id']}' and t.kind='followup_email'")
    check("follow-up: queued as a reply in the same thread", fq and fq[0]["in_reply_to"] == "<t1@x>" and fq[0]["subject"].startswith("Re: "), fq)

    # ---- 6. daily-limit failure returns the task to pending
    other = q(f"""select s.id from scheduled_emails s join sequence_tasks t on t.scheduled_email_id=s.id
                 where t.list_id='{lid}' and t.kind='email' and s.status='pending' limit 1""")
    if other:
        q(f"update scheduled_emails set status='sending' where id='{other[0]['id']}'")
        q(f"update scheduled_emails set status='failed', error='Daily limit reached: x' where id='{other[0]['id']}'")
        t = q(f"select status, scheduled_email_id from sequence_tasks where scheduled_email_id is null and last_error like 'Daily limit%' and list_id='{lid}'")
        check("cap failure: task goes back to pending for the next day", len(t) == 1 and t[0]["status"] == "pending", t)

    # ---- 7. reply from the owner stops emails, keeps calls, adds a reply task
    q(f"""insert into email_messages (account_id, message_id, direction, from_address, to_addresses, subject, body_text, created_by)
         values ('{s['account_id']}', '<r1@x>', 'inbound', upper('{s['to_address']}'), '[]', 'Re: s', 'sounds good', '{uid(CALEB)}')""")
    d = q(f"select seq_state from dials where id='{s['dial_id']}'")[0]["seq_state"]
    tk = {r["kind"]: r["status"] for r in q(f"select kind, status from sequence_tasks where dial_id='{s['dial_id']}'")}
    check("reply: sequence marked replied (case-insensitive match)", d == "replied", d)
    check("reply: follow-up email cancelled, calls kept, reply task added",
          tk.get("followup_email") == "cancelled" and tk.get("call") == "pending" and tk.get("reply") == "pending", tk)
    fs = q(f"select s.status from scheduled_emails s where s.in_reply_to='<t1@x>'")
    check("reply: the already-queued follow-up send is cancelled", all(x["status"] == "cancelled" for x in fs), fs)

    # ---- 8. bounce stops the other lead's emails
    other_d = q(f"select id, email, sender_account_id from dials where list_id='{lid}' and seq_state='active' and sequence='email5' limit 1")
    if other_d:
        o = other_d[0]
        q(f"""insert into email_messages (account_id, message_id, direction, from_address, to_addresses, subject, body_text, created_by)
             values ('{o['sender_account_id']}', '<b1@x>', 'inbound', 'MAILER-DAEMON@mx.example.com', '[]', 'Undeliverable: hi',
                     'Delivery to {o['email']} failed permanently.', '{uid(CALEB)}')""")
        d = q(f"select seq_state from dials where id='{o['id']}'")[0]["seq_state"]
        check("bounce: sequence marked bounced", d == "bounced", d)

    # ---- 9. intern actions on call tasks
    task = q(f"select id from sequence_tasks where list_id='{lid}' and kind='call' and status='pending' order by due_on limit 1")[0]["id"]
    code, res = rpc(GAVIN, "complete_sequence_task", p_task_id=task, p_outcome="no_answer")
    check("tasks: another intern can't complete it", code != 200, (code, res))
    code, res = rpc(LEAD_B, "complete_sequence_task", p_task_id=task, p_outcome="no_answer")
    check("tasks: a lead of a different team can't complete it", code != 200, (code, res))
    code, res = rpc(CALEB, "complete_sequence_task", p_task_id=task, p_outcome="no_answer", p_note="left vm")
    code2, _ = rpc(CALEB, "complete_sequence_task", p_task_id=task, p_outcome="other")
    t = q(f"select status, outcome, note from sequence_tasks where id='{task}'")[0]
    check("tasks: owner completes; second click doesn't overwrite", code == 200 and code2 == 200 and t == {"status": "done", "outcome": "no_answer", "note": "left vm"}, t)
    em = q(f"select id from sequence_tasks where list_id='{lid}' and kind in ('email','followup_email') limit 1")[0]["id"]
    code, res = rpc(CALEB, "complete_sequence_task", p_task_id=em)
    check("tasks: emails can't be marked done by hand", code != 200, (code, res))

    # ---- 10. call outcome ends the sequence
    cd = q(f"select id from dials where list_id='{lid}' and sequence='call3' and seq_state='active' limit 1")[0]["id"]
    api(CALEB, "PATCH", f"/dials?id=eq.{cd}", {"contact_status": "not_interested"})
    d = q(f"select seq_state from dials where id='{cd}'")[0]["seq_state"]
    pend = q(f"select count(*) n from sequence_tasks where dial_id='{cd}' and status='pending'")[0]["n"]
    check("outcome: not interested completes the sequence and clears tasks", d == "completed" and pend == 0, (d, pend))

    # ---- 11. visibility (RLS)
    code, mine = api(CALEB, "GET", f"/my_tasks?list_id=eq.{lid}&select=id")
    code, gav = api(GAVIN, "GET", f"/my_tasks?list_id=eq.{lid}&select=id")
    code, lead = api(LEAD_A, "GET", f"/my_tasks?list_id=eq.{lid}&select=id")
    code, leadb = api(LEAD_B, "GET", f"/my_tasks?list_id=eq.{lid}&select=id")
    check("visibility: owner sees own tasks", len(mine) > 0, len(mine))
    check("visibility: other intern sees none", gav == [], gav)
    check("visibility: own team lead sees them", len(lead) == len(mine), (len(lead), len(mine)))
    check("visibility: other team's lead sees none", leadb == [], leadb)
    code, boxes = api(GAVIN, "GET", "/email_accounts?select=email_address,owner_id")
    check("mailboxes: intern sees only own (+ own lead's) boxes",
          all(b["owner_id"] in (uid(GAVIN), uid(LEAD_A), uid("taylor.lead@example.com")) for b in boxes) and len(boxes) >= 5, len(boxes))
    code, boxes = api(GAVIN, "GET", "/email_accounts?select=password&limit=1")
    check("mailboxes: password column not readable by interns", code != 200 or not boxes or boxes[0].get("password") in (None, ""), (code, str(boxes)[:80]))
    code, res = api(GAVIN, "POST", "/sequence_tasks", {"dial_id": cd, "list_id": lid, "owner_id": uid(GAVIN), "step": 9, "seq_day": 1, "kind": "call", "due_on": "2026-11-23"})
    check("tasks: no direct inserts from the app", code >= 400, code)

    # ---- 12. stop + deleted list
    any_active = q(f"select id from dials where list_id='{lid}' and seq_state='active' limit 1")
    if any_active:
        code, _ = rpc(CALEB, "stop_sequence", p_dial_id=any_active[0]["id"], p_reason="asked to stop")
        d = q(f"select seq_state from dials where id='{any_active[0]['id']}'")[0]["seq_state"]
        check("stop: owner can stop a lead", code == 200 and d == "stopped", (code, d))
    lid2 = make_list(CALEB, [dict(email=SINKS[0], **COPY)])
    rpc(CALEB, "seq_prepare_list", p_list_id=lid2); rpc(CALEB, "approve_list_copy", p_list_id=lid2)
    q(f"update dials set seq_day0='2026-11-23' where list_id='{lid2}'"); q(f"select seq_build_tasks(id) from dials where list_id='{lid2}'")
    q(f"update scheduled_emails s set status='cancelled' from dials d where d.id=s.dial_id and d.list_id='{lid2}' and s.status='pending'")
    q(f"update sequence_tasks set status='pending', scheduled_email_id=null where status='queued' and list_id='{lid2}'")
    q(f"update dial_lists set deleted_at=now() where id='{lid2}'")
    q("select sequence_dispatch('2026-11-23 10:00-07')")
    n = q(f"select count(*) n from sequence_tasks where list_id='{lid2}' and status='queued'")[0]["n"]
    check("deleted list: nothing sends", n == 0, n)

    # ---- 13. mailbox owner matching
    m = q("""select match_mailbox_owner('Caleb Hong', 'x@y.com') a, match_mailbox_owner(null, 'caleb.hong@wsignal.com') b,
                    match_mailbox_owner(null, 'caleb@wsignal.com') c, match_mailbox_owner('  CALEB   hong ', null) d,
                    match_mailbox_owner('Caleb Hongg', 'ch@x.com') e""")[0]
    check("matching: display name, first.last@, spacing/case", m["a"] == uid(CALEB) and m["b"] == uid(CALEB) and m["d"] == uid(CALEB), m)
    check("matching: first-name-only and typos stay unassigned", m["c"] is None and m["e"] is None, m)

if __name__ == "__main__":
    run_ok = True
    try:
        run()
    except Exception:
        traceback.print_exc(); run_ok = False
    finally:
        cleanup()
        q("delete from email_messages where message_id in ('<t1@x>','<r1@x>','<b1@x>')")
    fails = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(fails)}/{len(results)} passed" + ("" if run_ok else " (run aborted)"))
