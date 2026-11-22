-- Round 2 page-by-page review fixes (TEST first; idempotent).
-- 1. seq_prepare_list is set-based and chunked (the old row-by-row loop timed out at the 8 s API limit on 10,000 rows).
-- 2. Admin Campaigns "Contacted" = companies emailed (a first email really went out, email_1_message_id set).
-- 3. A sent first email whose message row is not linked still sets email_1_message_id (looked up by schedule id) so follow-ups thread.
set check_function_bodies = off;

-- ---------------------------------------------------------------- 1. sequence setup, set-based + chunked
drop function if exists public.seq_prepare_list(uuid);
create or replace function public.seq_prepare_list(p_list_id uuid, p_limit int default null) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid; n_email int := 0; n_backup int := 0; n_nocopy int := 0; v_left int := 0;
begin
  select created_by into v_owner from dial_lists where id = p_list_id;
  if v_owner is null then raise exception 'List not found'; end if;
  if auth.uid() is null or not coalesce(auth.uid() = v_owner or is_admin() or is_team_lead_of(v_owner), false) then
    raise exception 'No access to that list';
  end if;
  with todo as (select id, coalesce(is_personal_email(email), false) as pe from dials where list_id = p_list_id and sequence is null order by id limit p_limit),
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
  return jsonb_build_object('email_sequence', n_email, 'backup', n_backup, 'call_sequence', n_backup, 'missing_copy', n_nocopy, 'remaining', v_left);
end $$;
revoke all on function public.seq_prepare_list(uuid, int) from public, anon;
grant execute on function public.seq_prepare_list(uuid, int) to authenticated;

-- ---------------------------------------------------------------- 2. admin_campaigns: Contacted = companies emailed
create or replace function public.admin_campaigns(p_fresh boolean default true) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v jsonb;
begin
  if not coalesce(is_admin(), false) then raise exception 'Admins only'; end if;
  if coalesce(p_fresh, true) then perform campaign_refresh(null); end if;   -- the page asks for p_fresh := false first (cached, fast), then true in the background
  select coalesce(jsonb_agg(to_jsonb(x) order by x.rank, x.created_at desc), '[]') into v from (
    select c.id, c.list_id, c.name, c.mandate, c.status, c.paused_reason, c.launched_at, c.created_at, p.full_name as owner, l.created_by as owner_id,
           (c.spintax is not null) as has_spintax, coalesce((c.spintax->>'version')::int, 0) as spintax_version, c.variant_stats,
           case c.status when 'ready' then 0 when 'live' then 1 when 'paused' then 2 when 'draft' then 3 else 4 end as rank,
           (select count(*) from owner_eligible_mailboxes(l.created_by, l.mandate)) as mailboxes,
           jsonb_build_object(
             'leads', count(d.id) filter (where d.sequence = 'email5'),
             'ready', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
             'need_fix', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and not (d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2))),
             'active', count(*) filter (where d.seq_state = 'active'),
             'sent_first', count(*) filter (where d.email_1_message_id is not null),
             'replied', count(*) filter (where d.seq_state = 'replied'),
             'bounced', count(*) filter (where d.seq_state = 'bounced'),
             'backup', count(*) filter (where d.sequence = 'backup'),
             'emails_sent', (select count(*) from scheduled_emails s join dials sd on sd.id = s.dial_id where sd.list_id = c.list_id and s.status = 'sent'),
             'contacted', count(*) filter (where d.email_1_message_id is not null),
             'interested', count(*) filter (where d.sequence = 'email5' and d.contact_status in ('callback_interested','intro_call_scheduled')),
             'intro_calls', count(*) filter (where d.sequence = 'email5' and d.contact_status = 'intro_call_scheduled')) as counts
      from campaigns c join dial_lists l on l.id = c.list_id and l.deleted_at is null
      left join profiles p on p.id = l.created_by left join dials d on d.list_id = l.id
     group by c.id, p.full_name, l.created_by, l.mandate
     limit 200) x;
  return v;
end $$;
revoke all on function public.admin_campaigns(boolean) from public, anon;
grant execute on function public.admin_campaigns(boolean) to authenticated;

-- ---------------------------------------------------------------- 3. first-email threading fallback
create or replace function public.scheduled_emails_seq_sync() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare t record; m record; v_sent_day date; v_owner uuid;
begin
  if new.status is not distinct from old.status then return new; end if;
  select * into t from sequence_tasks where scheduled_email_id = new.id;
  if t is null then return new; end if;
  if new.status = 'sent' then
    update sequence_tasks set status = 'done', completed_at = coalesce(new.sent_at, now()) where id = t.id;
    if t.kind = 'email' then
      select message_id, thread_id into m from email_messages where id = new.sent_message_id;
      if m.message_id is null then   -- the sent-message row is missing or not linked: find it by the schedule id so follow-ups still thread
        select message_id, thread_id into m from email_messages where scheduled_id = new.id and direction = 'outbound' order by created_at limit 1;
      end if;
      select created_by into v_owner from dials where id = t.dial_id;
      v_sent_day := (coalesce(new.sent_at, now()) at time zone person_tz(v_owner))::date;
      update dials set email_1_message_id = m.message_id, email_1_thread_id = m.thread_id, seq_day0 = v_sent_day where id = t.dial_id;
      perform seq_build_tasks(t.dial_id);
    end if;
    perform seq_maybe_complete(t.dial_id);
  elsif new.status = 'unknown' then
    -- the server may have accepted it: a human checks the Sent folder; no retry (a retry could double-send)
    update sequence_tasks set status = 'failed', last_error = 'Send result unknown — check Sent folder' where id = t.id;
  elsif new.status = 'failed' then
    if coalesce(new.error,'') ~* '^(daily limit|mailbox paused|login failed)' or coalesce(new.error,'') ~* 'daily limit' then
      -- not the lead's fault: back to pending without using up an attempt
      update sequence_tasks set status = 'pending', scheduled_email_id = null, last_error = new.error,
             attempts = greatest(0, attempts - 1) where id = t.id;
      if t.kind = 'email' then update dials set sender_account_id = null where id = t.dial_id and email_1_message_id is null; end if;
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

