"""Load test on TEST: N interns x M leads. Pauses the real mail dispatcher for the duration,
cancels every queued test send at the end, and re-enables it. Lists are named 'TEST-LOAD ...'."""
import sb, time, json, sys
from collections import Counter
from test_sequences import rpc, q, uid, SEC

PER = int(sys.argv[1]) if len(sys.argv) > 1 else 300
INTERNS = [e for e, a in SEC["accounts"].items() if a["role"] == "intern" and e.startswith("test.")]
job = {r["jobname"]: r["jobid"] for r in q("select jobid, jobname from cron.job where jobname in ('scheduled-email-dispatch','sequence-dispatch')")}

def cleanup():
    q("""update scheduled_emails s set status='cancelled', error='load test cleanup' from dials d join dial_lists l on l.id=d.list_id
         where d.id=s.dial_id and l.name like 'TEST-LOAD %' and s.status in ('pending','sending')""")
    q("delete from dial_lists where name like 'TEST-LOAD %'")

q(f"select cron.alter_job(job_id := {job['scheduled-email-dispatch']}, active := false)")
try:
    cleanup()
    t0 = time.time()
    lists = {}
    for i, e in enumerate(INTERNS):
        lid = q(f"""insert into dial_lists (name, dial_type, created_by, mandate) values ('TEST-LOAD {e.split('@')[0]}', 'seller', '{uid(e)}', 'data') returning id""")[0]["id"]
        lists[e] = lid
        # 70% personal email w/ copy, 10% generic, 10% blank, 5% malformed, 5% personal but missing follow-up
        q(f"""insert into dials (list_id, created_by, company_name, full_name, email, company_phone, email_subject, email_1, email_2)
              select '{lid}', '{uid(e)}', 'Load Co ' || g, 'Owner ' || g,
                case when g % 20 < 14 then 'owner' || g || '.{i}@load-test.example.com'
                     when g % 20 < 16 then 'info@loadco' || g || '.example.com'
                     when g % 20 < 18 then null
                     when g % 20 = 18 then 'broken-' || g
                     else 'pat' || g || '.{i}@load-test.example.com' end,
                '(801) 555-' || lpad((g % 10000)::text, 4, '0'),
                'Subject ' || g, 'Hi Owner, body ' || g || '.', case when g % 20 = 19 then null else 'Follow ' || g end
              from generate_series(1, {PER}) g""")
    t_ins = time.time() - t0
    prep, appr = [], []
    for e, lid in lists.items():
        t = time.time(); c, r = rpc(e, "seq_prepare_list", p_list_id=lid); prep.append(time.time() - t)
        assert c == 200, (c, r)
        t = time.time(); c, r2 = rpc(e, "approve_list_copy", p_list_id=lid); appr.append(time.time() - t)
        assert c == 200, (c, r2)
    print(f"inserted {PER*len(lists)} leads in {t_ins:.1f}s; prepare max {max(prep):.2f}s avg {sum(prep)/len(prep):.2f}s; approve max {max(appr):.2f}s avg {sum(appr)/len(appr):.2f}s")
    print("last list result:", r, r2)
    tasks = q("select count(*) n, count(*) filter (where kind in ('email','followup_email')) e from sequence_tasks t join dial_lists l on l.id=t.list_id where l.name like 'TEST-LOAD %'")[0]
    print("tasks:", tasks)
    # pin every started lead to a known Monday so the simulated day is deterministic
    q("update dials d set seq_day0='2026-11-23' from dial_lists l where l.id=d.list_id and l.name like 'TEST-LOAD %' and d.seq_state='active' and d.sequence='email5'")
    t = time.time()
    q("select seq_build_tasks(d.id) from dials d join dial_lists l on l.id=d.list_id where l.name like 'TEST-LOAD %' and d.sequence='email5' and d.seq_state='active'")
    print(f"rebuilt email-sequence tasks in {time.time()-t:.1f}s")
    # simulate a workday, every 5 minutes 08:00-17:00 Denver
    runs, total, slow = 0, 0, 0.0
    for minute in range(0, 9 * 60, 5):
        ts = f"2026-11-23 {8 + minute // 60:02d}:{minute % 60:02d}-07"
        t = time.time(); n = q(f"select sequence_dispatch('{ts}') n")[0]["n"]; dtm = time.time() - t
        runs += 1; total += n; slow = max(slow, dtm)
    per_box = q("""select a.email_address, a.daily_send_limit lim, count(*) n from scheduled_emails s join email_accounts a on a.id=s.account_id
                   join dials d on d.id=s.dial_id join dial_lists l on l.id=d.list_id where l.name like 'TEST-LOAD %' and s.status='pending'
                   group by 1,2""")
    over = [b for b in per_box if b["n"] > b["lim"]]
    print(f"simulated day: {runs} dispatcher runs, {total} queued, slowest run {slow:.2f}s; mailboxes used {len(per_box)}, over limit: {over}")
    cap = sum(b["lim"] for b in q("""select distinct a.id, a.daily_send_limit lim from email_accounts a join dials d on d.sender_account_id=a.id
                                     join dial_lists l on l.id=d.list_id where l.name like 'TEST-LOAD %'"""))
    print(f"daily capacity of the senders in use: {cap}; first emails waiting: "
          + str(q("select count(*) n from sequence_tasks t join dial_lists l on l.id=t.list_id where l.name like 'TEST-LOAD %' and t.kind='email' and t.status='pending'")[0]["n"]))
    tt = q("select count(*) n from my_tasks where list_id in (select id from dial_lists where name like 'TEST-LOAD %')")[0]["n"]
    t = time.time(); c, rows = (lambda r: r)(rpc.__globals__["api"](INTERNS[0], "GET", "/my_tasks?select=id,kind,due_on,company_name&status=in.(pending,failed)&due_on=lte.2026-11-30&order=due_on&limit=500"))
    print(f"Today-page query for one intern: {len(rows)} rows in {time.time()-t:.2f}s (view total {tt})")
finally:
    cleanup()
    q(f"select cron.alter_job(job_id := {job['scheduled-email-dispatch']}, active := true)")
    print("cleaned up; mail dispatcher re-enabled; pending test sends:",
          q("select count(*) n from scheduled_emails where status='pending'")[0]["n"])
