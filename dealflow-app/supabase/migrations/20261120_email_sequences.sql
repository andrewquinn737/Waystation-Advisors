-- Email sequences, per-person mailboxes, and the daily task list.
-- Applied to the TEST project first. Idempotent (safe to re-run).
--
-- Sequences (business days, America/Denver; day 1 = the day the first email goes out):
--   email5: d1 email · d3 call · d3 follow-up email · d4 LinkedIn · d5 call · d7 company-line call
--   call3 : d1 call · d3 call · d5 company-line call           (rows with no usable email)
-- Copy is written offline and uploaded with the list (dials.email_subject/email_1/email_2);
-- the list owner approves it once (dial_lists.copy_status) before anything sends.

set check_function_bodies = off;

-- ---------------------------------------------------------------- mailboxes
alter table public.email_accounts
  add column if not exists daily_send_limit int,
  add column if not exists mandate text,
  add column if not exists send_route text not null default 'smtp',
  add column if not exists source text,
  add column if not exists needs_assignment boolean not null default false,
  add column if not exists suggested_owner_id uuid references public.profiles(id) on delete set null,
  add column if not exists credentials_verified boolean,
  add column if not exists send_paused_reason text;
do $$ begin
  alter table public.email_accounts add constraint email_accounts_mandate_check check (mandate is null or mandate in ('ma','data'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.email_accounts add constraint email_accounts_send_route_check check (send_route in ('smtp','oracle'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.email_accounts add constraint email_accounts_limit_check check (daily_send_limit is null or daily_send_limit between 0 and 200);
exception when duplicate_object then null; end $$;
create unique index if not exists email_accounts_address_uniq on public.email_accounts (lower(email_address));

-- The 3-mailbox cap is for mailboxes people connect themselves on their profile.
-- Admin-provisioned sending mailboxes (source set) don't count toward it.
create or replace function public.enforce_email_account_cap() returns trigger language plpgsql as $$
begin
  if new.source is null and (select count(*) from email_accounts where owner_id = new.owner_id and source is null) >= 3 then
    raise exception 'You can connect up to 3 email accounts.';
  end if;
  return new;
end $$;

-- per-mailbox cap (falls back to the global 25)
create or replace function public.mailbox_send_counts(p_account_id uuid)
 returns table(sent integer, scheduled integer, daily_limit integer)
 language sql security definer set search_path to 'public'
as $$
  select
    (select count(*)::int from email_messages m
      where m.account_id = p_account_id and m.direction = 'outbound' and m.sent_at > now() - interval '24 hours'),
    (select count(*)::int from scheduled_emails s
      where s.account_id = p_account_id and s.status in ('pending','sending')),
    coalesce((select a.daily_send_limit from email_accounts a where a.id = p_account_id), public.mailbox_daily_limit());
$$;

-- Leads can SEE (not send from) the mailboxes and mail of interns on their teams.
drop policy if exists email_accounts_select on public.email_accounts;
create policy email_accounts_select on public.email_accounts for select using (
  owner_id = auth.uid() or is_admin() or is_team_lead_of(owner_id)
  or exists (select 1 from profiles me join profiles tl on tl.id = email_accounts.owner_id
             where me.id = auth.uid() and me.role = 'intern' and tl.role = 'team_lead'
               and me.team_id = any (my_team_ids(tl.id))));
drop policy if exists email_messages_select on public.email_messages;
create policy email_messages_select on public.email_messages for select using (
  exists (select 1 from email_accounts ea where ea.id = email_messages.account_id
          and (ea.owner_id = auth.uid() or is_admin() or is_team_lead_of(ea.owner_id)))
  or exists (select 1 from clients c where c.id = email_messages.client_id
             and (c.created_by = auth.uid() or is_team_lead_of(c.created_by))));
drop policy if exists email_attachments_select on public.email_attachments;
create policy email_attachments_select on public.email_attachments for select using (
  exists (select 1 from email_messages em join email_accounts ea on ea.id = em.account_id
          where em.id = email_attachments.message_id
            and (ea.owner_id = auth.uid() or is_admin() or is_team_lead_of(ea.owner_id))));
-- scheduled sends of a lead's interns are visible to that lead
drop policy if exists scheduled_emails_select on public.scheduled_emails;
create policy scheduled_emails_select on public.scheduled_emails for select to authenticated using (
  created_by = auth.uid() or is_admin() or is_team_lead_of(created_by));

-- Name matching: "Jonah Johnson" / jonah.johnson@ -> the one profile with that full name.
create or replace function public.norm_person_name(t text) returns text language sql immutable as $$
  select nullif(regexp_replace(lower(coalesce(t,'')), '[^a-z]+', ' ', 'g'), ' ')
$$;
create or replace function public.match_mailbox_owner(p_display_name text, p_email text)
 returns uuid language plpgsql stable security definer set search_path to 'public'
as $$
declare cand text; hits uuid[];
begin
  foreach cand in array array[
      p_display_name,
      replace(replace(replace(split_part(coalesce(p_email,''), '@', 1), '.', ' '), '_', ' '), '-', ' ')]
  loop
    cand := btrim(norm_person_name(cand));
    continue when cand is null or cand = '' or position(' ' in cand) = 0;   -- first AND last required
    select array_agg(id) into hits from profiles where btrim(norm_person_name(full_name)) = cand;
    if array_length(hits, 1) = 1 then return hits[1]; end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------- lists + leads
alter table public.dial_lists
  add column if not exists mandate text,
  add column if not exists copy_status text not null default 'none',
  add column if not exists copy_approved_at timestamptz,
  add column if not exists copy_approved_by uuid references public.profiles(id) on delete set null;
do $$ begin
  alter table public.dial_lists add constraint dial_lists_mandate_check check (mandate is null or mandate in ('ma','data'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.dial_lists add constraint dial_lists_copy_status_check check (copy_status in ('none','pending_review','approved'));
exception when duplicate_object then null; end $$;

alter table public.dials
  add column if not exists sequence text,
  add column if not exists seq_state text,
  add column if not exists seq_day0 date,
  add column if not exists sender_account_id uuid references public.email_accounts(id) on delete set null,
  add column if not exists email_1_message_id text,
  add column if not exists email_1_thread_id uuid,
  add column if not exists seq_stop_reason text;
do $$ begin
  alter table public.dials add constraint dials_sequence_check check (sequence is null or sequence in ('email5','call3'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.dials add constraint dials_seq_state_check check (seq_state is null or seq_state in ('awaiting_copy','active','replied','bounced','stopped','completed'));
exception when duplicate_object then null; end $$;
create index if not exists dials_email_lower_idx on public.dials (lower(email)) where email is not null;

alter table public.scheduled_emails add column if not exists sent_message_id uuid references public.email_messages(id) on delete set null;

-- ---------------------------------------------------------------- tasks
create table if not exists public.sequence_tasks (
  id uuid primary key default gen_random_uuid(),
  dial_id uuid not null references public.dials(id) on delete cascade,
  list_id uuid not null references public.dial_lists(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  step int not null,
  seq_day int not null,
  kind text not null check (kind in ('email','followup_email','call','linkedin','call_company','reply')),
  due_on date not null,
  status text not null default 'pending' check (status in ('pending','queued','done','skipped','cancelled','failed')),
  scheduled_email_id uuid references public.scheduled_emails(id) on delete set null,
  outcome text,
  note text,
  completed_at timestamptz,
  completed_by uuid references public.profiles(id) on delete set null,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  unique (dial_id, step)
);
create index if not exists sequence_tasks_owner_due_idx on public.sequence_tasks (owner_id, due_on) where status in ('pending','queued');
create index if not exists sequence_tasks_dispatch_idx on public.sequence_tasks (owner_id, due_on) where status = 'pending' and kind in ('email','followup_email');
drop index if exists public.sequence_tasks_dispatch_idx_old;
alter table public.sequence_tasks enable row level security;
drop policy if exists sequence_tasks_select on public.sequence_tasks;
create policy sequence_tasks_select on public.sequence_tasks for select using (owner_id = auth.uid() or is_admin() or is_team_lead_of(owner_id));
revoke all on public.sequence_tasks from anon, authenticated;
grant select on public.sequence_tasks to authenticated;
-- Interns change tasks only through complete_sequence_task(); no direct writes.

-- ---------------------------------------------------------------- calendar helpers
create or replace function public.denver_today() returns date language sql stable as $$
  select (now() at time zone 'America/Denver')::date $$;
create or replace function public.is_business_day(d date) returns boolean language sql immutable as $$
  select extract(isodow from d) < 6 $$;
create or replace function public.next_business_day(d date) returns date language sql immutable as $$
  select case extract(isodow from d) when 6 then d + 2 when 7 then d + 1 else d end $$;
-- day N of a sequence that starts on day0 (day 1 = day0), counting business days only
create or replace function public.seq_due(day0 date, n int) returns date language plpgsql immutable as $$
declare d date := public.next_business_day(day0); k int := 1;
begin
  while k < n loop d := d + 1; if public.is_business_day(d) then k := k + 1; end if; end loop;
  return d;
end $$;

create or replace function public.seq_steps(p_sequence text)
 returns table(step int, seq_day int, kind text) language sql immutable as $$
  select v.step, v.seq_day, v.kind from (values
    ('email5',1,1,'email'), ('email5',2,3,'call'), ('email5',3,3,'followup_email'),
    ('email5',4,4,'linkedin'), ('email5',5,5,'call'), ('email5',6,7,'call_company'),
    ('call3',1,1,'call'), ('call3',2,3,'call'), ('call3',3,5,'call_company')
  ) v(seq, step, seq_day, kind) where v.seq = p_sequence
$$;

-- Generic/role inboxes never get cold email (DATA_PLAYBOOK 10.5.2): they go to the call track.
create or replace function public.is_personal_email(e text) returns boolean language sql immutable as $$
  select e ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'
     and split_part(lower(e), '@', 1) !~ '^(info|sales|office|admin|support|contact|hello|team|service|services|help|billing|accounts?|hr|jobs|careers|marketing|mail|enquiries|inquiries|reception|frontdesk|noreply|no-reply|webmaster|orders?)$'
$$;

-- (Re)build the pending tasks of one lead from its day0. Done/queued tasks are kept.
create or replace function public.seq_build_tasks(p_dial_id uuid) returns void
 language plpgsql security definer set search_path to 'public' as $$
declare d record; s record;
begin
  select id, list_id, created_by, sequence, seq_day0 into d from dials where id = p_dial_id;
  if d.sequence is null or d.seq_day0 is null then return; end if;
  for s in select * from seq_steps(d.sequence) loop
    insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on)
    values (d.id, d.list_id, d.created_by, s.step, s.seq_day, s.kind, seq_due(d.seq_day0, s.seq_day))
    on conflict (dial_id, step) do update
      set due_on = excluded.due_on, owner_id = excluded.owner_id
      where sequence_tasks.status = 'pending';
  end loop;
end $$;

-- ---------------------------------------------------------------- start / approve
-- Classify every row of a list and start what can start. Safe to call repeatedly.
create or replace function public.seq_prepare_list(p_list_id uuid) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid; n_email int := 0; n_call int := 0; n_nocopy int := 0; r record; v_today date := denver_today();
begin
  select created_by into v_owner from dial_lists where id = p_list_id;
  if v_owner is null then raise exception 'List not found'; end if;
  if auth.uid() is not null and not (auth.uid() = v_owner or is_admin() or is_team_lead_of(v_owner)) then
    raise exception 'No access to that list';
  end if;
  for r in select * from dials where list_id = p_list_id and sequence is null loop
    if is_personal_email(r.email) then
      update dials set sequence = 'email5', seq_state = 'awaiting_copy' where id = r.id;
      n_email := n_email + 1;
      if coalesce(btrim(r.email_1),'') = '' or coalesce(btrim(r.email_subject),'') = '' then n_nocopy := n_nocopy + 1; end if;
    else
      -- no usable email: calling starts today
      update dials set sequence = 'call3', seq_state = 'active', seq_day0 = next_business_day(v_today) where id = r.id;
      perform seq_build_tasks(r.id);
      n_call := n_call + 1;
    end if;
  end loop;
  update dial_lists set copy_status = 'pending_review'
   where id = p_list_id and copy_status = 'none'
     and exists (select 1 from dials where list_id = p_list_id and sequence = 'email5' and seq_state = 'awaiting_copy');
  return jsonb_build_object('email_sequence', n_email, 'call_sequence', n_call, 'missing_copy', n_nocopy);
end $$;

-- Pick the sender for a lead: one of the list owner's enabled mailboxes for this mandate,
-- least used in the last 24h. Sticky once chosen (follow-up threads from the same box).
create or replace function public.seq_pick_sender(p_owner uuid, p_mandate text) returns uuid
 language sql stable security definer set search_path to 'public' as $$
  select a.id from email_accounts a
   where a.owner_id = p_owner and coalesce(a.send_paused_reason,'') = '' and not a.needs_assignment
     and (p_mandate is null or a.mandate is null or a.mandate = p_mandate)
   order by (select count(*) from email_messages m where m.account_id = a.id and m.direction='outbound' and m.sent_at > now() - interval '24 hours')
          + (select count(*) from scheduled_emails s where s.account_id = a.id and s.status in ('pending','sending')),
            a.email_address
   limit 1
$$;

-- The list owner (or their lead/admin) approves the uploaded copy once; sequences start.
create or replace function public.approve_list_copy(p_list_id uuid) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_list record; n int := 0; n_skip int := 0; r record; v_day0 date; v_boxes int;
begin
  select * into v_list from dial_lists where id = p_list_id;
  if v_list is null then raise exception 'List not found'; end if;
  if not (auth.uid() = v_list.created_by or is_admin() or is_team_lead_of(v_list.created_by)) then
    raise exception 'Only the list owner, their team lead, or an admin can approve this copy';
  end if;
  select count(*) into v_boxes from email_accounts a
   where a.owner_id = v_list.created_by and not a.needs_assignment and coalesce(a.send_paused_reason,'') = ''
     and (v_list.mandate is null or a.mandate is null or a.mandate = v_list.mandate);
  if v_boxes = 0 then
    raise exception 'The list owner has no sending mailbox for this kind of outreach yet. Ask an admin to assign one.';
  end if;
  -- first email goes out today if it's a business day before 3pm MT, else the next business day
  v_day0 := case when is_business_day(denver_today()) and extract(hour from now() at time zone 'America/Denver') < 15
                 then denver_today() else next_business_day(denver_today() + 1) end;
  for r in select * from dials where list_id = p_list_id and sequence = 'email5' and seq_state = 'awaiting_copy' loop
    if coalesce(btrim(r.email_1),'') = '' or coalesce(btrim(r.email_subject),'') = '' or coalesce(btrim(r.email_2),'') = '' then
      n_skip := n_skip + 1; continue;   -- stays awaiting_copy; shows as "missing copy"
    end if;
    update dials set seq_state = 'active', seq_day0 = v_day0 where id = r.id;   -- sender picked at send time
    perform seq_build_tasks(r.id);
    n := n + 1;
  end loop;
  update dial_lists set copy_status = 'approved', copy_approved_at = now(), copy_approved_by = auth.uid() where id = p_list_id;
  return jsonb_build_object('started', n, 'missing_copy', n_skip, 'first_send_day', v_day0, 'mailboxes', v_boxes,
                            'daily_capacity', (select coalesce(sum(coalesce(daily_send_limit, mailbox_daily_limit())),0) from email_accounts a
                               where a.owner_id = v_list.created_by and not a.needs_assignment and coalesce(a.send_paused_reason,'') = ''
                                 and (v_list.mandate is null or a.mandate is null or a.mandate = v_list.mandate)));
end $$;

-- ---------------------------------------------------------------- intern actions
create or replace function public.complete_sequence_task(p_task_id uuid, p_outcome text default null, p_note text default null, p_skip boolean default false)
 returns void language plpgsql security definer set search_path to 'public' as $$
declare t record;
begin
  select * into t from sequence_tasks where id = p_task_id for update;
  if t is null then raise exception 'Task not found'; end if;
  if not (auth.uid() = t.owner_id or is_admin() or is_team_lead_of(t.owner_id)) then raise exception 'Not your task'; end if;
  if t.kind in ('email','followup_email') then raise exception 'Emails send automatically'; end if;
  if t.status not in ('pending','failed') then return; end if;  -- double-click safe
  update sequence_tasks set status = case when p_skip then 'skipped' else 'done' end,
         outcome = p_outcome, note = nullif(btrim(coalesce(p_note,'')),''), completed_at = now(), completed_by = auth.uid()
   where id = p_task_id;
  perform seq_maybe_complete(t.dial_id);
end $$;

create or replace function public.seq_maybe_complete(p_dial_id uuid) returns void
 language sql security definer set search_path to 'public' as $$
  update dials set seq_state = 'completed'
   where id = p_dial_id and seq_state = 'active'
     and not exists (select 1 from sequence_tasks where dial_id = p_dial_id and status in ('pending','queued','failed'));
$$;

-- Stop a lead's remaining automation (reply, bounce, terminal call outcome, manual stop).
create or replace function public.seq_stop(p_dial_id uuid, p_state text, p_reason text, p_cancel_calls boolean)
 returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update dials set seq_state = p_state, seq_stop_reason = p_reason
   where id = p_dial_id and seq_state in ('active','awaiting_copy');
  if not found then return; end if;
  update scheduled_emails s set status = 'cancelled', error = 'Sequence stopped: ' || p_reason
    from sequence_tasks t where t.dial_id = p_dial_id and t.scheduled_email_id = s.id and s.status = 'pending';
  update sequence_tasks set status = 'cancelled', last_error = p_reason
   where dial_id = p_dial_id and status in ('pending','queued','failed')
     and (p_cancel_calls or kind in ('email','followup_email'));
end $$;

create or replace function public.stop_sequence(p_dial_id uuid, p_reason text default 'Stopped by user')
 returns void language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid;
begin
  select created_by into v_owner from dials where id = p_dial_id;
  if not (auth.uid() = v_owner or is_admin() or is_team_lead_of(v_owner)) then raise exception 'Not your lead'; end if;
  perform seq_stop(p_dial_id, 'stopped', p_reason, true);
end $$;

-- A final call outcome ends the sequence (they talked to the owner).
create or replace function public.dials_seq_on_status() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
begin
  if new.seq_state = 'active' and new.contact_status is distinct from old.contact_status
     and new.contact_status in ('not_interested','callback_interested','intro_call_scheduled') then
    perform seq_stop(new.id, 'completed', 'Call outcome: ' || new.contact_status, true);
  end if;
  return new;
end $$;
drop trigger if exists dials_seq_on_status on public.dials;
create trigger dials_seq_on_status after update of contact_status on public.dials
  for each row execute function public.dials_seq_on_status();

-- ---------------------------------------------------------------- auto-send
-- Every 5 min: queue due email steps inside the send window (weekdays 8:00-17:00 Denver).
-- At most one queued send per mailbox per run, so sends trickle out (no bursts).
drop function if exists public.sequence_dispatch();
-- Every 5 min: for each sending mailbox with room today, queue ONE due email step of its owner
-- (follow-ups first, they are time-sensitive). First emails take whichever of the owner's eligible
-- mailboxes has room; after that the lead is pinned to that mailbox so the follow-up threads.
-- Send window: weekdays 8:00-17:00 Denver.
create or replace function public.sequence_dispatch(p_now timestamptz default now()) returns int
 language plpgsql security definer set search_path to 'public' as $$
declare m record; t record; n int := 0; v_now_den timestamp := p_now at time zone 'America/Denver';
  v_today date := (p_now at time zone 'America/Denver')::date; v_subject text; v_body text; v_sid uuid;
begin
  if not is_business_day(v_today) or extract(hour from v_now_den) < 8 or extract(hour from v_now_den) >= 17 then
    return 0;
  end if;
  for m in
    select a.id, a.owner_id, a.mandate, c.sent + c.scheduled as used, c.daily_limit,
           (a.sync_enabled and a.last_synced_at > p_now - interval '2 hours' and coalesce(a.last_sync_error,'') = '') as inbox_ok
      from email_accounts a cross join lateral mailbox_send_counts(a.id) c
     where not a.needs_assignment and coalesce(a.send_paused_reason,'') = ''
       and c.sent + c.scheduled < c.daily_limit
       and exists (select 1 from sequence_tasks st where st.owner_id = a.owner_id and st.status = 'pending'
                     and st.kind in ('email','followup_email') and st.due_on <= v_today)
     order by c.sent + c.scheduled, a.id
  loop
    select st.id, st.kind, st.dial_id, d.email, d.full_name, d.email_subject, d.email_1, d.email_2,
           d.email_1_message_id, d.email_1_thread_id, d.created_by as dial_owner
      into t
      from sequence_tasks st join dials d on d.id = st.dial_id join dial_lists l on l.id = st.list_id
     where st.owner_id = m.owner_id and st.status = 'pending' and st.kind in ('email','followup_email')
       and st.due_on <= v_today and d.seq_state = 'active' and l.copy_status = 'approved' and l.deleted_at is null
       -- only text the server-side copy gate passed, unchanged since (columns from 20261121_copy_gate.sql)
       and d.copy_ok and d.copy_hash = md5(coalesce(d.email_subject,'') || chr(30) || coalesce(d.email_1,'') || chr(30) || coalesce(d.email_2,''))
       and (l.mandate is null or m.mandate is null or l.mandate = m.mandate)
       -- a follow-up only goes out if this mailbox's inbox is being read (otherwise a reply could be missed)
       and ( (st.kind = 'followup_email' and d.sender_account_id = m.id and d.email_1_message_id is not null and m.inbox_ok)
          or (st.kind = 'email' and (d.sender_account_id is null or d.sender_account_id = m.id)) )
     order by (st.kind = 'followup_email') desc, st.due_on, st.step, st.created_at
     limit 1
     for update of st skip locked;
    continue when t.id is null;
    if t.kind = 'email' then
      v_subject := t.email_subject; v_body := t.email_1;
      update dials set sender_account_id = m.id where id = t.dial_id and sender_account_id is null;
    else
      v_subject := case when t.email_subject ~* '^re:' then t.email_subject else 'Re: ' || t.email_subject end;
      v_body := t.email_2;
    end if;
    insert into scheduled_emails (created_by, account_id, dial_id, recipient_name, to_address, subject, body_text,
                                  in_reply_to, thread_id, send_at, status)
    values (t.dial_owner, m.id, t.dial_id, t.full_name, t.email, v_subject, v_body,
            case when t.kind = 'followup_email' then t.email_1_message_id end,
            case when t.kind = 'followup_email' then t.email_1_thread_id end,
            p_now + make_interval(secs => floor(random() * 240)::int), 'pending')
    returning id into v_sid;
    update sequence_tasks set status = 'queued', scheduled_email_id = v_sid, attempts = attempts + 1 where id = t.id;
    n := n + 1;
    t := null;
  end loop;
  return n;
end $$;

-- scheduled send finished -> update the task; first email sent -> re-base the sequence
create or replace function public.scheduled_emails_seq_sync() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare t record; m record; v_sent_day date;
begin
  if new.status is not distinct from old.status then return new; end if;
  select * into t from sequence_tasks where scheduled_email_id = new.id;
  if t is null then return new; end if;
  if new.status = 'sent' then
    update sequence_tasks set status = 'done', completed_at = coalesce(new.sent_at, now()) where id = t.id;
    if t.kind = 'email' then
      select message_id, thread_id into m from email_messages where id = new.sent_message_id;
      v_sent_day := (coalesce(new.sent_at, now()) at time zone 'America/Denver')::date;
      update dials set email_1_message_id = m.message_id, email_1_thread_id = m.thread_id,
                       seq_day0 = v_sent_day
       where id = t.dial_id;
      perform seq_build_tasks(t.dial_id);   -- later steps count from the real send day
    end if;
    perform seq_maybe_complete(t.dial_id);
  elsif new.status = 'failed' then
    if coalesce(new.error,'') ~* 'daily limit' then
      update sequence_tasks set status = 'pending', scheduled_email_id = null, last_error = new.error where id = t.id;
    elsif t.attempts >= 3 then
      update sequence_tasks set status = 'failed', last_error = new.error where id = t.id;
    else
      update sequence_tasks set status = 'pending', scheduled_email_id = null, last_error = new.error where id = t.id;
    end if;
  elsif new.status = 'cancelled' and t.status = 'queued' then
    update sequence_tasks set status = 'cancelled', last_error = new.error where id = t.id;
  end if;
  return new;
end $$;
drop trigger if exists scheduled_emails_seq_sync on public.scheduled_emails;
create trigger scheduled_emails_seq_sync after update of status on public.scheduled_emails
  for each row execute function public.scheduled_emails_seq_sync();

-- inbound mail: a reply from the lead stops the emails (calls stay so they ring back);
-- a bounce naming the lead's address stops emails and leaves the call steps.
create or replace function public.email_inbound_seq_check() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare d record; v_from text := lower(coalesce(new.from_address,'')); v_owner uuid;
begin
  if new.direction is distinct from 'inbound' then return new; end if;
  if v_from ~ '^(mailer-daemon|postmaster|mail-daemon)@' or coalesce(new.subject,'') ~* '(undeliver|delivery status notification|delivery has failed|returned mail|failure notice)' then
    for d in select id from dials where seq_state = 'active' and email is not null
               and position(lower(email) in lower(coalesce(new.body_text,'') || ' ' || coalesce(new.subject,''))) > 0
               and sender_account_id = new.account_id loop
      perform seq_stop(d.id, 'bounced', 'Email bounced', false);
    end loop;
    return new;
  end if;
  for d in select id, created_by, list_id from dials where lower(email) = v_from and seq_state = 'active' loop
    perform seq_stop(d.id, 'replied', 'Owner replied by email', false);
    insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on)
    values (d.id, d.list_id, d.created_by, 100, 0, 'reply', denver_today())
    on conflict (dial_id, step) do nothing;
  end loop;
  return new;
end $$;
drop trigger if exists email_inbound_seq_check on public.email_messages;
create trigger email_inbound_seq_check after insert on public.email_messages
  for each row execute function public.email_inbound_seq_check();

-- ---------------------------------------------------------------- read models
create or replace view public.my_tasks with (security_invoker = true) as
  select t.id, t.dial_id, t.list_id, t.owner_id, t.step, t.seq_day, t.kind, t.due_on, t.status, t.outcome, t.note,
         t.completed_at, t.last_error, t.scheduled_email_id,
         d.company_name, d.full_name, d.email, d.mobile_phone, d.company_phone, d.linkedin, d.city, d.state,
         d.website, d.contact_status, d.sequence, d.seq_state, d.industry,
         l.name as list_name, l.copy_status, p.full_name as owner_name,
         s.status as email_status, s.send_at as email_send_at, s.sent_at as email_sent_at, s.error as email_error,
         a.email_address as sender_address
    from sequence_tasks t
    join dials d on d.id = t.dial_id
    join dial_lists l on l.id = t.list_id
    join profiles p on p.id = t.owner_id
    left join scheduled_emails s on s.id = t.scheduled_email_id
    left join email_accounts a on a.id = d.sender_account_id;
revoke all on public.my_tasks from anon, authenticated;
grant select on public.my_tasks to authenticated;
-- email_accounts uses column-level grants (password is never readable); expose the new non-secret columns
grant select (daily_send_limit, mandate, send_route, source, needs_assignment, suggested_owner_id, credentials_verified, send_paused_reason)
  on public.email_accounts to authenticated;
grant select (sent_message_id) on public.scheduled_emails to authenticated;

grant execute on function public.seq_prepare_list(uuid), public.approve_list_copy(uuid),
  public.complete_sequence_task(uuid, text, text, boolean), public.stop_sequence(uuid, text),
  public.match_mailbox_owner(text, text) to authenticated;
revoke execute on function public.sequence_dispatch(timestamptz), public.seq_stop(uuid, text, text, boolean),
  public.seq_build_tasks(uuid) from public, anon, authenticated;

-- cron (test project): dispatcher every 5 minutes
select cron.unschedule(jobid) from cron.job where jobname = 'sequence-dispatch';
select cron.schedule('sequence-dispatch', '*/5 * * * *', 'select public.sequence_dispatch()');
