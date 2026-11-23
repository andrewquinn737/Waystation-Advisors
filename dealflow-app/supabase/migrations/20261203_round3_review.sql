-- Round 3 review fixes. Ships to live after 20261202_round2_review.sql.
--
-- !! LIVE HAS THE SAME SECURITY GAPS (sections 1-3 below) and needs this same migration. They were found on TEST but the
-- !! policies / functions are identical on live: any signed-in user can write call_status_changes rows for anyone,
-- !! the whole profiles table (names, emails, phones, email templates) is readable with only the public anon key, and any
-- !! signed-in user can push a notification to anyone. Apply sections 1-3 to live FIRST if the rest has to wait.
--
-- 1. call_status_changes: insert only as yourself (or admin); read own / your team's (team lead) / all (admin) / rows on your own dials.
-- 2. profiles: no anonymous read (the app never reads profiles before sign-in; login.html and the intake form do not).
-- 3. create_notification: caller must be the target, the target's team lead, an admin or the service role. Server-side callers
--    (cron, triggers, other SECURITY DEFINER functions) now call create_notification_internal, which clients cannot execute.
--    The "sent you a list" notice moves into a trigger on dial_lists so a transfer still notifies without a client call.
-- 4. Heavy definer jobs are no longer executable by every signed-in user.
-- 5. Email: bounce guard for new mailboxes, hard vs soft bounces, reply-stop on thread / company domain, auto-reply detection,
--    launch accounting + preview, mandate-aware queue status, suppression list screen RPCs, per-step campaign stats.

-- ============================================================ 1. call_status_changes
create or replace function public.csc_team_user_ids() returns setof uuid
 language sql stable security definer set search_path to 'public' as $$
  select them.id from profiles me join profiles them on them.team_id = any (public.my_team_ids(me.id))
   where me.id = auth.uid() and me.role = 'team_lead' and them.role in ('intern', 'independent_lead') $$;
revoke all on function public.csc_team_user_ids() from public, anon;
grant execute on function public.csc_team_user_ids() to authenticated;

drop policy if exists call_status_changes_insert_all on public.call_status_changes;
drop policy if exists call_status_changes_insert_own on public.call_status_changes;
create policy call_status_changes_insert_own on public.call_status_changes for insert to authenticated
  with check (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists call_status_changes_select_all on public.call_status_changes;
drop policy if exists call_status_changes_select_scoped on public.call_status_changes;
create policy call_status_changes_select_scoped on public.call_status_changes for select to authenticated
  using ((select public.is_admin())
         or user_id = (select auth.uid())
         or user_id in (select public.csc_team_user_ids())
         or dial_id in (select d.id from public.dials d where d.created_by = (select auth.uid())));

-- ============================================================ 2. profiles: signed-in only
drop policy if exists profiles_select_all on public.profiles;
create policy profiles_select_all on public.profiles for select to authenticated using (true);

-- ============================================================ 3. create_notification
create or replace function public.create_notification_internal(p_user_id uuid, p_message text, p_type text default null) returns void
 language plpgsql security definer set search_path to 'public' as $$
declare v_enabled boolean;
begin
  select notifications_enabled into v_enabled from profiles where id = p_user_id;
  if v_enabled is not false then
    insert into notifications (user_id, message, type) values (p_user_id, p_message, p_type);
  end if;
end $$;
revoke all on function public.create_notification_internal(uuid, text, text) from public, anon, authenticated;

-- every existing server-side caller (cron jobs, triggers, definer RPCs) switches to the internal helper
do $$
declare f record;
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace
              and p.proname not in ('create_notification', 'create_notification_internal')
              and p.prosrc ~ 'create_notification\s*\(' loop
    execute replace(pg_get_functiondef(f.oid), 'create_notification(', 'create_notification_internal(');
  end loop;
end $$;

create or replace function public.create_notification(p_user_id uuid, p_message text, p_type text default null) returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (auth.uid() is not null and (auth.uid() = p_user_id or coalesce(public.is_admin(), false) or coalesce(public.is_team_lead_of(p_user_id), false))) then
    raise exception 'You can only send notifications to yourself, your own team, or (as an admin) anyone.' using errcode = '42501';
  end if;
  perform public.create_notification_internal(p_user_id, p_message, p_type);
end $$;
revoke all on function public.create_notification(uuid, text, text) from public, anon;
grant execute on function public.create_notification(uuid, text, text) to authenticated, service_role;

create or replace function public.dial_lists_notify_transfer() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare v_name text;
begin
  if auth.uid() is not null and new.created_by is distinct from old.created_by and new.created_by <> auth.uid() then
    select full_name into v_name from profiles where id = auth.uid();
    perform public.create_notification_internal(new.created_by, coalesce(nullif(v_name, ''), 'Someone') || ' sent you a list of people to contact.', 'dial_transfer');
  end if;
  return new;
end $$;
revoke all on function public.dial_lists_notify_transfer() from public, anon, authenticated;
drop trigger if exists dial_lists_notify_transfer on public.dial_lists;
create trigger dial_lists_notify_transfer after update of created_by on public.dial_lists
  for each row when (old.created_by is distinct from new.created_by) execute function public.dial_lists_notify_transfer();

-- ============================================================ 4. definer jobs not for clients
do $$
declare f record;
begin
  for f in select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) a from pg_proc p where p.pronamespace = 'public'::regnamespace
              and p.proname in ('compute_report_rollups', 'prune_report_data', 'run_daily_event_notifications', 'callback_tasks_escalate') loop
    execute format('revoke execute on function public.%I(%s) from public, anon, authenticated', f.proname, f.a);
  end loop;
