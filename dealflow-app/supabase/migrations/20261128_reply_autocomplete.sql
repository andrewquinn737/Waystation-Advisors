-- Reply follow-up completes itself. There is no manual Done for a 'reply' task any more: the task is marked done when an
-- outbound email_messages row exists to that lead's address (or in a thread the lead wrote in) after the task was created.
-- A trigger on email_messages insert covers both app sends and the Sent-folder sync.
-- The task shows "Waiting for your reply" and becomes overdue after 2 business days in the owner's timezone (due_on = +2 business days;
-- the view lists reply tasks from the day they exist). A later message from the lead re-opens a finished reply task.

create or replace function public.add_business_days(d date, n int) returns date language plpgsql immutable as $$
declare v date := d; k int := 0;
begin
  while k < n loop v := v + 1; if public.is_business_day(v) then k := k + 1; end if; end loop;
  return v;
end $$;

create or replace function public.email_outbound_reply_done() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare t record; v_by uuid; v_at timestamptz := coalesce(new.sent_at, new.created_at, now());
begin
  if new.direction is distinct from 'outbound' then return new; end if;
  select id into v_by from profiles where id = new.created_by;
  for t in
    select st.id, st.dial_id from sequence_tasks st join dials d on d.id = st.dial_id
     where st.kind = 'reply' and st.status in ('pending','failed') and v_at >= st.created_at and d.email is not null
       and ( exists (select 1 from jsonb_array_elements(coalesce(new.to_addresses, '[]'::jsonb)) a
                      where lower(coalesce(a->>'address', a #>> '{}')) = lower(d.email))
          or (new.thread_id is not null and exists (select 1 from email_messages m
                      where m.thread_id = new.thread_id and m.direction = 'inbound' and lower(m.from_address) = lower(d.email))) )
  loop
    update sequence_tasks set status = 'done', outcome = 'replied', completed_at = now(), completed_by = v_by where id = t.id;
    perform seq_maybe_complete(t.dial_id);
  end loop;
  return new;
end $$;
drop trigger if exists email_outbound_reply_done on public.email_messages;
create trigger email_outbound_reply_done after insert on public.email_messages
  for each row execute function public.email_outbound_reply_done();

-- inbound: reply task now due in 2 business days; a new message from a lead who already got an answer re-opens the task
create or replace function public.email_inbound_seq_check() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
declare d record; v_from text := lower(btrim(coalesce(new.from_address,''))); v_txt text; v_known boolean; v_hard boolean;
        v_at timestamptz := coalesce(new.sent_at, new.created_at, now());
begin
  if new.direction is distinct from 'inbound' then return new; end if;
  v_txt := lower(coalesce(new.body_text,'') || ' ' || coalesce(new.subject,''));
  if v_from ~ '^(mailer-daemon|postmaster|mail-daemon)@' or coalesce(new.subject,'') ~* '(undeliver|delivery status notification|delivery has failed|returned mail|failure notice)' then
    v_hard := bounce_is_hard(new.subject, new.body_text);
    for d in select id, email, seq_state from dials where email is not null and sender_account_id = new.account_id
                and (seq_state = 'active' or email_1_message_id is not null)
                and position(lower(email) in v_txt) > 0 loop
      if d.seq_state = 'active' then
        update dials set bounced_at = coalesce(bounced_at, now()) where id = d.id;
        perform seq_stop(d.id, 'bounced', 'Email bounced', false);
      end if;
      if v_hard then perform suppress_email_internal(d.email, 'Hard bounce', 'bounce', null); end if;
    end loop;
    return new;
  end if;
  for d in select id, created_by, list_id from dials where lower(email) = v_from and seq_state = 'active' loop
    perform seq_stop(d.id, 'replied', 'Owner replied by email', false);
    insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on)
    values (d.id, d.list_id, d.created_by, 100, 0, 'reply', add_business_days(person_today(d.created_by), 2))
    on conflict (dial_id, step) do nothing;
  end loop;
  -- they wrote again after we answered: the reply task comes back
  update sequence_tasks st set status = 'pending', outcome = null, completed_at = null, completed_by = null,
         due_on = add_business_days(person_today(st.owner_id), 2)
    from dials dd where dd.id = st.dial_id and lower(dd.email) = v_from and st.kind = 'reply' and st.status = 'done'
     and st.completed_at is not null and v_at > st.completed_at;
  if v_from ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' and reply_wants_stop(new.subject, new.body_text) then
    v_known := exists (select 1 from dials where lower(email) = v_from)
            or exists (select 1 from email_messages o, jsonb_array_elements(coalesce(o.to_addresses, '[]'::jsonb)) a
                        where o.account_id = new.account_id and o.direction = 'outbound' and lower(a->>'address') = v_from);
    if v_known then perform suppress_email_internal(v_from, 'Asked to stop / unsubscribe', 'reply', null); end if;
  end if;
  return new;
end $function$;

-- reply tasks are listed from the day they exist (not only once due); calls and LinkedIn keep the due-date rule
create or replace view public.my_followups with (security_invoker = true) as
  select t.*, case when t.kind = 'reply' then 0 when t.due_on < person_today(t.owner_id) then 1 else 2 end as urgency
    from public.my_tasks t
   where t.kind in ('call','linkedin','call_company','reply') and t.status in ('pending','failed')
     and (t.kind = 'reply' or t.due_on <= person_today(t.owner_id))
   order by (case when t.kind = 'reply' then 0 when t.due_on < person_today(t.owner_id) then 1 else 2 end), t.due_on, t.step;
revoke all on public.my_followups from anon, authenticated;
grant select on public.my_followups to authenticated;

-- trigger / helper functions are not callable by clients
revoke all on function public.email_outbound_reply_done() from public, anon, authenticated;
