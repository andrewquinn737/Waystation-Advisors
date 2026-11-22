"""Controlled email test on TEST: threading + stop-on-reply with REAL mail between our own mailboxes.
3 sender mailboxes -> 3 distinct recipient mailboxes (not senders in this test) + a Gmail sink; first email, then follow-up the same day
(follow-up due date set to today, test_send_now on), a real reply from one recipient, and verify the thread headers and the stop.
Everything is torn down at the end (flag off, redirect restored to Mason's 5 inboxes, pending sends cancelled, isolation undone).
Usage: python3 test_thread_reply_stop.py   (~20-30 min; TEST project only; sends to our own mailboxes + Mason's Gmail sink)"""
import sb, json, re, time, sys, urllib.request, urllib.error, uuid
import test_sequences as T
q, lit = T.q, T.lit

MASON = ["masonquinn10@gmail.com", "mason.alex.quinn@gmail.com", "mason@waystationadvisors.com",
         "mason@waystation-advisors.com", "mason.quinn@waystation-advisors.com"]
# sender owner login, sender mailbox, recipient mailbox   (recipients are not senders; different tenants)
PLAN = [("test.kayden.hyde@example.com", "analyst@working-signal.com", "analyst@working-signal-broker.com"),
        ("test.caleb.hong@example.com", "associate@working-signal-ai.com", "director@working-signal-sale.com"),
        ("test.mikaela.harris@example.com", "analyst@wsignalsales.com", "associate@wsignalsales.com")]
GMAIL = "masonquinn10@gmail.com"
SALT = uuid.uuid4().hex[:5]
OUT = {"salt": SALT}

def secret(pairs): sb.test_api("/secrets", [{"name": k, "value": v} for k, v in pairs])
def acc_id(email): return q(f"select id from email_accounts where lower(email_address)={lit(email)}")[0]["id"]
def live(aid, **kw):
    kw["account_id"] = aid
    r = urllib.request.Request(T.URL + "/functions/v1/email-live", method="POST", data=json.dumps(kw).encode(),
        headers={"apikey": T.ANON, "Authorization": "Bearer " + T.login(T.ADMIN), "Content-Type": "application/json"})
    try: return json.load(urllib.request.urlopen(r, timeout=90))
    except urllib.error.HTTPError as e: return {"err": e.read().decode()[:200]}
def find(aid, subj_part):
    for k in ("inbox", "spam"):
        for i in live(aid, action="list", kind=k, limit=40).get("items", []):
            if subj_part in (i.get("subject") or ""): yield k, i
def hdr(aid, kind, uid): return live(aid, action="headers", kind=kind, uid=uid).get("headers", "")
def unfold(h): return re.sub(r"\r?\n[ \t]+", " ", h)
def hv(h, n): m = re.search(r"^%s:\s*(.*)$" % n, h, re.M | re.I); return m.group(1).strip() if m else ""

def wait(cond, secs, every=20, what=""):
    t0 = time.time()
    while time.time() - t0 < secs:
        v = cond()
        if v: return v
        q("select 1"); time.sleep(every)
    print("TIMEOUT waiting for", what); return None

def send_direct(sender_acct, to, subject, text, in_reply_to=None):
    body = {"account_id": sender_acct, "to": [to], "subject": subject, "text": text}
    if in_reply_to: body["in_reply_to"] = in_reply_to
    r = urllib.request.Request(T.URL + "/functions/v1/email-send", method="POST", data=json.dumps(body).encode(),
        headers={"apikey": T.ANON, "Authorization": "Bearer " + T.login(T.ADMIN), "Content-Type": "application/json"})
    try: return json.load(urllib.request.urlopen(r, timeout=120))
    except urllib.error.HTTPError as e: return {"err": e.read().decode()[:300]}

BODIES = [
 ("Hi {f},\n\nI came across {c} while reading about service businesses around {city} and had a quick question about who looks after your vendor relationships. Would a short call this week make sense?\n\nThanks,\n{s}",
  "Hi {f},\n\nJust floating my note from earlier back to the top of your inbox. If now is a bad time, tell me and I will check back next month.\n\n{s}"),
 ("Hi {f},\n\nA neighbor mentioned {c} when we talked about trusted shops in {city}. I wanted to ask who handles purchasing decisions for you. Is a ten minute chat realistic sometime soon?\n\nBest,\n{s}",
  "Hi {f},\n\nCircling back once on my last message about {c}. A one line answer is plenty if the timing is wrong.\n\n{s}"),
 ("Hi {f},\n\nYour name came up when I was looking at family run firms near {city}, and {c} stood out. Who is the right person to talk to about ownership plans? Happy to keep it brief.\n\nCheers,\n{s}",
  "Hi {f},\n\nSecond and last note from me on {c}. If it is easier, reply with a better day and I will work around it.\n\n{s}"),
 ("Hi {f},\n\nI keep seeing {c} mentioned around {city} and finally decided to reach out. Could you point me to whoever decides on outside partnerships? A quick yes or no helps either way.\n\nTalk soon,\n{s}",
  "Hi {f},\n\nFollowing up on the above for {c}. No pressure at all, I only want to make sure it did not get buried.\n\n{s}")]

