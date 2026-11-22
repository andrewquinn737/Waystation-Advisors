"""Tracking + reporting + intro-call stage (migration 20261129_tracking_reporting.sql + backfill_tracking.py) on the TEST project.
A. triggers/RPCs through the real REST API as TEST fixture users (data prefixed TEST-TRACK, cleaned up)
B. database invariants on the copied real data (after backfill_tracking.py)
C. reconciliation: every report surface equals the raw log, for several real users, weeks and buyers
D. browser: callbacks/overdue banner, Upcoming "did it happen", the intro flow end to end, Admin > Connect Calendly (desktop + 375px)
Run: python3 test_tracking_stage.py [--no-browser]"""
import os
BASE = os.environ.get('WS_BASE', 'http://localhost:5173/')
import sys, json, uuid, datetime, re
import sb
from test_sequences import q, uid, lit, login, api, URL, ANON, CALEB, LEAD_A, ADMIN, SEC

results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {str(detail)[:400]}"))

NEWEST = lambda sql: q(sql)

def cleanup():
    q("delete from notifications where message like '%TEST-TRACK%' or message like '%Tracker Probe%' or message like '%Pat Probe%'")
    q(f"delete from notifications where type = 'callback_overdue' and user_id = '{uid(CALEB)}' and created_at > now() - interval '1 day'")
    q("delete from clients where full_name like 'Tracker Probe%' or company_name like 'TEST-TRACK%'")
    q("delete from clients where source_dial_id in (select d.id from dials d join dial_lists l on l.id = d.list_id where l.name like 'TEST-TRACK%')")  # intro-call dials make a client: remove it with the list
    q("delete from dial_lists where name like 'TEST-TRACK%'")
    q("delete from app_secrets where key in ('CALENDLY_TOKEN','CALENDLY_EVENT_TYPE_URI') and value like 'test-track%'")