end $$;

-- ============================================================ 5a. bounce guard
alter table public.dials add column if not exists bounce_kind text;             -- 'hard' | 'soft' (null with bounced_at = legacy row, counted as hard)
alter table public.dials add column if not exists soft_bounces int not null default 0;
alter table public.email_messages add column if not exists is_auto_reply boolean not null default false;

-- A bounce counts when it is hard, or when a soft one (mailbox full, try later) repeated.
create or replace function public.check_bounce_rates() returns integer
 language plpgsql security definer set search_path to 'public' as $$
declare r record; n int := 0;
begin
  -- Mailbox rules: a new mailbox pauses early (>= 3 counted bounces in under 20 sends, or > 10% from 10 sends); then > 3% from 20 sends.
  for r in
    with x as (
      select d.sender_account_id as acct, count(*) as sent,
             count(*) filter (where d.bounced_at is not null and (coalesce(d.bounce_kind, 'hard') = 'hard' or d.soft_bounces >= 2)) as bounced
        from sequence_tasks t join dials d on d.id = t.dial_id join email_accounts a on a.id = d.sender_account_id
       where t.kind = 'email' and t.status = 'done' and t.completed_at > now() - interval '7 days'
         and t.completed_at > coalesce(a.bounce_check_from, '-infinity'::timestamptz)
       group by d.sender_account_id)
    select * from x
     where (sent < 20 and bounced >= 3) or (sent >= 10 and bounced::numeric / sent > 0.10) or (sent >= 20 and bounced::numeric / sent > 0.03)
  loop
    update email_accounts set send_paused_reason = 'Auto-paused: bounce rate ' || round(100.0 * r.bounced / r.sent, 1) || '% (' || r.bounced || ' of ' || r.sent || ' sends bounced)'
     where id = r.acct and coalesce(send_paused_reason, '') = '';
    if found then n := n + 1; end if;
  end loop;
  for r in
    with x as (
      select t.list_id, count(*) as sent,
             count(*) filter (where d.bounced_at is not null and (coalesce(d.bounce_kind, 'hard') = 'hard' or d.soft_bounces >= 2)) as bounced
        from sequence_tasks t join dials d on d.id = t.dial_id join dial_lists l on l.id = t.list_id
       where t.kind = 'email' and t.status = 'done' and t.completed_at > now() - interval '7 days' and l.deleted_at is null
         and t.completed_at > coalesce(l.bounce_check_from, '-infinity'::timestamptz)
       group by t.list_id)
    select * from x
     where (sent < 20 and bounced >= 3) or (sent >= 10 and bounced::numeric / sent > 0.10) or (sent >= 20 and bounced::numeric / sent > 0.03)
  loop
    update dial_lists set send_paused_reason = 'Auto-paused: bounce rate ' || round(100.0 * r.bounced / r.sent, 1) || '% (' || r.bounced || ' of ' || r.sent || ' sends bounced)'
     where id = r.list_id and send_paused_reason is null;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- ============================================================ 5b. auto-replies + reply-stop on thread / company domain
