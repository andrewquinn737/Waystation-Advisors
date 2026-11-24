"""Warm leads (callback_interested / intro_call_scheduled) never count against or get blocked by the daily cap.
Runs entirely inside a DO block that always raises, so nothing it writes survives."""
import sb, re
SQL = r"""
do $$
declare acct uuid; owner uuid; lst uuid; d uuid; c0 record; c1 record; c2 record; blocked bool := false; i int;
begin
  select a.id, a.owner_id into acct, owner from email_accounts a join auth.users u on u.id = a.owner_id
   where u.email = 'test.caleb.hong@example.com' limit 1;
  update email_accounts set daily_send_limit = 2 where id = acct;
  select id into lst from dial_lists limit 1;
  insert into dials (list_id, company_name, email, contact_status) values (lst, 'HOTCAP_T', 'hotcap_t@example.com', 'callback_interested') returning id into d;
  select * into c0 from mailbox_send_counts(acct);
  -- fill the mailbox to its cap with cold sends (if not already over)
  for i in 1..greatest(0, c0.daily_limit - c0.sent - c0.scheduled) loop
    insert into scheduled_emails (created_by, account_id, to_address, subject, body_text, send_at, status)
    values (owner, acct, 'cold'||i||'@example.com', 's', 'b', now() + interval '1 day', 'pending');
  end loop;
  begin
    insert into scheduled_emails (created_by, account_id, to_address, subject, body_text, send_at, status)
    values (owner, acct, 'cold_over@example.com', 's', 'b', now() + interval '1 day', 'pending');
  exception when others then blocked := true; end;
  select * into c1 from mailbox_send_counts(acct);
  insert into scheduled_emails (created_by, account_id, dial_id, to_address, subject, body_text, send_at, status)
  values (owner, acct, d, 'HotCap_T@example.com', 's', 'b', now() + interval '1 day', 'pending');
  select * into c2 from mailbox_send_counts(acct);
  raise exception 'RESULT cold_blocked=% before=% after_hot=%', blocked, c1.scheduled, c2.scheduled;
end $$;
"""
try:
    sb.test_sql(SQL); raise SystemExit("FAIL: block did not raise")
except RuntimeError as e:
    m = re.search(r"RESULT cold_blocked=(\w+) before=(\d+) after_hot=(\d+)", str(e))
    assert m, str(e)[:500]
    assert m.group(1) in ("t", "true"), "cold send over the cap was not blocked"
    assert m.group(2) == m.group(3), "warm-lead send counted against the cap"
    print("PASS hot_cap: cold blocked at cap, warm send allowed and not counted")
