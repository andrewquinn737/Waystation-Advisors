"""Instantly check: a personal-email lead already in an Instantly campaign (same address, or same company domain) goes
to the call track at list prep, is blocked at start, and is moved to calls by the sync if it was waiting for copy.
Rollback-only (the DO block raises)."""
import sb
SQL = r"""
do $$
declare owner uuid; lst uuid; a uuid; b uuid; c uuid; w uuid; res jsonb; sa text; sb2 text; sc text; sw text; blk text; ap jsonb; n3 int;
begin
  select u.id into owner from auth.users u where u.email = 'test.caleb.hong@example.com';
  insert into email_accounts (owner_id, label, email_address, imap_host, smtp_host, username)
  values (owner, 'INST', 'inst-mbx@wsignal-insttest.com', 'imap.example.com', 'smtp.example.com', 'i1');
  insert into instantly_leads (email, domain, campaign) values ('owner@instchk-alpha.com', 'instchk-alpha.com', 'T');
  insert into dial_lists (name, created_by, dial_type, status) values ('INST_T', owner, 'seller', 'current') returning id into lst;
  insert into dials (list_id, created_by, company_name, mobile_phone, email, contact_status) values (lst, owner, 'A', '+15555550201', 'owner@instchk-alpha.com', 'uncontacted') returning id into a;
  insert into dials (list_id, created_by, company_name, mobile_phone, email, contact_status) values (lst, owner, 'B', '+15555550202', 'partner@instchk-alpha.com', 'uncontacted') returning id into b;
  insert into dials (list_id, created_by, company_name, mobile_phone, email, contact_status) values (lst, owner, 'C', '+15555550203', 'sam@instchk-gamma.com', 'uncontacted') returning id into c;
  perform set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated')::text, true);
  res := seq_prepare_list(lst, null);
  select sequence into sa from dials where id = a;
  select sequence into sb2 from dials where id = b;
  select sequence into sc from dials where id = c;
  -- c is waiting for copy; Instantly then emails it: the start check blocks it and the sync moves it to calls
  insert into instantly_leads (email, domain, campaign) values ('sam@instchk-gamma.com', 'instchk-gamma.com', 'T');
  blk := lead_block_reason(c);
  ap := instantly_apply('[{"email":"sam@instchk-gamma.com","campaign":"T"}]'::jsonb);
  select sequence into sw from dials where id = c;
  update dials set contact_status = 'no_response' where id = a;
  select count(*) into n3 from sequence_tasks where dial_id = a;
  raise exception 'RESULT same=% domain=% clean=% inst=% block=% moved=% after=% calls=%', sa, sb2, sc, res->>'already_in_instantly', blk, ap->>'moved_to_calls', sw, n3;
end $$;
"""
try:
    sb.test_sql(SQL); raise SystemExit("FAIL: block did not raise")
except RuntimeError as e:
    s = str(e); print(s[s.find("RESULT"):s.find("RESULT")+200])
    assert "same=backup " in s, "lead already in Instantly went on the 5-step"
    assert "domain=backup " in s, "lead at a company already in Instantly went on the 5-step"
    assert "clean=email5 " in s, "a clean lead was kept off the 5-step"
    assert "inst=2 " in s, "prep did not report the Instantly skips"
    assert "block=instantly " in s, "start check did not block an Instantly lead"
    assert "moved=1 " in s and "after=backup " in s, "sync did not move the waiting lead to calls"
    assert "calls=3" in s, "an Instantly lead did not get the call follow-up on No answer"
    print("PASS instantly check")