create or replace function public.email_is_auto_reply(p_from text, p_subject text, p_snippet text) returns boolean
 language sql immutable set search_path to 'public' as $$
  select coalesce(p_subject, '') ~* '^\s*((re|fw|fwd)\s*:\s*)*(automatic reply|auto[- ]?reply|auto[- ]?response|autoresponse|automated (reply|response)|out of (the )?office|ooo\M|away from (the )?office|on (annual |maternity |parental )?leave\M|vacation (reply|response|notice)|abwesenheit|auto:)'
      or coalesce(p_snippet, '') ~* '(this is an automatic reply|this is an auto-?reply|automatic reply|i am (currently )?out of (the )?office|i''m (currently )?out of (the )?office|out of (the )?office (until|from|and will)|limited access to (my )?e-?mail|away from my (desk|email|e-mail) (until|and)|thank you for your (e-?mail|message)\.? i am (currently )?(out|away))' $$;

create or replace function public.email_messages_flag_system() returns trigger
 language plpgsql set search_path to 'public' as $$
begin
  if new.direction = 'inbound' then
    new.system_kind := public.email_system_kind(new.from_address, new.subject);
    new.is_system := new.system_kind is not null;
    new.is_auto_reply := new.system_kind is null and (coalesce(new.is_auto_reply, false) or public.email_is_auto_reply(new.from_address, new.subject, new.snippet));
  end if;
  return new;
end $$;

create or replace function public.email_inbound_seq_check() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare d record; v_from text := lower(btrim(coalesce(new.from_address,''))); v_txt text; v_known boolean; v_hard boolean;
        v_at timestamptz := coalesce(new.sent_at, new.created_at, now()); v_dom text := public.email_domain(v_from); v_matched text[] := '{}'; m text;
begin
  if new.direction is distinct from 'inbound' then return new; end if;
  v_txt := lower(coalesce(new.body_text,'') || ' ' || coalesce(new.subject,''));
  if v_from ~ '^(mailer-daemon|postmaster|mail-daemon)@' or coalesce(new.subject,'') ~* '(undeliver|delivery status notification|delivery has failed|returned mail|failure notice)' then
    v_hard := bounce_is_hard(new.subject, new.body_text);
    for d in select id, email, seq_state from dials where email is not null and sender_account_id = new.account_id
                and (seq_state in ('active', 'bounced') or email_1_message_id is not null)
                and position(lower(email) in v_txt) > 0 loop
      if d.seq_state in ('active', 'bounced') then
        update dials set bounced_at = coalesce(bounced_at, now()),
               bounce_kind = case when v_hard or bounce_kind = 'hard' then 'hard' else 'soft' end,
               soft_bounces = soft_bounces + case when v_hard then 0 else 1 end
         where id = d.id;
      end if;
      if d.seq_state = 'active' then perform seq_stop(d.id, 'bounced', 'Email bounced', false); end if;
      if v_hard then perform suppress_email_internal(d.email, 'Hard bounce', 'bounce', null); end if;
    end loop;
    return new;
  end if;
  -- Out-of-office / auto-replies are not replies: the sequence keeps going, nothing is created, nothing is suppressed.
  if coalesce(new.is_auto_reply, false) then return new; end if;
  -- The sequence stops when the answer comes from the lead's address, on the same thread (alias, assistant, forward),
  -- or from anyone at the lead's company domain (never a free-mail domain) that wrote to the same mailbox.
  for d in select dd.id, dd.email, dd.created_by, dd.list_id from dials dd where dd.seq_state = 'active' and (
             lower(dd.email) = v_from
          or (new.thread_id is not null and dd.email_1_thread_id = new.thread_id)
          or (new.in_reply_to is not null and dd.email_1_message_id = new.in_reply_to)
          or (v_dom <> '' and dd.sender_account_id = new.account_id and public.email_domain(dd.email) = v_dom and not public.dedup_domain_exempt(v_dom))) loop
    perform seq_stop(d.id, 'replied', 'Owner replied by email', false);
    v_matched := v_matched || lower(d.email);
    insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on)
    values (d.id, d.list_id, d.created_by, 100, 0, 'reply', add_business_days(person_today(d.created_by), 2))
    on conflict (dial_id, step) do nothing;
  end loop;
  -- they wrote again after we answered: the reply task comes back
  update sequence_tasks st set status = 'pending', outcome = null, completed_at = null, completed_by = null,
         due_on = add_business_days(person_today(st.owner_id), 2)
    from dials dd where dd.id = st.dial_id and (lower(dd.email) = v_from or (new.thread_id is not null and dd.email_1_thread_id = new.thread_id))
     and st.kind = 'reply' and st.status = 'done' and st.completed_at is not null and v_at > st.completed_at;
  if v_from ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' and reply_wants_stop(new.subject, new.body_text) then
    v_known := exists (select 1 from dials where lower(email) = v_from)
            or exists (select 1 from email_messages o, jsonb_array_elements(coalesce(o.to_addresses, '[]'::jsonb)) a
                        where o.account_id = new.account_id and o.direction = 'outbound' and lower(a->>'address') = v_from);
    if v_known then perform suppress_email_internal(v_from, 'Asked to stop / unsubscribe', 'reply', null); end if;
    -- the person we were emailing (when an alias answered) must not get the next email either
    foreach m in array v_matched loop
      if m is not null and m <> v_from then perform suppress_email_internal(m, 'Asked to stop / unsubscribe (reply from ' || v_from || ')', 'reply', null); end if;
    end loop;
  end if;
  return new;