-- Backfill: sent first emails that never got their message id
update dials d set email_1_message_id = m.message_id, email_1_thread_id = coalesce(d.email_1_thread_id, m.thread_id)
  from sequence_tasks t join scheduled_emails s on s.id = t.scheduled_email_id and s.status = 'sent'
  join email_messages m on m.scheduled_id = s.id and m.direction = 'outbound' and m.message_id is not null
 where t.dial_id = d.id and t.kind = 'email' and d.email_1_message_id is null;

-- ---------------------------------------------------------------- 4. Import: does the person getting this list have a mailbox that can send it?
create or replace function public.owner_mailbox_count(p_owner uuid, p_mandate text) returns int
 language plpgsql stable security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or not (is_admin() or exists (select 1 from profiles where id = auth.uid() and role = 'team_lead')) then
    raise exception 'Only admins and team leads can check mailboxes';
  end if;
  return (select count(*)::int from owner_eligible_mailboxes(p_owner, p_mandate));
end $$;
revoke all on function public.owner_mailbox_count(uuid, text) from public, anon;
grant execute on function public.owner_mailbox_count(uuid, text) to authenticated;

-- ---------------------------------------------------------------- 5. Move targets the NEAREST upcoming pending intro call
create or replace function public.set_intro_call_time(p_client_id uuid, p_dial_id uuid, p_event_date timestamptz, p_time text, p_timezone text,
                                                     p_via text default 'calendly', p_past_ok boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_client uuid := p_client_id; v_event uuid; v_creator uuid; v_name text; v_who text; r record; v_tz text; v_when text; v_was_pending boolean;
begin
  if v_client is null and p_dial_id is not null then select id into v_client from clients where source_dial_id = p_dial_id; end if;
  if v_client is null then raise exception 'No client to attach the intro call to.'; end if;
  select created_by, full_name into v_creator, v_name from clients where id = v_client;
  if not (v_creator = auth.uid() or public.is_admin() or public.is_team_lead_of(v_creator)) then
    raise exception 'You can only schedule an intro call on a client you created.';
  end if;
  if p_event_date is null then raise exception 'Pick a date and time.'; end if;
  if p_event_date < now() - interval '5 minutes' and not coalesce(p_past_ok, false) then
    raise exception 'That time has already passed. If the call already happened, tick "This call already happened".';
  end if;
  select e.id, coalesce((e.details->>'time_pending')::boolean, false) into v_event, v_was_pending from client_events e
    where e.client_id = v_client and e.event_type = 'intro_call' and e.confirmed = false
    order by (e.event_date >= now()) desc, case when e.event_date >= now() then e.event_date end asc, e.created_at desc limit 1;   -- the nearest upcoming pending call, else the latest
  if v_event is not null then
    update client_events set event_date = p_event_date,
      details = case when p_time is null and v_was_pending
                     then coalesce(details, '{}'::jsonb) || jsonb_build_object('via', p_via)
                     else (coalesce(details, '{}'::jsonb) - 'time_pending' - 'auto') || jsonb_build_object('via', p_via, 'time', p_time, 'timezone', p_timezone) end
    where id = v_event;
    select full_name into v_who from profiles where id = auth.uid();
    if v_was_pending and p_time is not null then
      for r in select uid from public.intro_recipients(v_creator) loop
        select nullif(timezone, '') into v_tz from profiles where id = r.uid;
        v_when := to_char(p_event_date at time zone coalesce(v_tz, 'America/Chicago'), 'Dy Mon FMDD, FMHH12:MI AM');
        perform public.notify_user(r.uid, 'Intro call time set for ' || coalesce(v_name, 'a client') || ': ' || v_when || '.', 'intro_booked', '/clients.html?client=' || v_client);
      end loop;
    end if;
  else
    insert into client_events (client_id, event_type, event_date, details, created_by)
    values (v_client, 'intro_call', p_event_date, jsonb_build_object('via', p_via, 'time', p_time, 'timezone', p_timezone), coalesce(auth.uid(), v_creator))
    returning id into v_event;
  end if;
  return v_event;
end $$;
revoke execute on function public.set_intro_call_time(uuid, uuid, timestamptz, text, text, text, boolean) from public, anon;
grant execute on function public.set_intro_call_time(uuid, uuid, timestamptz, text, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------- 6. Reports: a week is Monday to Sunday (weekend work counted, same as Profile)
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'compute_report_rollups';
  v_new := replace(replace(v_def, 'v_period_end_excl := v_period_start + 5;', 'v_period_end_excl := v_period_start + 7;'), 'v_period_end_excl - v_period_start = 5 then', 'v_period_end_excl - v_period_start = 7 then');
  if v_new = v_def then return; end if;
  if v_new not like '%v_period_start + 7%' then raise exception 'compute_report_rollups patch did not apply'; end if;
  execute v_new;
end $$;
select public.compute_report_rollups();
