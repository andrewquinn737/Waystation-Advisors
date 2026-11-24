"""3-step call sequence: a phone-only lead marked No answer gets callback 1 (+2 business days) and callback 2 (mobile +
company line, +4), stops on a final outcome, and finishes when the steps are done. Rollback-only (the DO block raises)."""
import sb, re
SQL = r"""
do $$
declare owner uuid; lst uuid; d1 uuid; d2 uuid; d3 uuid; n1 int; k text; due1 date; due2 date; st text; st2 text; n2 int; can boolean; t uuid;
begin
  select u.id into owner from auth.users u where u.email = 'test.caleb.hong@example.com';
  insert into dial_lists (name, created_by, dial_type, status) values ('CALL3_T', owner, 'seller', 'current') returning id into lst;
  insert into dials (list_id, created_by, company_name, mobile_phone, contact_status) values (lst, owner, 'CALL3_A', '+15555550101', 'uncontacted') returning id into d1;
  insert into dials (list_id, created_by, company_name, mobile_phone, email, contact_status) values (lst, owner, 'CALL3_B', '+15555550102', 'owner@call3b.example.com', 'uncontacted') returning id into d2;
  insert into dials (list_id, created_by, company_name, mobile_phone, contact_status) values (lst, owner, 'CALL3_C', '+15555550103', 'uncontacted') returning id into d3;
  update dials set contact_status = 'no_response' where id in (d1, d2, d3);
  select count(*), string_agg(kind || '@' || due_on, ',' order by step) into n1, k from sequence_tasks where dial_id = d1;
  select min(due_on) filter (where step = 1), min(due_on) filter (where step = 2) into due1, due2 from sequence_tasks where dial_id = d1;
  select count(*) into n2 from sequence_tasks where dial_id = d2;
  -- a final outcome stops it
  update dials set contact_status = 'not_interested' where id = d3;
  select seq_state into st2 from dials where id = d3;
  -- finishing every step completes it
  update sequence_tasks set status = 'done' where dial_id = d1;
  perform seq_maybe_complete(d1);
  select seq_state into st from dials where id = d1;
  raise exception 'RESULT n=% kinds=% d1=% d2=% today=% email_lead_tasks=% stopped=% finished=%',
    n1, k, due1, due2, person_today(owner, now()), n2, st2, st;
end $$;
"""
try:
    sb.test_sql(SQL); raise SystemExit("FAIL: block did not raise")
except RuntimeError as e:
    s = str(e); m = re.search(r"RESULT (.*?)\\n|RESULT (.*)", s); print(s[s.find("RESULT"):s.find("RESULT")+220])
    assert "n=3 " in s and "kinds=call@" in s and ",call_company@" in s, "phone-only lead did not get 3 call tasks"
    assert "email_lead_tasks=0" in s, "a lead with an email was put on the call sequence"
    assert "stopped=completed" in s, "Not interested did not stop the sequence"
    assert "finished=completed" in s, "sequence did not finish after its steps"
    print("PASS call3")