end $$;

-- the "new email" push: no ping for out-of-office replies; a bounce reads as a delivery problem
create or replace function public.notify_new_inbound_email() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid; v_who text; v_subject text; v_recent int;
begin
  if new.direction <> 'inbound' then return new; end if;
  if new.sent_at < now() - interval '2 hours' then return new; end if;
  if coalesce(new.is_auto_reply, false) or new.system_kind = 'notice' then return new; end if;
  select owner_id into v_owner from email_accounts where id = new.account_id;
  if v_owner is null then return new; end if;
  select count(*) into v_recent from notifications where user_id = v_owner and type = 'new_email' and created_at > now() - interval '5 minutes';
  if v_recent >= 5 then return new; end if;
  if new.system_kind = 'bounce' then
    perform create_notification_internal(v_owner, 'An email could not be delivered. See Inbox > Bounces.', 'new_email');
    return new;
  end if;
  v_who := coalesce(nullif(trim(new.from_name), ''), new.from_address);
  v_subject := coalesce(nullif(trim(new.subject), ''), '(no subject)');
  perform create_notification_internal(v_owner, left('New email from ' || v_who || ': ' || v_subject, 140), 'new_email');
  return new;
end $$;

-- ============================================================ 5c. capacity, queue status, launch preview, launch accounting
create or replace function public.owner_send_capacity(p_owner uuid, p_mandate text, p_now timestamptz default now()) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_boxes jsonb; v_doms jsonb; v_day int; v_left int; v_cap int; v_rem int;
begin
  with b as (
    select a.id, a.email_address, lower(split_part(a.email_address, '@', 2)) as dom, public.mailbox_day_cap(a.id, p_now) as cap,
           public.mailbox_used_today(a.id, p_now) as used, public.domain_used_today(a.id, p_now) as dused, a.daily_send_limit as lim,
           case when a.ramp_start is null then null
                else 2 + greatest(0, (p_now at time zone public.person_tz(a.owner_id))::date - a.ramp_start) end as ramp
      from email_accounts a where a.id in (select public.owner_eligible_mailboxes(p_owner, p_mandate))),
  dm as (select dom, count(*) as n, sum(cap) as sumcap, max(dused) as dused, least(public.domain_cap(), sum(cap)) as dcap,
                least(sum(greatest(0, cap - used)), greatest(0, public.domain_cap() - max(dused))) as dleft from b group by dom)
  select coalesce((select jsonb_agg(jsonb_build_object('address', b.email_address, 'cap', b.cap, 'used', b.used,
            'reason', case when b.ramp is not null and b.ramp < least(20, coalesce(b.lim, public.mailbox_daily_limit())) then 'New mailbox, warming up (' || b.ramp || ' a day)'
                           when b.lim is not null and b.lim < 20 then 'Daily limit ' || b.lim end) order by b.email_address) from b), '[]'),
         coalesce((select jsonb_agg(jsonb_build_object('domain', dom, 'mailboxes', n, 'cap', dcap, 'limited', sumcap > public.domain_cap(), 'domain_cap', public.domain_cap()) order by dom) from dm), '[]'),
         coalesce((select sum(dcap) from dm), 0)::int, coalesce((select sum(dleft) from dm), 0)::int, coalesce((select sum(cap) from b), 0)::int, coalesce((select sum(greatest(0, cap - used)) from b), 0)::int
    into v_boxes, v_doms, v_day, v_left, v_cap, v_rem;
  return jsonb_build_object('mailboxes', v_boxes, 'domains', v_doms, 'day_capacity', v_day, 'left_today', v_left, 'mailbox_capacity', v_cap, 'mailbox_remaining', v_rem);
