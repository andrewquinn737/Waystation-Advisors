-- Every lead is on one track (Mason, 2026-11-24): the 5-step email sequence when it has a personal email AND its owner
-- has a mailbox to send from (interns: Working Signal); otherwise the 3-step call follow-up, which starts on the first
-- "No answer". Generic addresses (info@, office@) and leads whose owner has no mailbox are call leads.
create or replace function public.dials_call3_on_no_response() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.contact_status = 'no_response' and old.contact_status is distinct from 'no_response'
     and coalesce(new.sequence, 'backup') = 'backup'
     and (coalesce(nullif(btrim(new.mobile_phone), ''), nullif(btrim(new.company_phone), '')) is not null)
     and (new.sequence = 'backup'   -- already put on the call track (e.g. emailed elsewhere, or not an email lead)
          or coalesce(btrim(new.email), '') = '' or not coalesce(is_personal_email(new.email), false) or not seq_can_email(new.created_by)) then
    perform seq_start_call3(new.id, person_today(new.created_by, now()));
  end if;
  return new;
end $$;