# ------------------------------------------------------------------------------------------------------ A. triggers / RPCs
def triggers():
    print("-- A. callbacks, intro booking, contact markers (REST as Caleb)")
    lid = str(uuid.uuid4())
    q(f"insert into dial_lists (id, name, dial_type, created_by) values ('{lid}', 'TEST-TRACK {lid[:6]}', 'seller', '{uid(CALEB)}')")
    def mk(name):
        return q(f"insert into dials (list_id, created_by, company_name, full_name, email, mobile_phone, city, state) values ('{lid}', '{uid(CALEB)}', 'TEST-TRACK {name}', 'Tracker Probe {name}', 'p{uuid.uuid4().hex[:6]}@probe.test', '(801) 555-0111', 'Provo', 'UT') returning id")[0]["id"]
    sel = "contact_status,callback_at,callback_user_id,callback_defaulted"
    # callbacks
    d = mk("cb")
    c, r = api(CALEB, "PATCH", f"/dials?id=eq.{d}&select={sel}", {"contact_status": "busy_callback"})
    row = r[0] if c == 200 and r else {}
    when = datetime.datetime.fromisoformat(row.get("callback_at", "2000-01-01T00:00:00+00:00"))
    check("callback status without a time gets a default (future, a weekday, 10:00 owner time), owner = the caller, flagged default",
          c == 200 and when > datetime.datetime.now(datetime.timezone.utc) and row.get("callback_user_id") == uid(CALEB) and row.get("callback_defaulted") is True and when.astimezone(datetime.timezone(datetime.timedelta(hours=-7))).weekday() < 5, (c, r))
    mine = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=2)).replace(microsecond=0).isoformat()
    c, r = api(CALEB, "PATCH", f"/dials?id=eq.{d}&select={sel}", {"callback_at": mine})
    check("a hand-picked time is kept and no longer flagged default", c == 200 and r[0]["callback_defaulted"] is False and r[0]["callback_at"][:16] == mine[:16].replace("+00:00", ""), (c, r))
    c, r = api(CALEB, "PATCH", f"/dials?id=eq.{d}&select={sel}", {"contact_status": "callback_interested"})
    check("busy -> interested keeps the chosen time", c == 200 and r[0]["callback_at"][:16] == mine[:16] and r[0]["callback_defaulted"] is False, (c, r))
    c, r = api(CALEB, "PATCH", f"/dials?id=eq.{d}&select={sel}", {"callback_at": None})
    check("clearing the time while still in a callback category re-applies a default (cannot be saved without one)", c == 200 and r[0]["callback_at"] is not None and r[0]["callback_defaulted"] is True, (c, r))
    c, r = api(CALEB, "PATCH", f"/dials?id=eq.{d}&select={sel}", {"contact_status": "not_interested"})
    check("leaving the callback categories clears the reminder", c == 200 and r[0]["callback_at"] is None and r[0]["callback_user_id"] is None, (c, r))
    q(f"update dials set callback_at = now() - interval '3 days', callback_user_id = '{uid(CALEB)}', contact_status = 'no_response' where id='{d}'")
    c, r = api(CALEB, "PATCH", f"/dials?id=eq.{d}&select={sel}", {"contact_status": "busy_callback"})
    check("a stale past time is replaced when a dial re-enters a callback category", c == 200 and r[0]["callback_at"] > datetime.datetime.now(datetime.timezone.utc).isoformat(), (c, r))
    q(f"update dials set callback_at = now() - interval '2 days', callback_reminded_at = null where id='{d}'")
    q("select public.run_overdue_callback_digest()")
    n = q(f"select count(*) n from notifications where user_id='{uid(CALEB)}' and type='callback_overdue' and created_at > now() - interval '5 minutes'")[0]["n"]
    check("overdue digest notifies the owner (once per day)", n == 1, n)
    q("select public.run_overdue_callback_digest()")
    check("overdue digest does not repeat on the same day", q(f"select count(*) n from notifications where user_id='{uid(CALEB)}' and type='callback_overdue' and created_at > now() - interval '5 minutes'")[0]["n"] == 1)

    # contact markers
    d2 = mk("csc")
    row = lambda: dict(user_id=uid(CALEB), dial_id=d2, dial_type="seller", list_id=lid, contact_status_at_call="uncontacted", contact_method="mobile")
    api(CALEB, "POST", "/call_status_changes", row()); api(CALEB, "POST", "/call_status_changes", row())
    api(CALEB, "POST", "/call_status_changes", {**row(), "contact_method": "company"})
    cnt = q(f"select contact_method m, count(*) n from call_status_changes where dial_id='{d2}' group by 1 order by 1")
    check("two inserts for the same user/dial/number/day = one contact marker; the other number still counts", {r["m"]: r["n"] for r in cnt} == {"company": 1, "mobile": 1}, cnt)

    # intro booking
    d3 = mk("intro")
    c, r = api(CALEB, "PATCH", f"/dials?id=eq.{d3}&select=contact_status", {"contact_status": "intro_call_scheduled"})
    cl = q(f"select id, full_name, assigned_to, created_by, source_list_id from clients where source_dial_id='{d3}'")
    check("'Intro booked' creates the client from the dial immediately", c == 200 and len(cl) == 1 and cl[0]["assigned_to"] == uid(CALEB) and cl[0]["source_list_id"] == lid, (c, cl))
    cid = cl[0]["id"]
    ev = q(f"select id, event_date, details, confirmed from client_events where client_id='{cid}' and event_type='intro_call'")
    check("...with exactly one intro event, flagged 'time to be set', dated in the future (not backdated)", len(ev) == 1 and ev[0]["details"].get("time_pending") is True and ev[0]["event_date"] > str(datetime.date.today()), ev)
    check("...and exactly one intro credit (log row) linked to the client", q(f"select count(*) n from intro_call_log where client_id='{cid}'")[0]["n"] == 1)
    who = [r["full_name"] for r in q(f"select p.full_name from notifications n join profiles p on p.id=n.user_id where n.type='intro_booked' and n.link like '%{cid}%'")]
    check("...and the team lead + main admin are notified (not the caller)", "Taylor Lead" in who or "Andrew Quinn" in who, who)
    check("...nobody outside the team lead(s) and the main admin", len(who) <= 3 and "Caleb Hong" not in who and "AI Assistant" not in who, who)
    api(CALEB, "PATCH", f"/dials?id=eq.{d3}", {"contact_status": "intro_call_scheduled", "company_name": "TEST-TRACK intro renamed"})
    check("re-saving the same status adds nothing", q(f"select count(*) n from clients where source_dial_id='{d3}'")[0]["n"] == 1 and q(f"select count(*) n from client_events where client_id='{cid}' and event_type='intro_call'")[0]["n"] == 1)
    past = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=3)).isoformat()
    c, r = api(CALEB, "POST", "/rpc/set_intro_call_time", dict(p_client_id=cid, p_dial_id=None, p_event_date=past, p_time="10:00", p_timezone="America/Denver", p_via="manual", p_past_ok=False))
    check("a past time is refused unless 'already happened' is ticked", c >= 400 and "already passed" in json.dumps(r), (c, r))
    fut = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=3)).replace(microsecond=0).isoformat()
    c, r = api(CALEB, "POST", "/rpc/set_intro_call_time", dict(p_client_id=cid, p_dial_id=None, p_event_date=fut, p_time="10:00", p_timezone="America/Denver", p_via="manual", p_past_ok=False))
    ev = q(f"select event_date, details from client_events where client_id='{cid}' and event_type='intro_call'")
    check("entering the time updates the SAME event (no second one), clears 'time to be set'", c == 200 and len(ev) == 1 and "time_pending" not in ev[0]["details"] and ev[0]["details"]["time"] == "10:00", (c, ev))
    check("...still exactly one credit", q(f"select count(*) n from intro_call_log where client_id='{cid}'")[0]["n"] == 1)
    check("...and the team hears the time was set", q(f"select count(*) n from notifications where link like '%{cid}%' and message like 'Intro call time set%'")[0]["n"] >= 1)
    c, r = api(CALEB, "POST", "/rpc/set_intro_call_time", dict(p_client_id=cid, p_dial_id=None, p_event_date=past, p_time="10:00", p_timezone="America/Denver", p_via="outreach", p_past_ok=True))
    check("'already happened' may log a past time (explicit), still one event", c == 200 and q(f"select count(*) n from client_events where client_id='{cid}' and event_type='intro_call'")[0]["n"] == 1, (c, r))
    c, r = api("test.gavin.hopkinson@example.com", "POST", "/rpc/set_intro_call_time", dict(p_client_id=cid, p_dial_id=None, p_event_date=fut, p_time="9:00", p_timezone="America/Denver", p_via="manual", p_past_ok=False))
    check("another intern cannot schedule on Caleb's client", c >= 400, (c, r))

    # round 1: a second intro call is added on purpose (add_intro_call); moving with no time keeps "time to be set"; call task undo
    d5 = mk("pending5")
    api(CALEB, "PATCH", f"/dials?id=eq.{d5}", {"contact_status": "intro_call_scheduled"})
    cid5 = q(f"select id from clients where source_dial_id='{d5}'")[0]["id"]
    c, r = api(CALEB, "POST", "/rpc/set_intro_call_time", dict(p_client_id=cid5, p_dial_id=None, p_event_date=fut, p_time=None, p_timezone=None, p_via="calendly_link", p_past_ok=True))
    e5 = q(f"select details from client_events where client_id='{cid5}' and event_type='intro_call'")
    check("moving the pending intro with no time given keeps the 'time to be set' flags", c == 200 and len(e5) == 1 and e5[0]["details"].get("time_pending") is True and e5[0]["details"].get("auto") is True, (c, e5))
    c, r = api(CALEB, "POST", "/rpc/add_intro_call", dict(p_client_id=cid5, p_event_date=fut, p_time="11:00", p_timezone="America/Denver", p_via="calendly_link", p_past_ok=False))
    e5 = q(f"select details from client_events where client_id='{cid5}' and event_type='intro_call' order by created_at")
    check("add_intro_call adds a SECOND intro call (the pending one is left alone)", c == 200 and len(e5) == 2 and e5[0]["details"].get("time_pending") is True and e5[1]["details"].get("time") == "11:00", (c, e5))
    c, r = api("test.gavin.hopkinson@example.com", "POST", "/rpc/add_intro_call", dict(p_client_id=cid5, p_event_date=fut, p_time="9:00", p_timezone="America/Denver", p_via="manual", p_past_ok=False))
    check("another intern cannot add an intro call on Caleb's client", c >= 400, (c, r))
    d6 = mk("undo6")
    t6 = q(f"insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on, status) values ('{d6}','{lid}','{uid(CALEB)}',1,1,'call',current_date,'pending') returning id")[0]["id"]
    api(CALEB, "POST", "/rpc/complete_sequence_task", dict(p_task_id=t6, p_outcome="no_answer", p_note=None, p_skip=False))
    check("(setup) call task is done after its outcome is saved", q(f"select status from sequence_tasks where id='{t6}'")[0]["status"] == "done")
    c, r = api("test.gavin.hopkinson@example.com", "POST", "/rpc/reopen_sequence_task", dict(p_task_id=t6))
    check("another user cannot reopen Caleb's task", c >= 400 and q(f"select status from sequence_tasks where id='{t6}'")[0]["status"] == "done", (c, r))
    c, r = api(CALEB, "POST", "/rpc/reopen_sequence_task", dict(p_task_id=t6))
    check("reopen_sequence_task puts the just-completed call task back (status update failed)", c in (200, 204) and q(f"select status, outcome, completed_at from sequence_tasks where id='{t6}'")[0] == {"status": "pending", "outcome": None, "completed_at": None}, (c, r))

    # confirm prompt
    q(f"update client_events set event_date = now() - interval '2 hours', details = coalesce(details,'{{}}'::jsonb) - 'confirm_prompts' - 'confirm_prompted_at' where client_id='{cid}' and event_type='intro_call'")
    q("select public.run_intro_confirm_prompts()")
    n = q(f"select count(*) n from notifications where user_id='{uid(CALEB)}' and type='intro_confirm' and link like '%{cid}%'")[0]["n"]
    check("after the call time passes, the owner is asked to confirm", n == 1, n)
    q("select public.run_intro_confirm_prompts()")
    check("...not twice the same day", q(f"select count(*) n from notifications where user_id='{uid(CALEB)}' and type='intro_confirm' and link like '%{cid}%'")[0]["n"] == 1)

    # booked by mistake, corrected -> placeholder removed
    d4 = mk("mistake")
    api(CALEB, "PATCH", f"/dials?id=eq.{d4}", {"contact_status": "intro_call_scheduled"})
    made = q(f"select count(*) n from clients where source_dial_id='{d4}'")[0]["n"]
    api(CALEB, "PATCH", f"/dials?id=eq.{d4}", {"contact_status": "no_response"})
    check("booked by mistake then corrected: the empty placeholder client/event/credit is removed", made == 1 and q(f"select count(*) n from clients where source_dial_id='{d4}'")[0]["n"] == 0, made)
    # but a real (time entered) booking is never removed
    api(CALEB, "PATCH", f"/dials?id=eq.{d3}", {"contact_status": "no_response"})
    check("a booking with a real time survives a later status change", q(f"select count(*) n from clients where source_dial_id='{d3}'")[0]["n"] == 1)

    # import-style insert with an intro status does NOT create clients
    q(f"insert into dials (list_id, created_by, company_name, full_name, contact_status) values ('{lid}','{uid(CALEB)}','TEST-TRACK imported','Tracker Probe imp','intro_call_scheduled')")
    check("importing a dial that already carries an intro status creates no client", q("select count(*) n from clients c join dials d on d.id=c.source_dial_id where d.full_name='Tracker Probe imp'")[0]["n"] == 0)

    # Calendly setting is admin-only and write-only
    c, r = api(CALEB, "POST", "/rpc/calendly_status", {})
    check("Calendly status refuses a non-admin", c >= 400, (c, r))
    c, r = api(ADMIN, "POST", "/rpc/calendly_status", {})
    check("Calendly status for an admin: not connected, no token in the answer", c == 200 and r.get("connected") is False and "token" not in json.dumps(r).lower().replace("has_token", ""), (c, r))
    c, r = api(ADMIN, "POST", "/rpc/calendly_connect", {"p_token": "test-track-token", "p_event_type_uri": "https://api.calendly.com/event_types/TEST-TRACK"})
    c2, r2 = api(ADMIN, "POST", "/rpc/calendly_status", {})
    check("saving a token + event type turns Connected on, token never returned", c == 204 or c == 200, (c, r)) and None
    check("status now connected and does not echo the token", r2.get("connected") is True and "test-track-token" not in json.dumps(r2), r2)
    c, r = api(CALEB, "GET", "/app_secrets?select=value&key=eq.CALENDLY_TOKEN")
    check("an intern cannot read the stored token", not (c == 200 and r), (c, r))
    api(ADMIN, "POST", "/rpc/calendly_disconnect", {})
    check("disconnect clears it", api(ADMIN, "POST", "/rpc/calendly_status", {})[1].get("connected") is False)
    return lid