end $$;
revoke all on function public.owner_send_capacity(uuid, text, timestamptz) from public, anon, authenticated;

drop function if exists public.email_queue_status(uuid);
create or replace function public.email_queue_status(p_owner uuid default auth.uid(), p_mandate text default null) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_now timestamptz := now(); v_tz text; v_lists jsonb; v_next timestamptz; v_sent int; v_cap jsonb;
begin
  if auth.uid() is null or p_owner is null then raise exception 'Sign in first'; end if;
  if not coalesce(auth.uid() = p_owner or is_admin() or is_team_lead_of(p_owner), false) then raise exception 'No access to that person'; end if;
  v_tz := person_tz(p_owner);
  v_cap := owner_send_capacity(p_owner, p_mandate, v_now);
  select count(*) into v_sent from email_messages m join email_accounts a on a.id = m.account_id
   where a.owner_id = p_owner and m.direction = 'outbound' and (m.sent_at at time zone v_tz)::date = (v_now at time zone v_tz)::date
     and (p_mandate is null or a.mandate is null or a.mandate = p_mandate);
  select min(s.send_at) into v_next from scheduled_emails s join email_accounts a on a.id = s.account_id
   where a.owner_id = p_owner and s.status = 'pending' and s.send_at >= v_now and (p_mandate is null or a.mandate is null or a.mandate = p_mandate);
  select coalesce(jsonb_agg(x order by x->>'name'), '[]') into v_lists from (
    select jsonb_build_object('list_id', l.id, 'name', l.name, 'paused', l.send_paused_reason,
      'ready_not_started', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok
                              and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
      'active', count(*) filter (where d.seq_state = 'active'), 'replied', count(*) filter (where d.seq_state = 'replied'),
      'bounced', count(*) filter (where d.seq_state = 'bounced'), 'backup', count(*) filter (where d.sequence = 'backup')) x
      from dial_lists l join dials d on d.list_id = l.id
     where l.created_by = p_owner and l.deleted_at is null group by l.id, l.name, l.send_paused_reason) q;
  return jsonb_build_object('timezone', v_tz, 'sent_today', v_sent, 'capacity_today', (v_cap->>'mailbox_capacity')::int,
                            'remaining_today', (v_cap->>'mailbox_remaining')::int, 'day_capacity', (v_cap->>'day_capacity')::int,
                            'left_today', (v_cap->>'left_today')::int, 'next_send_at', v_next,
                            'mailboxes', v_cap->'mailboxes', 'domains', v_cap->'domains', 'lists', v_lists);
end $$;
revoke all on function public.email_queue_status(uuid, text) from public, anon;
grant execute on function public.email_queue_status(uuid, text) to authenticated;

