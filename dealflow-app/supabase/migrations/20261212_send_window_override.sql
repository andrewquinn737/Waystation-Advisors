-- One-off, owner-scoped send-window override (Mason 2026-11-24: Andrew's first 30 data-sale emails 5-6 PM MT).
-- Only the named owner's mailboxes, only until the stored time; every other pilot keeps the 8:30-17:00 window.
create or replace function public.send_window_override_on(p_owner uuid, p_now timestamptz) returns boolean
 language sql stable security definer set search_path to 'public' as $f$
  select coalesce((select value from app_secrets where key = 'send_window_override_owner') = p_owner::text
         and p_now < (select value from app_secrets where key = 'send_window_override_until')::timestamptz, false) $f$;
revoke all on function public.send_window_override_on(uuid, timestamptz) from public, anon, authenticated;
insert into app_secrets (key, value) values ('send_window_override_owner', '49255b71-de62-45d4-a252-c0b3e2ab91e9')
  on conflict (key) do update set value = excluded.value;
insert into app_secrets (key, value) values ('send_window_override_until', '2026-11-24 18:00:00 America/Denver')
  on conflict (key) do update set value = excluded.value;
CREATE OR REPLACE FUNCTION public.sequence_dispatch(p_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m record; t record; n int := 0; v_tz text; v_local timestamp; v_today date; v_last timestamptz; v_at timestamptz;
  v_r double precision; v_tsn boolean := public.test_send_now_on(); v_subject text; v_body text; v_sid uuid; xs record;
begin
  -- suppressed addresses never get another email (not yet emailed -> backup number; mid-sequence -> emails stop)
  for xs in select d.id from dials d where d.seq_state = 'active' and d.email is not null and is_suppressed(d.email)
              and exists (select 1 from sequence_tasks st where st.dial_id = d.id and st.status in ('pending','queued') and st.kind in ('email','followup_email')) loop
    perform seq_to_backup(xs.id, 'Not emailed: address is on the suppression list.');
  end loop;
  for m in
    select a.id, a.owner_id, a.mandate, person_tz(a.owner_id) tz, mailbox_day_cap(a.id, p_now) cap, c.sent + c.scheduled as used, c.daily_limit,
           (a.sync_enabled and a.last_synced_at > p_now - interval '2 hours' and coalesce(a.last_sync_error,'') = '') as inbox_ok
      from (select * from email_accounts x where not x.needs_assignment and coalesce(x.send_paused_reason,'') = ''
              and x.owner_id in (select st.owner_id from sequence_tasks st where st.status = 'pending'
                                   and st.kind in ('email','followup_email')
                                 group by st.owner_id having (min(st.due_on) <= person_today(st.owner_id, p_now) or public.test_send_now_on()))) a
           cross join lateral mailbox_send_counts(a.id) c
     where c.sent + c.scheduled < c.daily_limit
     order by c.sent + c.scheduled, a.id
  loop
    v_tz := m.tz; v_local := p_now at time zone v_tz; v_today := v_local::date;
    continue when not v_tsn and not public.send_window_override_on(m.owner_id, p_now)
                  and (not is_business_day(v_today) or v_local::time < '08:30' or v_local::time >= '17:00');   -- test_send_now: TEST project only
    continue when mailbox_used_today(m.id, p_now) >= m.cap;                         -- cap incl. new-mailbox ramp
    continue when domain_used_today(m.id, p_now) >= domain_cap();                   -- all mailboxes on one sending domain
    v_last := mailbox_last_send(m.id);
    continue when v_last is not null and v_last > p_now + interval '15 minutes';
    v_r := 240 + random() * 300;                                   -- 4-9 minutes
    v_at := case when v_last is null or v_last <= p_now - interval '9 minutes' then p_now + make_interval(secs => v_r)
                 else greatest(p_now, v_last + make_interval(secs => v_r)) end;
    continue when not v_tsn and ((v_at at time zone v_tz)::date <> v_today or (v_at at time zone v_tz)::time >= '17:00');  -- waits for the next business day
    select st.id, st.kind, st.dial_id, d.email, d.full_name, d.email_subject, d.email_1, d.email_2,
           d.email_1_message_id, d.email_1_thread_id, d.created_by as dial_owner
      into t
      from sequence_tasks st join dials d on d.id = st.dial_id join dial_lists l on l.id = st.list_id
     where st.owner_id = m.owner_id and st.status = 'pending' and st.kind in ('email','followup_email')
       and (st.due_on <= v_today or (v_tsn and st.kind = 'email')) and d.seq_state = 'active' and l.copy_status = 'approved' and l.deleted_at is null
       and l.send_paused_reason is null
       and d.copy_ok and d.copy_hash = md5(coalesce(d.email_subject,'') || chr(30) || coalesce(d.email_1,'') || chr(30) || coalesce(d.email_2,''))
       and (l.mandate is null or m.mandate is null or l.mandate = m.mandate)
       and (v_tsn or public.recipient_window_ok(coalesce(d.tz, m.tz), v_at))                -- 9:00-16:00 weekdays where the owner of the business is
       and not is_suppressed(d.email)
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
            case when t.kind = 'followup_email' then t.email_1_thread_id end, v_at, 'pending')
    returning id into v_sid;
    update sequence_tasks set status = 'queued', scheduled_email_id = v_sid, attempts = attempts + 1 where id = t.id;
    n := n + 1;
    t := null;
  end loop;
  return n;
end $function$;

-- v2: override also covers the send-time and recipient-hour checks, 1.7-3 min pacing, and its own dispatch job
CREATE OR REPLACE FUNCTION public.sequence_dispatch(p_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m record; t record; n int := 0; v_tz text; v_local timestamp; v_today date; v_last timestamptz; v_at timestamptz;
  v_r double precision; v_tsn boolean := public.test_send_now_on(); v_ov boolean; v_subject text; v_body text; v_sid uuid; xs record;
begin
  -- suppressed addresses never get another email (not yet emailed -> backup number; mid-sequence -> emails stop)
  for xs in select d.id from dials d where d.seq_state = 'active' and d.email is not null and is_suppressed(d.email)
              and exists (select 1 from sequence_tasks st where st.dial_id = d.id and st.status in ('pending','queued') and st.kind in ('email','followup_email')) loop
    perform seq_to_backup(xs.id, 'Not emailed: address is on the suppression list.');
  end loop;
  for m in
    select a.id, a.owner_id, a.mandate, person_tz(a.owner_id) tz, mailbox_day_cap(a.id, p_now) cap, c.sent + c.scheduled as used, c.daily_limit,
           (a.sync_enabled and a.last_synced_at > p_now - interval '2 hours' and coalesce(a.last_sync_error,'') = '') as inbox_ok
      from (select * from email_accounts x where not x.needs_assignment and coalesce(x.send_paused_reason,'') = ''
              and x.owner_id in (select st.owner_id from sequence_tasks st where st.status = 'pending'
                                   and st.kind in ('email','followup_email')
                                 group by st.owner_id having (min(st.due_on) <= person_today(st.owner_id, p_now) or public.test_send_now_on()))) a
           cross join lateral mailbox_send_counts(a.id) c
     where c.sent + c.scheduled < c.daily_limit
     order by c.sent + c.scheduled, a.id
  loop
    v_tz := m.tz; v_local := p_now at time zone v_tz; v_today := v_local::date;
    v_ov := public.send_window_override_on(m.owner_id, p_now);
    continue when not v_tsn and not v_ov
                  and (not is_business_day(v_today) or v_local::time < '08:30' or v_local::time >= '17:00');   -- test_send_now: TEST project only
    continue when mailbox_used_today(m.id, p_now) >= m.cap;                         -- cap incl. new-mailbox ramp
    continue when domain_used_today(m.id, p_now) >= domain_cap();                   -- all mailboxes on one sending domain
    v_last := mailbox_last_send(m.id);
    continue when v_last is not null and v_last > p_now + interval '15 minutes';
    v_r := case when v_ov then 100 + random() * 80 else 240 + random() * 300 end;                                   -- 4-9 minutes
    v_at := case when v_last is null or v_last <= p_now - interval '9 minutes' then p_now + make_interval(secs => v_r)
                 else greatest(p_now, v_last + make_interval(secs => v_r)) end;
    continue when not v_tsn and not v_ov and ((v_at at time zone v_tz)::date <> v_today or (v_at at time zone v_tz)::time >= '17:00');  -- waits for the next business day
    select st.id, st.kind, st.dial_id, d.email, d.full_name, d.email_subject, d.email_1, d.email_2,
           d.email_1_message_id, d.email_1_thread_id, d.created_by as dial_owner
      into t
      from sequence_tasks st join dials d on d.id = st.dial_id join dial_lists l on l.id = st.list_id
     where st.owner_id = m.owner_id and st.status = 'pending' and st.kind in ('email','followup_email')
       and (st.due_on <= v_today or (v_tsn and st.kind = 'email')) and d.seq_state = 'active' and l.copy_status = 'approved' and l.deleted_at is null
       and l.send_paused_reason is null
       and d.copy_ok and d.copy_hash = md5(coalesce(d.email_subject,'') || chr(30) || coalesce(d.email_1,'') || chr(30) || coalesce(d.email_2,''))
       and (l.mandate is null or m.mandate is null or l.mandate = m.mandate)
       and (v_tsn or v_ov or public.recipient_window_ok(coalesce(d.tz, m.tz), v_at))                -- 9:00-16:00 weekdays where the owner of the business is
       and not is_suppressed(d.email)
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
            case when t.kind = 'followup_email' then t.email_1_thread_id end, v_at, 'pending')
    returning id into v_sid;
    update sequence_tasks set status = 'queued', scheduled_email_id = v_sid, attempts = attempts + 1 where id = t.id;
    n := n + 1;
    t := null;
  end loop;
  return n;
end $function$;
do $j$ begin perform cron.unschedule('andrew-window-dispatch'); exception when others then null; end $j$;
select cron.schedule('andrew-window-dispatch', '* * * * *', $c$select public.sequence_dispatch() where exists (select 1 from app_secrets where key='send_window_override_until' and now() < value::timestamptz)$c$);