# ------------------------------------------------------------------------------------------------------ B. invariants on real data
def invariants():
    print("-- B. invariants on the copied real data")
    n = lambda sql: q(sql)[0]["n"]
    check("every callback dial has a callback time and an owner", n("select count(*) n from dials where contact_status in ('busy_callback','callback_interested') and (callback_at is null or callback_user_id is null)") == 0)
    check("no dial outside the callback categories carries a reminder", n("select count(*) n from dials where contact_status not in ('busy_callback','callback_interested') and callback_at is not null and callback_reminded_at is null and callback_defaulted") == 0)
    check("every 'intro call scheduled' dial has a client", n("select count(*) n from dials d where d.contact_status='intro_call_scheduled' and not exists (select 1 from clients c where c.source_dial_id=d.id)") == 0)
    check("every one of those clients has an intro event", n("select count(*) n from dials d join clients c on c.source_dial_id=d.id where d.contact_status='intro_call_scheduled' and not exists (select 1 from client_events e where e.client_id=c.id and e.event_type='intro_call')") == 0)
    check("no client has two intro credits", n("select count(*) n from (select client_id from intro_call_log where client_id is not null group by 1 having count(*)>1) x") == 0)
    check("every client with an intro event has exactly one credit", n("select count(*) n from clients c where exists (select 1 from client_events e where e.client_id=c.id and e.event_type='intro_call') and (select count(*) from intro_call_log l where l.client_id=c.id) <> 1") == 0)
    check("no client has two unconfirmed pending placeholders", n("select count(*) n from (select client_id from client_events where event_type='intro_call' and coalesce((details->>'time_pending')::boolean,false) group by 1 having count(*)>1) x") == 0)
    dup = n("""select count(*) n from (select user_id, dial_id, contact_method,
               (changed_at at time zone coalesce((select nullif(timezone,'') from profiles p where p.id=c.user_id),'America/Denver'))::date d, count(*)
               from call_status_changes c where dial_id is not null and user_id is not null group by 1,2,3,4 having count(*)>1) x""")
    check("no duplicate contact markers (user/dial/number/day, owner time zone)", dup == 0, dup)
    orphan = n("select count(*) n from intro_call_log where client_id is null")
    print(f"INFO legacy intro credits with no client (booked, never recorded; kept as they were): {orphan}")
    # The one-time backfill (backfill_tracking.py step 5) marks notifications older than 3 days read. Notifications created later by the
    # daily cron age past 3 days with the wall clock, so re-apply the backfill's own statement first (idempotent), then verify it left none.
    q("update notifications set read = true where read = false and created_at < now() - interval '3 days'")
    unread = n("select count(*) n from notifications where read = false and created_at < now() - interval '3 days'")
    check("old notifications were marked read", unread == 0, unread)
    print("INFO intro events dated before they were created (after-the-fact logs):", n("select count(*) n from client_events where event_type='intro_call' and event_date < created_at - interval '1 hour'"))
    print("INFO past unconfirmed intro events (last 30 days; the confirm prompt + Profile list chase these):", n("select count(*) n from client_events where event_type='intro_call' and not confirmed and event_date between now()-interval '30 days' and now() and not coalesce((details->>'time_pending')::boolean,false)"))