-- What a launch would do, before anyone clicks: counts, real per-mailbox caps, the day the first emails finish, the first email itself.
create or replace function public.campaign_launch_preview(p_list uuid) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_list record; v_now timestamptz := now(); v_cap jsonb; v_ready int; v_supp int; v_dup int; v_day0 date; v_today date; v_first int;
        v_day int; v_left int; v_send int; v_days int; v_finish date; v_s record;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into v_list from dial_lists where id = p_list and deleted_at is null;
  if v_list is null then raise exception 'List not found'; end if;
  if not coalesce(auth.uid() = v_list.created_by or is_admin() or is_team_lead_of(v_list.created_by), false) then raise exception 'No access to this list'; end if;
  select count(*), count(*) filter (where blocked = 'suppressed'), count(*) filter (where blocked = 'duplicate')
    into v_ready, v_supp, v_dup from start_candidates(p_list, null, '{}');
  v_cap := owner_send_capacity(v_list.created_by, v_list.mandate, v_now);
  v_day := (v_cap->>'day_capacity')::int; v_left := (v_cap->>'left_today')::int;
  v_today := person_today(v_list.created_by, v_now);
  v_day0 := case when is_business_day(v_today) and (v_now at time zone person_tz(v_list.created_by))::time < '17:00' then v_today else next_business_day(v_today + 1) end;
  v_send := greatest(0, v_ready - v_supp - v_dup);
  v_first := case when v_day0 = v_today then v_left else v_day end;
  if v_send > 0 and v_day > 0 then
    v_days := case when v_send <= v_first then 1 else 1 + ceil((v_send - v_first)::numeric / v_day)::int end;
    v_finish := add_business_days(v_day0, v_days - 1);
  end if;
  select d.full_name, d.company_name, d.email_subject, left(d.email_1, 700) as body into v_s from dials d
   where d.list_id = p_list and d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)
   order by d.created_at, d.id limit 1;
  return jsonb_build_object('ready', v_ready, 'suppressed', v_supp, 'duplicate', v_dup, 'would_send', v_send, 'mandate', v_list.mandate,
    'mailboxes', v_cap->'mailboxes', 'domains', v_cap->'domains', 'day_capacity', v_day, 'left_today', v_left,
    'first_send_day', v_day0, 'days_to_send_firsts', v_days, 'finish_on', v_finish, 'timezone', person_tz(v_list.created_by),
    'sample', case when v_s.email_subject is null and v_s.body is null then null
                   else jsonb_build_object('to', coalesce(nullif(v_s.full_name, ''), v_s.company_name), 'company', v_s.company_name, 'subject', v_s.email_subject, 'body', v_s.body) end);
end $$;
revoke all on function public.campaign_launch_preview(uuid) from public, anon;
grant execute on function public.campaign_launch_preview(uuid) to authenticated;