def main():
    lists, mine = [], []
    owners = {}
    try:
        # ---------- setup
        q("delete from dial_lists where name like 'DELIV TEST %'")
        doms = ",".join(lit(x.split("@")[1]) for x in [p[2] for p in PLAN] + [GMAIL])
        for r in q(f"select id from dials where seq_state='active' and lower(split_part(email,'@',2)) in ({doms})"):
            q(f"select seq_stop('{r['id']}', 'completed', 'deliv test: stale campaign lead', false)")   # earlier test campaigns block the same address/company
        secret([("TEST_REDIRECT_TO", ",".join(MASON + [p[1] for p in PLAN] + [p[2] for p in PLAN]))])
        q("insert into app_secrets (key,value) values ('test_send_now','true') on conflict (key) do update set value='true'")
        q("select cron.alter_job((select jobid from cron.job where jobname='email-sync-poll'), active := true)")
        sender_ids = [acc_id(p[1]) for p in PLAN]
        OUT["senders"] = [p[1] for p in PLAN]; OUT["recipients"] = [p[2] for p in PLAN]
        for login, s, r in PLAN:
            o = T.uid(login); owners[login] = o
            q(f"update email_accounts set send_paused_reason='deliv test' where owner_id='{o}' and id not in ({','.join(lit(i) for i in sender_ids)}) and coalesce(send_paused_reason,'')=''")
            q(f"update email_accounts set send_paused_reason=null, sync_enabled=true where id={lit(acc_id(s))} and send_paused_reason in ('deliv test')")
        T.seed_mv(GMAIL, "ok")
        for _, _, r in PLAN: T.seed_mv(r, "ok")
        q("update dial_lists set send_paused_reason='deliv-test isolation' where copy_status='approved' and send_paused_reason is null and deleted_at is null")
        # leads
        leads = []   # (login, dial email, first name)
        for k, (login, s, r) in enumerate(PLAN):
            leads.append((login, r, ["Dana", "Morgan", "Robin"][k], f"Harbor{k}{SALT} Supply", ["Boise", "Tulsa", "Reno"][k]))
        leads.append((PLAN[1][0], GMAIL, "Mason", f"Gmail{SALT} Sink Co", "Provo"))
        by_owner = {}
        for l in leads: by_owner.setdefault(l[0], []).append(l)
        for login, ls in by_owner.items():
            lid = str(uuid.uuid4()); lists.append((login, lid))
            q(f"insert into dial_lists (id,name,dial_type,created_by,mandate) values ('{lid}','DELIV TEST {SALT} {login[5:12]}','seller','{owners[login]}',null)")
            sender_first = q(f"select coalesce(nullif(split_part(full_name,' ',1),''),'Alex') n from profiles where id='{owners[login]}'")[0]["n"]
            for _, email, f, co, city in ls:
                e1, e2 = [b.format(f=f, c=co, city=city, s=sender_first) for b in BODIES[leads.index(next(x for x in leads if x[1] == email))]]
                subj = f"Question about {co}"
                q(f"""insert into dials (list_id, created_by, company_name, full_name, email, company_phone, email_subject, email_1, email_2)
                      values ('{lid}','{owners[login]}',{lit(co)},{lit(f + ' Tester')},{lit(email)},'(801) 555-0100',{lit(subj)},{lit(e1)},{lit(e2)})""")
            print("prepare", T.rpc(login, "seq_prepare_list", p_list_id=lid)[1]); g = T.gate(login, lid); print("gate", g[1].get("summary") if isinstance(g[1], dict) else g)
        for login, lid in lists:
            code, res = T.start(login, lid); print("start", code, res if code != 200 else {k: res[k] for k in ("started", "held_for_copy", "moved_to_backup")})
        did = [r["id"] for r in q("select d.id from dials d join dial_lists l on l.id=d.list_id where l.name like 'DELIV TEST %s%%' and d.seq_state='active'" % SALT)]
        OUT["leads_started"] = len(did); assert len(did) == 4, "expected 4 started leads, got %d" % len(did)
        ids = ",".join(lit(i) for i in did)

        # ---------- email 1
        def first_sent():
            q("select sequence_dispatch()")
            r = q(f"select count(*) n from dials where id in ({ids}) and email_1_message_id is not null")[0]["n"]
            return r == 4
        ok1 = wait(first_sent, 35 * 60, 30, "all first emails sent")
        OUT["first_sent"] = bool(ok1)
        rows = q(f"select d.email, d.email_1_message_id mid, d.email_1_thread_id tid, d.sender_account_id from dials d where d.id in ({ids})")
        OUT["email1"] = rows; print("email1", rows)
        if not ok1: raise SystemExit("first emails not all sent")

        # ---------- follow-up due today; real reply from recipient 1 BEFORE the dispatcher runs again
        q(f"update sequence_tasks set due_on = current_date where dial_id in ({ids}) and kind='followup_email' and status='pending'")
        d1 = [r for r in q(f"select d.id, d.email, d.email_subject subj, d.email_1_message_id mid, a.email_address sender from dials d join email_accounts a on a.id=d.sender_account_id where d.id in ({ids})") if r["email"] == PLAN[0][2]][0]
        OUT["reply_lead"] = d1
        resp = send_direct(acc_id(PLAN[0][2]), d1["sender"], "Re: " + d1["subj"], "Hi, thanks for the note. Yes, a short call works for me, send over a time.\n\nDana", in_reply_to=d1["mid"])
        OUT["reply_send"] = resp; print("reply sent", resp)
        def replied():
            return q(f"select seq_state from dials where id='{d1['id']}'")[0]["seq_state"] == "replied"
        OUT["reply_stop"] = bool(wait(replied, 15 * 60, 20, "lead 1 to be marked replied"))
        st = q(f"select kind,status from sequence_tasks where dial_id='{d1['id']}' order by step")
        OUT["lead1_tasks"] = st; print("lead1 tasks", st)
        OUT["reply_task"] = q(f"select status,due_on from sequence_tasks where dial_id='{d1['id']}' and kind='reply'")

        # ---------- follow-ups for the other 3
        others = ",".join(lit(i) for i in did if i != d1["id"])
        def fu_sent():
            q("select sequence_dispatch()")
            return q(f"select count(*) n from email_messages m join dials d on lower(m.to_addresses->0->>'address')=lower(d.email) and d.id in ({others}) where m.direction='outbound' and m.subject like 'Re: Question about %%' and m.created_at > now() - interval '3 hours'")[0]["n"] >= 3
        OUT["followups_sent"] = bool(wait(fu_sent, 35 * 60, 30, "3 follow-ups sent"))
        OUT["lead1_followup_messages"] = q(f"select count(*) n from email_messages m where m.direction='outbound' and lower(m.to_addresses->0->>'address')={lit(PLAN[0][2])} and m.subject like 'Re: Question about %' and m.created_at > now() - interval '3 hours' and m.subject like {lit('%' + 'Harbor0' + SALT + '%')}")
        time.sleep(60)
        # ---------- threading checks (recipient mailbox headers) + stored thread ids
        res = []
        for login, s, r in PLAN[1:]:
            aid = acc_id(r); e1 = [x for x in OUT["email1"] if x["email"] == r][0]
            msgs = {}
            for k, it in find(aid, "Question about"):
                h = unfold(hdr(aid, k, it["uid"]))
                msgs[it["subject"]] = dict(folder=k, mid=hv(h, "Message-ID"), irt=hv(h, "In-Reply-To"), refs=hv(h, "References"), to=hv(h, "To"), lu=hv(h, "List-Unsubscribe"), cte=hv(h, "Content-Transfer-Encoding"))
            res.append(dict(rcpt=r, email1_mid=e1["mid"], stored_thread=e1["tid"], msgs=msgs))
        OUT["thread_checks"] = res
        OUT["stored_threads"] = q(f"select m.thread_id, count(*) n, array_agg(m.subject order by m.created_at) subs from email_messages m where m.direction='outbound' and m.created_at > now() - interval '3 hours' and m.subject like 'Re: Question about %%' or m.id in (select sent_message_id from scheduled_emails where dial_id in ({ids})) group by 1 having count(*) >= 1")
        gm = q(f"select d.email_1_message_id mid, d.email_1_thread_id tid from dials d where id in ({ids}) and lower(d.email)={lit(GMAIL)}")
        OUT["gmail_lead"] = gm
    finally:
        # ---------- teardown (always)
        try:
            q("update scheduled_emails set status='cancelled' where status in ('pending','sending') and dial_id in (select id from dials d where d.list_id in (select id from dial_lists where name like 'DELIV TEST %s%%'))" % SALT)
            q("delete from app_secrets where key='test_send_now'")
            q("update dial_lists set send_paused_reason=null where send_paused_reason='deliv-test isolation'")
            q("update email_accounts set send_paused_reason=null where send_paused_reason='deliv test'")
            q("select cron.alter_job(job_id := (select jobid from cron.job where jobname='sequence-dispatch'), active := false)")
            secret([("TEST_REDIRECT_TO", ",".join(MASON))])
            OUT["teardown"] = q("select (select count(*) from scheduled_emails where status in ('pending','sending') and send_at > now() - interval '1 day') pending_sends, (select active from cron.job where jobname='sequence-dispatch') seq_cron_active, (select count(*) from app_secrets where key='test_send_now') flag_rows")
        except Exception as e: OUT["teardown_error"] = str(e)
        json.dump(OUT, open("/tmp/dv/thread_result.json", "w"), default=str, indent=1)
        print(json.dumps(OUT, default=str, indent=1)[:6000])

if __name__ == "__main__": main()