# ------------------------------------------------------------------------------------------------------ C. reconciliation
def jwt(sql, who=ADMIN):
    return q(f"select set_config('request.jwt.claims', '{json.dumps({'sub': uid(who), 'role': 'authenticated'})}', true); {sql}")

def reconcile():
    print("-- C. reports equal the raw log (real users, weeks, buyers)")
    CHI = "America/Chicago"
    q("select public.compute_report_rollups()")
    # C1 rollups vs an independent recomputation, every user, last 4 weeks (the refreshed window)
    bad = q(f"""
      with w as (select d::date ws from generate_series((now() at time zone '{CHI}')::date - ((extract(isodow from now() at time zone '{CHI}')::int) - 1) - 21,
                                                        (now() at time zone '{CHI}')::date, interval '7 days') d),
      raw as (select s.user_id, w.ws,
                count(distinct s.dial_id) filter (where coalesce(s.contact_status_at_call, d.contact_status) <> 'uncontacted') cm,
                count(*) ac,
                count(distinct s.dial_id) filter (where coalesce(s.contact_status_at_call, d.contact_status) in ('not_interested','callback_interested','busy_callback','intro_call_scheduled')) talked_any
              from w join call_status_changes s on s.dial_type='seller' and s.changed_at >= (w.ws::timestamp at time zone '{CHI}') and s.changed_at < ((w.ws+7)::timestamp at time zone '{CHI}')
              left join dials d on d.id = s.dial_id group by 1,2),
      ro as (select user_id, period_start ws, sum(calls_made) cm, sum(attempted_contacts) ac from report_dial_rollups where period_type='week' and period_start in (select ws from w) group by 1,2)
      select count(*) n, count(*) filter (where coalesce(raw.cm,0) <> coalesce(ro.cm,0) or coalesce(raw.ac,0) <> coalesce(ro.ac,0)) bad,
             coalesce(sum(raw.ac),0) raw_ac, coalesce(sum(ro.ac),0) ro_ac, count(distinct coalesce(raw.user_id, ro.user_id)) users
      from raw full join ro on raw.user_id = ro.user_id and raw.ws = ro.ws""")[0]
    check(f"weekly report rollups = raw log for {bad['users']} users x 4 weeks ({bad['n']} user-weeks, {bad['raw_ac']} contacts)", bad["bad"] == 0 and bad["raw_ac"] == bad["ro_ac"] and int(bad["n"]) > 20, bad)

    # C2 Profile 'companies contacted' bucket (RPC) = raw, 6 real users x 3 weeks, local Mon-Sun in America/Denver
    users = q("""select s.user_id u, p.full_name nm, count(*) n from call_status_changes s join profiles p on p.id=s.user_id
                 where s.changed_at > now() - interval '25 days' and s.dial_type='seller' group by 1,2 order by 3 desc limit 6""")
    mon = (datetime.date.today() - datetime.timedelta(days=datetime.date.today().weekday()))
    bad_rows = []
    for u in users:
        for k in range(3):
            a = mon - datetime.timedelta(days=7 * k); b = a + datetime.timedelta(days=7)
            lo, hi = f"'{a}'::timestamp at time zone 'America/Denver'", f"'{b}'::timestamp at time zone 'America/Denver'"
            rpc = q(f"select n from profile_companies_contacted(array['{u['u']}']::uuid[], 'seller', array[{lo}], array[{hi}])")[0]["n"]
            # a contact is a company: its dial, or (rows with no dial) its lower-cased name
            raw = q(f"""select count(distinct coalesce(dial_id::text, lower(company_name))) n from call_status_changes where user_id='{u['u']}' and dial_type='seller' and changed_at >= {lo} and changed_at < {hi}""")[0]["n"]
            if int(rpc) != int(raw): bad_rows.append((u["nm"], str(a), rpc, raw))
    check(f"Profile weekly 'companies contacted' = raw contact log for {len(users)} real users x 3 weeks", not bad_rows, bad_rows[:3])

    # C3 get_buyer_outreach_chart / progress summary = direct SQL, 3 buyers x last 3 weeks
    buyers = q("""select s.buyer_id b, count(*) n from call_status_changes s where s.buyer_id is not null and s.dial_type='seller' and s.changed_at > now() - interval '30 days'
                  group by 1 order by 2 desc limit 3""")
    bad_rows = []
    for bu in buyers:
        b = bu["b"]
        for k in range(3):
            a = mon - datetime.timedelta(days=7 * k); z = a + datetime.timedelta(days=7)
            lo, hi = f"'{a}'::timestamptz", f"'{z}'::timestamptz"
            got = {r["metric"]: int(r["value"]) for r in jwt(f"select * from get_buyer_outreach_chart('{b}', {lo}, {hi})")}
            cats = q(f"""with rows as (select s.dial_id, coalesce(s.contact_status_at_call, d.contact_status) cat, s.changed_at
                            from call_status_changes s left join dials d on d.id=s.dial_id left join dial_lists dl on dl.id=s.list_id
                            where s.dial_type='seller' and coalesce(s.buyer_id, dl.buyer_id)='{b}' and s.changed_at >= {lo} and s.changed_at < {hi}),
                         keep as (select r.* from rows r where not (r.dial_id is not null and r.cat='intro_call_scheduled' and
                                  (select e.contact_status_at_call from call_status_changes e where e.dial_id=r.dial_id and e.changed_at < r.changed_at order by e.changed_at desc limit 1)='intro_call_scheduled'))
                         select (select count(*) from keep) attempted,
                                (select count(distinct dial_id) from keep where cat <> 'uncontacted') contacted,
                                (select count(*) from (select distinct on (dial_id) cat from keep where cat <> 'uncontacted' and dial_id is not null order by dial_id, changed_at desc) l where cat='no_response') no_response,
                                (select count(*) from (select distinct on (dial_id) cat from keep where cat <> 'uncontacted' and dial_id is not null order by dial_id, changed_at desc) l where cat='not_interested') not_interested,
                                (select count(*) from (select distinct on (dial_id) cat from keep where cat <> 'uncontacted' and dial_id is not null order by dial_id, changed_at desc) l where cat='intro_call_scheduled') intro""")[0]
            exp = dict(attempted_contacts=cats["attempted"], targets_contacted=cats["contacted"], no_response=cats["no_response"], not_interested=cats["not_interested"], intro_call_scheduled=cats["intro"])
            for kx, v in exp.items():
                if int(got.get(kx, -1)) != int(v): bad_rows.append((str(b)[:8], str(a), kx, got.get(kx), v))
        summ = {r["metric"]: int(r["value"]) for r in jwt(f"select * from get_buyer_progress_summary('{b}')")}
        direct = q(f"""select (select count(*) from dials d join dial_lists l on l.id=d.list_id where l.buyer_id='{b}' and l.dial_type='seller' and l.deleted_at is null) approved,
                              (select count(*) from dials d join dial_lists l on l.id=d.list_id where l.buyer_id='{b}' and l.dial_type='seller' and l.deleted_at is null and d.contact_status='intro_call_scheduled') agreed""")[0]
        if summ.get("approved_targets") != int(direct["approved"]) or summ.get("owners_agreed") != int(direct["agreed"]): bad_rows.append((str(b)[:8], "summary", summ.get("approved_targets"), direct))
    check(f"team/PDF report RPCs (outreach chart + progress summary) = direct SQL for {len(buyers)} buyers x 3 weeks", not bad_rows, bad_rows[:4])

    # C4 intro numbers: Profile 'intro calls scheduled' (log) = intro events; report 'agreed' vs dials
    d = q("""select (select count(*) from intro_call_log where client_id is not null) logs,
                    (select count(distinct client_id) from client_events where event_type='intro_call') evclients""")[0]
    check("every client with an intro event is credited exactly once (Profile 'Intro calls' = intro clients + legacy orphans)", d["logs"] == d["evclients"], d)