-- start_emails: same behaviour; the result now accounts for every lead it looked at
create or replace function public.start_emails(p_list_id uuid, p_count integer default null, p_dial_ids uuid[] default null) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_list record; r record; v_day0 date; v_tz text; v_started int := 0; v_backup int := 0; v_unver int := 0;
  v_susp int := 0; v_dup int := 0; v_block text; v_seen int := 0;
  v_held int; v_ready int; v_cap int := 0; v_firsts int; v_day_cap int := 0; v_now timestamptz := now(); b uuid;
  v_no_email int; v_backup_all int;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into v_list from dial_lists where id = p_list_id and deleted_at is null;
  if v_list is null then raise exception 'List not found'; end if;
  if not coalesce(auth.uid() = v_list.created_by or is_admin() or is_team_lead_of(v_list.created_by), false) then
    raise exception 'Only the list owner, their team lead, or an admin can start this list';
  end if;
  if v_list.send_paused_reason is not null then
    raise exception 'This list is paused (%). An admin has to resume it first.', v_list.send_paused_reason;
  end if;
  if not exists (select 1 from owner_eligible_mailboxes(v_list.created_by, v_list.mandate)) then
    raise exception 'The list owner has no sending mailbox for this kind of outreach yet. Ask an admin to assign one.';
  end if;
  v_tz := person_tz(v_list.created_by);
  v_day0 := case when is_business_day(person_today(v_list.created_by, v_now)) and (v_now at time zone v_tz)::time < '17:00'
                 then person_today(v_list.created_by, v_now) else next_business_day(person_today(v_list.created_by, v_now) + 1) end;
  for r in select * from start_candidates(p_list_id, null, '{}') c
            where p_dial_ids is null or c.id = any (p_dial_ids)
            limit p_count
  loop
    v_block := lead_block_reason(r.id);
    v_seen := v_seen + 1;
    if v_block = 'suppressed' then
      perform seq_to_backup(r.id, 'Not emailed: address is on the suppression list.');
      v_susp := v_susp + 1;
    elsif v_block = 'duplicate' then
      perform seq_to_backup(r.id, 'Not emailed: another active sequence already covers this address or company.');
      v_dup := v_dup + 1;
    elsif r.mv_checked_at is null or r.mv_checked_at < v_now - interval '30 days' or r.mv_result is null then
      v_unver := v_unver + 1;
    elsif r.mv_result = 'ok' then
      update dials set seq_state = 'active', seq_day0 = v_day0 where id = r.id;
      perform seq_build_tasks(r.id);
      v_started := v_started + 1;
    else
      delete from sequence_tasks where dial_id = r.id;
      update dials set sequence = 'backup', seq_state = null, seq_day0 = null,
             seq_stop_reason = 'Not emailed: address check said ' || r.mv_result || '. Kept as a backup number.'
       where id = r.id;
      v_backup := v_backup + 1;
    end if;
  end loop;
  if v_started > 0 then
    update dial_lists set copy_status = 'approved', copy_approved_at = now(), copy_approved_by = auth.uid() where id = p_list_id;
  end if;
  select count(*) into v_held from dials where list_id = p_list_id and sequence = 'email5' and seq_state = 'awaiting_copy'
     and not (copy_ok and copy_hash = copy_text_hash(email_subject, email_1, email_2));
  select count(*) into v_ready from dials where list_id = p_list_id and sequence = 'email5' and seq_state = 'awaiting_copy'
     and copy_ok and copy_hash = copy_text_hash(email_subject, email_1, email_2);
  select count(*) filter (where sequence = 'backup'), count(*) filter (where sequence = 'backup' and coalesce(btrim(email), '') = '')
    into v_backup_all, v_no_email from dials where list_id = p_list_id;
  for b in select owner_eligible_mailboxes(v_list.created_by, v_list.mandate) loop
    v_day_cap := v_day_cap + mailbox_day_cap(b, v_now);
    v_cap := v_cap + greatest(0, mailbox_day_cap(b, v_now) - mailbox_used_today(b, v_now));
  end loop;
  select count(*) into v_firsts from sequence_tasks where owner_id = v_list.created_by and kind = 'email' and status = 'pending';
  return jsonb_build_object('started', v_started, 'held_for_copy', v_held, 'moved_to_backup', v_backup,
    'bad_address', v_backup, 'suppressed', v_susp, 'duplicate', v_dup, 'considered', v_seen,
    'needs_verification', v_unver, 'remaining_ready', v_ready, 'today_capacity', v_cap,
    'backup_total', v_backup_all, 'backup_no_email', v_no_email,
    'est_days_to_send_firsts', case when v_day_cap > 0 then ceil(v_firsts::numeric / v_day_cap)::int end,
    'first_send_day', v_day0);
end $$;

-- ============================================================ 5d. admin Sent column + per-step stats
create or replace function public.campaign_step_stats(p_list uuid) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_list record; v jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into v_list from dial_lists where id = p_list and deleted_at is null;
  if v_list is null then raise exception 'List not found'; end if;
  if not coalesce(auth.uid() = v_list.created_by or is_admin() or is_team_lead_of(v_list.created_by), false) then raise exception 'No access to this list'; end if;
  with sent as (
    select t.dial_id, t.step, t.kind from sequence_tasks t where t.list_id = p_list and t.kind in ('email', 'followup_email') and t.status = 'done'),
  last_step as (select dial_id, max(step) as step from sent group by dial_id)
  select coalesce(jsonb_agg(jsonb_build_object('step', s.step, 'label', case s.kind when 'email' then 'First email' else 'Follow-up email' end,
      'sent', s.n, 'replied', coalesce(r.n, 0), 'bounced', coalesce(bn.n, 0)) order by s.step), '[]') into v
    from (select step, kind, count(*) n from sent group by step, kind) s
    left join (select ls.step, count(*) n from last_step ls join dials d on d.id = ls.dial_id where d.seq_state = 'replied' group by ls.step) r on r.step = s.step
    left join (select ls.step, count(*) n from last_step ls join dials d on d.id = ls.dial_id where d.seq_state = 'bounced' group by ls.step) bn on bn.step = s.step;
  return v;
end $$;
revoke all on function public.campaign_step_stats(uuid) from public, anon;
grant execute on function public.campaign_step_stats(uuid) to authenticated;

