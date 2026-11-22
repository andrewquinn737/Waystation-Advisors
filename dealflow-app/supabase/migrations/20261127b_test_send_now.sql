-- TEST-ONLY "send now" switch. NEVER enable on live.
--   app_secrets 'test_send_now' = 'true' makes sequence_dispatch ignore the weekday / 8:30-17:00 owner window, the
--   9:00-16:00 recipient window and the first-email due date, so a test campaign can run any time. All caps, 4-9 min
--   spacing, verification, uniqueness and suppression still apply. Follow-ups still obey their due date.
--   GUARD: test_send_now_on() is true only when the flag is set AND app_secrets.dispatch_fn_url points at a project that is
--   NOT the live ref (jabjrhkhnbabfihodqie). A trigger also refuses to store the flag on a live database at all.
create or replace function public.test_send_now_on() returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from app_secrets where key = 'test_send_now' and lower(btrim(value)) = 'true')
     and exists (select 1 from app_secrets where key = 'dispatch_fn_url' and value like 'https://%.supabase.co/%' and value not like '%jabjrhkhnbabfihodqie%')
$$;
create or replace function public.app_secrets_no_test_flag_on_live() returns trigger language plpgsql as $$
begin
  if new.key = 'test_send_now' and (not exists (select 1 from app_secrets where key = 'dispatch_fn_url' and value like 'https://%.supabase.co/%')
      or exists (select 1 from app_secrets where key = 'dispatch_fn_url' and value like '%jabjrhkhnbabfihodqie%')) then
    raise exception 'test_send_now can only be set on the TEST project';
  end if;
  return new;
end $$;
drop trigger if exists app_secrets_no_test_flag_on_live on public.app_secrets;
create trigger app_secrets_no_test_flag_on_live before insert or update on public.app_secrets
  for each row execute function public.app_secrets_no_test_flag_on_live();
revoke all on function public.test_send_now_on() from public, anon, authenticated;
grant execute on function public.test_send_now_on() to service_role;

create or replace function public.sequence_dispatch(p_now timestamptz default now()) returns int
 language plpgsql security definer set search_path to 'public' as $$
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
    continue when not v_tsn and (not is_business_day(v_today) or v_local::time < '08:30' or v_local::time >= '17:00');   -- test_send_now: TEST project only
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
end $$;