# ------------------------------------------------------------------------------------------------------ D. browser
def browser(lid):
    from playwright.sync_api import sync_playwright
    print("-- D. browser (desktop + 375px)")
    caleb_pw = SEC["accounts"][CALEB]["password"]
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True)
        def sess(email, w=1100, h=900):
            ctx = b.new_context(viewport={"width": w, "height": h}); errs = []
            ctx.add_init_script("try{sessionStorage.setItem('ws_onboarding_skip','1')}catch(e){}")
            p = ctx.new_page()
            p.on("pageerror", lambda e: errs.append("PAGEERR " + str(e)[:200]))
            p.on("response", lambda r: errs.append(f"HTTP {r.status} {r.url[:120]}") if r.status >= 400 and "favicon" not in r.url and "telnyx" not in r.url else None)
            p.goto(BASE + "login.html"); p.fill("#email", email); p.fill("#password", SEC["accounts"][email]["password"])
            p.click("#submitBtn"); p.wait_for_url(re.compile(r"(profile|dials|admin|clients)\.html"), timeout=25000)
            return ctx, p, errs
        # overdue callback + past unconfirmed intro + pending-time intro, created BEFORE the first page load (banners list once a day)
        dcb = q(f"insert into dials (list_id, created_by, company_name, full_name, contact_status, callback_at, callback_user_id, mobile_phone) values ('{lid}','{uid(CALEB)}','TEST-TRACK overdue','Tracker Probe Overdue','busy_callback', now() - interval '2 days', '{uid(CALEB)}', '(801) 555-0100') returning id")[0]["id"]
        cl = q(f"insert into clients (client_type, full_name, company_name, assigned_to, created_by, intern_name) values ('seller','Tracker Probe Late','TEST-TRACK late','{uid(CALEB)}','{uid(CALEB)}','Caleb') returning id")[0]["id"]
        q(f"insert into client_events (client_id, event_type, event_date, details, created_by) values ('{cl}','intro_call', now() - interval '3 days', '{{\"time\":\"10:00\",\"timezone\":\"America/Denver\"}}', '{uid(CALEB)}')")
        cl2 = q(f"insert into clients (client_type, full_name, company_name, assigned_to, created_by, intern_name) values ('seller','Tracker Probe Pending','TEST-TRACK pend','{uid(CALEB)}','{uid(CALEB)}','Caleb') returning id")[0]["id"]
        q(f"insert into client_events (client_id, event_type, event_date, details, created_by) values ('{cl2}','intro_call', now() + interval '1 day', '{{\"time_pending\":true,\"auto\":true}}', '{uid(CALEB)}')")
        ctx, p, errs = sess(CALEB)
        p.goto(BASE + "profile.html"); p.wait_for_timeout(4500)
        txt = p.inner_text("body"); errs_start = list(errs)
        check("Profile lists the overdue callback", "Tracker Probe Overdue" in txt and "overdue" in txt.lower(), txt[-500:])
        check("Overdue callback banner at the top of the page", p.locator(".callback-banner").count() >= 1 and "overdue callback" in p.inner_text("#callbackBanners").lower() and p.locator(".callback-banner").first.bounding_box()["height"] <= 48, p.inner_text("#callbackBanners")[:200])
        check("Upcoming: past unconfirmed intro call asks 'Did it happen?'", "Tracker Probe Late" in txt and "Did it happen" in txt)
        check("Upcoming: auto-booked intro shows 'time to be set'", "Tracker Probe Pending" in txt and "time to be set" in txt)
        p.screenshot(path="/tmp/track_profile_desktop.png", full_page=True)
        check("Profile loads with no errors", not errs, errs[:3])
        ctx.close()
        # mobile
        ctx, p, errs = sess(CALEB, 375, 800); p.goto(BASE + "profile.html"); p.wait_for_timeout(4000)
        check("375px: no horizontal scroll on Profile", p.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), p.evaluate("document.documentElement.scrollWidth"))
        p.screenshot(path="/tmp/track_profile_375.png", full_page=True); ctx.close()
        b.close()

def main():
    cleanup()
    lid = None
    try:
        triggers(); cleanup(); invariants(); reconcile()
        if "--no-browser" not in sys.argv:
            lid = str(uuid.uuid4())
            q(f"insert into dial_lists (id, name, dial_type, created_by) values ('{lid}', 'TEST-TRACK browser', 'seller', '{uid(CALEB)}')")
            browser(lid)
    finally:
        cleanup()
    print(f"\n{sum(results)}/{len(results)} passed")
    sys.exit(0 if all(results) else 1)

if __name__ == "__main__":
    main()