do $$
declare src text;
begin
  select pg_get_functiondef('public.admin_campaigns(boolean)'::regprocedure) into src;
  src := replace(src, '''emails_sent'', (select count(*) from scheduled_emails s join dials sd on sd.id = s.dial_id where sd.list_id = c.list_id and s.status = ''sent'')',
    '''emails_sent'', (select count(*) from email_messages m join scheduled_emails s on s.id = m.scheduled_id join dials sd on sd.id = s.dial_id where sd.list_id = c.list_id and m.direction = ''outbound'')');
  execute src;
end $$;

-- ============================================================ 5e. suppression list screen
create or replace function public.suppression_list(p_search text default null, p_limit int default 100, p_offset int default 0) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_q text := '%' || lower(btrim(coalesce(p_search, ''))) || '%'; v_total int; v jsonb;
begin
  if auth.uid() is null or not coalesce(is_admin(), false) then raise exception 'Only an admin can see the suppression list'; end if;
  with u as (
    select 'email'::text as kind, s.email as value, s.reason, s.source, s.created_at, s.created_by from suppressed_emails s
    union all select 'domain', d.domain, d.reason, d.source, d.created_at, d.created_by from suppressed_domains d),
  f as (select * from u where p_search is null or btrim(p_search) = '' or lower(value) like v_q or lower(coalesce(reason, '')) like v_q)
  select (select count(*) from f), coalesce(jsonb_agg(jsonb_build_object('kind', x.kind, 'value', x.value, 'reason', x.reason, 'source', x.source,
            'created_at', x.created_at, 'added_by', p.full_name) order by x.created_at desc), '[]')
    into v_total, v
    from (select * from f order by created_at desc limit greatest(1, least(coalesce(p_limit, 100), 500)) offset greatest(0, coalesce(p_offset, 0))) x
    left join profiles p on p.id = x.created_by;
  return jsonb_build_object('total', v_total, 'items', v);
end $$;
revoke all on function public.suppression_list(text, int, int) from public, anon;
grant execute on function public.suppression_list(text, int, int) to authenticated;

-- Paste many: emails and/or domains separated by commas, semicolons, spaces or new lines.
create or replace function public.suppress_many(p_text text, p_reason text default 'manual') returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare tok text; v_reason text := coalesce(nullif(btrim(p_reason), ''), 'manual'); v_e int := 0; v_d int := 0; v_old int := 0; v_bad text[] := '{}'; v text;
begin
  if auth.uid() is null or not coalesce(is_admin(), false) then raise exception 'Only an admin can edit the suppression list'; end if;
  foreach tok in array regexp_split_to_array(lower(coalesce(p_text, '')), '[\s,;]+') loop
    v := btrim(tok, ' <>"''()');
    if v = '' then continue; end if;
    if v ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then
      if exists (select 1 from suppressed_emails where email = v) then v_old := v_old + 1;
      else perform suppress_email_internal(v, v_reason, 'admin', auth.uid()); v_e := v_e + 1; end if;
    elsif v ~ '^@?[a-z0-9.-]+\.[a-z]{2,}$' then
      v := ltrim(v, '@');
      if exists (select 1 from suppressed_domains where domain = v) then v_old := v_old + 1;
      else perform suppress_domain(v, v_reason); v_d := v_d + 1; end if;
    else v_bad := v_bad || v; end if;
  end loop;
  return jsonb_build_object('emails', v_e, 'domains', v_d, 'already', v_old, 'skipped', to_jsonb(v_bad));
end $$;
revoke all on function public.suppress_many(text, text) from public, anon;
grant execute on function public.suppress_many(text, text) to authenticated;

create or replace function public.unsuppress_domain(p_domain text) returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or not coalesce(is_admin(), false) then raise exception 'Only an admin can edit the suppression list'; end if;
  delete from suppressed_domains where domain = lower(btrim(coalesce(p_domain, '')));
end $$;
revoke all on function public.unsuppress_domain(text) from public, anon;
grant execute on function public.unsuppress_domain(text) to authenticated;

-- ============================================================ 6. "Did your intro call happen?" opens the client on the Timeline tab
do $$
declare f record; src text;
begin
  for f in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('run_intro_confirm_prompts', 'set_intro_call_time') loop
    src := pg_get_functiondef(f.oid);
    src := replace(src, '''/clients.html?client='' || r.client_id)', '''/clients.html?client='' || r.client_id || ''&tab=timeline'')');
    src := replace(src, '''/clients.html?client='' || v_client)', '''/clients.html?client='' || v_client || ''&tab=timeline'')');
    execute src;
  end loop;
end $$;
