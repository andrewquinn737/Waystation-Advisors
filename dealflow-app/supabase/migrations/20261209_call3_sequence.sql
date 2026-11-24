-- 3-step call sequence (Mason, 2026-11-24).
-- A phone-only lead (no email address) that gets "No answer" is followed up by phone:
--   callback 1 two business days after the call (owner's mobile),
--   callback 2 four business days after the call (mobile and the company line),
--   then the lead shows under "Finished sequence".
-- The 5-step email sequence now runs only for lists whose owner has a mailbox (interns: a Working Signal one).

alter table public.dials drop constraint if exists dials_sequence_check;
alter table public.dials add constraint dials_sequence_check check (sequence is null or sequence in ('email5', 'backup', 'call3'));

create or replace function public.seq_steps(p_sequence text)
 returns table(step integer, seq_day integer, kind text) language sql immutable as $$
  select v.step, v.seq_day, v.kind from (values
    ('email5',1,1,'email'), ('email5',2,3,'call'), ('email5',3,3,'followup_email'),
    ('email5',4,4,'linkedin'), ('email5',5,5,'call'), ('email5',6,7,'call_company'),
    ('call3',1,3,'call'), ('call3',2,5,'call'), ('call3',3,5,'call_company')
  ) v(seq, step, seq_day, kind) where v.seq = p_sequence
$$;

-- Can this person run the 5-step email sequence? They need a mailbox they own; interns and independent leads need a
-- Working Signal one specifically.
create or replace function public.seq_can_email(p_owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from email_accounts a join profiles p on p.id = a.owner_id
     where a.owner_id = p_owner and not a.needs_assignment and coalesce(a.send_paused_reason, '') = ''
       and (p.role not in ('intern', 'independent_lead') or lower(split_part(a.email_address, '@', 2)) like '%signal%'))
$$;
revoke all on function public.seq_can_email(uuid) from public, anon;
grant execute on function public.seq_can_email(uuid) to authenticated, service_role;

-- Start the call sequence for one lead. p_day0 = the day of the unanswered call. A step that would already be in the
-- past is due today instead (and the next one two business days after it), so an old call doesn't pile up as overdue.
create or replace function public.seq_start_call3(p_dial uuid, p_day0 date) returns boolean
language plpgsql security definer set search_path = public as $$
declare d record; v_today date; v1 date; v2 date;
begin
  select id, list_id, created_by, sequence, seq_state into d from dials where id = p_dial;
  if d.id is null or coalesce(d.sequence, 'backup') <> 'backup' then return false; end if;
  v_today := person_today(d.created_by, now());
  v1 := greatest(seq_due(p_day0, 3), next_business_day(v_today));
  v2 := seq_due(v1, 3);
  update dials set sequence = 'call3', seq_state = 'active', seq_day0 = p_day0, seq_stop_reason = null where id = p_dial;
  insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on) values
    (d.id, d.list_id, d.created_by, 1, 3, 'call', v1),
    (d.id, d.list_id, d.created_by, 2, 5, 'call', v2),
    (d.id, d.list_id, d.created_by, 3, 5, 'call_company', v2)
  on conflict (dial_id, step) do nothing;
  return true;
end $$;
revoke all on function public.seq_start_call3(uuid, date) from public, anon, authenticated;
grant execute on function public.seq_start_call3(uuid, date) to service_role;

-- Going forward: the first "No answer" on a phone-only lead starts the call sequence.
create or replace function public.dials_call3_on_no_response() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.contact_status = 'no_response' and old.contact_status is distinct from 'no_response'
     and coalesce(new.sequence, 'backup') = 'backup'
     and (coalesce(nullif(btrim(new.mobile_phone), ''), nullif(btrim(new.company_phone), '')) is not null)
     and coalesce(btrim(new.email), '') = '' then
    perform seq_start_call3(new.id, person_today(new.created_by, now()));
  end if;
  return new;
end $$;
drop trigger if exists dials_call3_on_no_response on public.dials;
create trigger dials_call3_on_no_response after update of contact_status on public.dials
  for each row execute function public.dials_call3_on_no_response();

-- Prepare: personal-email leads go on the email sequence only when the list owner can email; everyone else is a call lead.
create or replace function public.seq_prepare_list(p_list_id uuid, p_limit integer default null::integer)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v_owner uuid; n_email int := 0; n_backup int := 0; n_nocopy int := 0; v_left int := 0; v_can boolean;
begin
  select created_by into v_owner from dial_lists where id = p_list_id;
  if v_owner is null then raise exception 'List not found'; end if;
  if auth.uid() is null or not coalesce(auth.uid() = v_owner or is_admin() or is_team_lead_of(v_owner), false) then
    raise exception 'No access to that list';
  end if;
  v_can := seq_can_email(v_owner);
  with todo as (select id, v_can and coalesce(is_personal_email(email), false) as pe from dials where list_id = p_list_id and sequence is null order by id limit p_limit),
  up as (
    update dials d set sequence = case when t.pe then 'email5' else 'backup' end,
                       seq_state = case when t.pe then 'awaiting_copy' else null end
      from todo t where d.id = t.id
    returning t.pe as pe, (coalesce(btrim(d.email_1),'') = '' or coalesce(btrim(d.email_subject),'') = '') as nocopy)
  select count(*) filter (where pe), count(*) filter (where not pe), count(*) filter (where pe and nocopy) into n_email, n_backup, n_nocopy from up;
  select count(*) into v_left from dials where list_id = p_list_id and sequence is null;
  update dial_lists set copy_status = 'pending_review'
   where id = p_list_id and copy_status = 'none'
     and exists (select 1 from dials where list_id = p_list_id and sequence = 'email5' and seq_state = 'awaiting_copy');
  return jsonb_build_object('email_sequence', n_email, 'backup', n_backup, 'call_sequence', n_backup, 'missing_copy', n_nocopy,
                            'remaining', v_left, 'can_email', v_can);
end $$;
