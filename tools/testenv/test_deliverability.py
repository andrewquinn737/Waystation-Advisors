"""Deliverability rules on the TEST project (no mail is sent): recipient-provider pacing for Microsoft-hosted recipients.
Run: python3 test_deliverability.py"""
import sb, uuid
q, lit = sb.test_sql, lambda v: "'" + str(v).replace("'", "''") + "'"
res = []
def check(n, c, d=""):
    res.append(bool(c)); print(("PASS " if c else "FAIL ") + n + ("" if c else f"  -> {d}"))
owner = q("select id from profiles limit 1")[0]["id"]; salt = uuid.uuid4().hex[:6]
A = q(f"""insert into email_accounts (owner_id,label,email_address,imap_host,smtp_host,username,password,source)
          values ('{owner}','TEST-TEMP-BOX','pace-a-{salt}@pace-{salt}.test','x','x','x','x','test') returning id""")[0]["id"]
B = q(f"""insert into email_accounts (owner_id,label,email_address,imap_host,smtp_host,username,password,source)
          values ('{owner}','TEST-TEMP-BOX','pace-b-{salt}@pace-{salt}.test','x','x','x','x','test') returning id""")[0]["id"]
def pace(acct, to): return q(f"select recipient_pacing('{acct}', {lit(to)}) r")[0]["r"]
def sent(acct, to, mins_ago):
    q(f"""insert into email_messages (account_id,message_id,direction,from_address,to_addresses,subject,body_text,sent_at)
          values ('{acct}','<{uuid.uuid4()}@pace.test>','outbound','x@pace.test',jsonb_build_array(jsonb_build_object('address', {lit(to)})),'s','b', now() - interval '{mins_ago} minutes')""")
try:
    q("delete from recipient_domains where domain like 'ms-%.test' or domain like 'g-%.test'")
    q(f"insert into recipient_domains (domain, provider) values ('ms-{salt}.test','microsoft'), ('g-{salt}.test','google')")
    q("delete from app_secrets where key in ('ms_daily_cap','ms_gap_minutes')")
    check("provider lookup", q(f"select recipient_provider('x@ms-{salt}.test') p, recipient_provider('x@nowhere-{salt}.test') u") == [{"p": "microsoft", "u": "unknown"}])
    check("non-Microsoft recipient is never paced", pace(A, f"x@g-{salt}.test")["ok"] is True)
    check("Microsoft recipient, nothing sent yet: ok", pace(A, f"x@ms-{salt}.test")["ok"] is True)
    sent(A, f"a@ms-{salt}.test", 3)
    r = pace(B, f"x@ms-{salt}.test")        # same sending domain, 3 minutes ago, gap is 10
    check("gap: same sending domain sent to Microsoft 3 min ago -> deferred", r["ok"] is False and r["why"] == "microsoft gap" and r["retry_at"], r)
    check("gap: Google recipient is not held by it", pace(B, f"x@g-{salt}.test")["ok"] is True)
    q(f"delete from email_messages where account_id in ('{A}','{B}')")
    for i in range(8): sent(A, f"p{i}@ms-{salt}.test", 60 + i * 30)
    r = pace(A, f"x@ms-{salt}.test")
    check("daily cap: 8 Microsoft sends in 24h -> deferred until the oldest ages out", r["ok"] is False and r["why"] == "microsoft daily cap", r)
    q("insert into app_secrets (key,value) values ('ms_daily_cap','20') on conflict (key) do update set value='20'")
    check("daily cap is tunable in app_secrets", pace(A, f"x@ms-{salt}.test")["ok"] is True)
finally:
    q("delete from app_secrets where key in ('ms_daily_cap','ms_gap_minutes')")
    q(f"delete from email_messages where account_id in ('{A}','{B}')")
    q(f"delete from email_accounts where id in ('{A}','{B}')")
    q("delete from recipient_domains where domain like 'ms-%.test' or domain like 'g-%.test'")
print(f"{sum(res)}/{len(res)} passed")
