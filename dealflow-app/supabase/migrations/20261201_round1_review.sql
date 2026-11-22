-- Round 1 page-by-page review fixes (TEST first; idempotent).
-- 1. Speed: RLS policies call auth.uid()/is_admin() once per query instead of once per row; missing indexes on dials and
--    call_status_changes; profile_companies_contacted rewritten as one join (it re-scanned the log once per bucket).
-- 2. Old inbound bounce rows flagged is_system (the insert trigger only covered rows added after it existed).
-- 3. reopen_sequence_task (put a call task back if the outcome save failed), add_intro_call (a second, separate intro call),
--    set_intro_call_time keeps the "time to be set" flags when no time is given, ai_setup_command (admin-only), and
--    admin_campaigns(p_fresh) so the Campaigns page can read cached stats and refresh them in the background.
set check_function_bodies = off;

-- ---------------------------------------------------------------- 1. speed
alter policy dials_select_own on public.dials using ((created_by = (select auth.uid())) or (select public.is_admin()) or public.is_team_lead_of(created_by));
alter policy dials_update_own on public.dials using ((created_by = (select auth.uid())) or (select public.is_admin()) or public.is_team_lead_of(created_by));
alter policy dials_delete_own on public.dials using ((created_by = (select auth.uid())) or (select public.is_admin()) or public.is_team_lead_of(created_by));
alter policy dial_lists_select_own on public.dial_lists using (
  ((deleted_at is null) and ((created_by = (select auth.uid())) or (select public.is_admin()) or public.is_team_lead_of(created_by)))
  or ((deleted_at is not null) and (select public.is_admin())));
alter policy call_status_changes_select_all on public.call_status_changes using ((select auth.uid()) is not null);

create index if not exists dials_email_idx on public.dials (email) where email is not null;            -- Inbox sequence badges (email IN (...))
create index if not exists dials_list_id_idx on public.dials (list_id);                                 -- opening a list
create index if not exists dials_created_by_idx on public.dials (created_by);
create index if not exists dials_called_today_idx on public.dials (created_by, called_today_date) where called_today_date is not null;
create index if not exists call_status_changes_user_type_at_idx on public.call_status_changes (user_id, dial_type, changed_at);
create index if not exists call_status_changes_dial_idx on public.call_status_changes (dial_id);

create or replace function public.profile_companies_contacted(p_user_ids uuid[], p_dial_type text, p_starts timestamptz[], p_ends timestamptz[])
 returns table(bucket integer, n bigint) language sql stable set search_path to 'public' as $$
  select t.i::int, count(distinct coalesce(c.dial_id::text, lower(c.company_name)))
    from unnest(p_starts, p_ends) with ordinality as t(s, e, i)
    left join call_status_changes c on c.user_id = any(p_user_ids) and c.dial_type = p_dial_type and c.changed_at >= t.s and c.changed_at < t.e
   group by t.i order by t.i
$$;

-- ---------------------------------------------------------------- 2. old bounce rows (idempotent backfill)
update public.email_messages set system_kind = public.email_system_kind(from_address, subject), is_system = true
 where direction = 'inbound' and is_system = false and public.email_system_kind(from_address, subject) is not null;

-- ---------------------------------------------------------------- 3. calls / intro calls
create or replace function public.reopen_sequence_task(p_task_id uuid) returns void
 language plpgsql security definer set search_path to 'public' as $$
declare t record;
begin
  select * into t from sequence_tasks where id = p_task_id for update;
  if t is null then raise exception 'Task not found'; end if;
  if auth.uid() is null or not coalesce(auth.uid() = t.owner_id or is_admin() or is_team_lead_of(t.owner_id), false) then raise exception 'Not your task'; end if;
  if t.status <> 'done' or t.completed_by is distinct from auth.uid() or t.completed_at < now() - interval '10 minutes' then return; end if;  -- only an undo of what was just saved
  update sequence_tasks set status = 'pending', outcome = null, note = null, completed_at = null, completed_by = null where id = p_task_id;
  update dials set seq_state = 'active' where id = t.dial_id and seq_state = 'completed';
end $$;
revoke execute on function public.reopen_sequence_task(uuid) from public, anon;
grant execute on function public.reopen_sequence_task(uuid) to authenticated;

create or replace function public.add_intro_call(p_client_id uuid, p_event_date timestamptz, p_time text, p_timezone text,
                                                 p_via text default 'calendly_link', p_past_ok boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_creator uuid; v_event uuid;
begin
  select created_by into v_creator from clients where id = p_client_id;
  if v_creator is null then raise exception 'Client not found.'; end if;
  if not (v_creator = auth.uid() or public.is_admin() or public.is_team_lead_of(v_creator)) then
    raise exception 'You can only schedule an intro call on a client you created.';
  end if;
  if p_event_date is null then raise exception 'Pick a date and time.'; end if;
  if p_event_date < now() - interval '5 minutes' and not coalesce(p_past_ok, false) then raise exception 'That time has already passed.'; end if;
  insert into client_events (client_id, event_type, event_date, details, created_by)
  values (p_client_id, 'intro_call', p_event_date, jsonb_build_object('via', p_via, 'time', p_time, 'timezone', p_timezone), coalesce(auth.uid(), v_creator))
  returning id into v_event;                                  -- the insert trigger writes the log credit and notifies the team
  return v_event;
end $$;
revoke execute on function public.add_intro_call(uuid, timestamptz, text, text, text, boolean) from public, anon;
grant execute on function public.add_intro_call(uuid, timestamptz, text, text, text, boolean) to authenticated;

-- set_intro_call_time: unchanged except a move with NO time given keeps the "time to be set" flags (it used to drop them)
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
    where e.client_id = v_client and e.event_type = 'intro_call' and e.confirmed = false order by e.created_at desc limit 1;
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

-- ---------------------------------------------------------------- 4. admin: setup command (admins only) + cached campaign stats
create or replace function public.ai_setup_command() returns text
 language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not coalesce(is_admin(), false) then return null; end if;
  return nullif(btrim(coalesce((select value from app_secrets where key = 'ai_worker_setup_command'), '')), '');
end $$;
revoke execute on function public.ai_setup_command() from public, anon;
grant execute on function public.ai_setup_command() to authenticated;

drop function if exists public.admin_campaigns();
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
             'contacted', count(*) filter (where d.email_1_message_id is not null or d.seq_state in ('replied','completed')),
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

-- ---------------------------------------------------------------- 5. import duplicate check also names the EXISTING lead
drop function if exists public.import_dup_check(text[], text[]);
create or replace function public.import_dup_check(p_emails text[], p_phones text[])
returns table(kind text, key text, list_id uuid, list_name text, owner_name text, contact_status text, lead_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from profiles where id = auth.uid() and role in ('admin', 'team_lead')) then
    raise exception 'Only admins and team leads can check imports';
  end if;
  return query
  select distinct on (m.kind, m.key) m.kind, m.key, m.list_id, m.list_name, m.owner_name, m.contact_status, m.lead_name
  from (
    select 'email'::text as kind, norm_email(d.email) as key, d.list_id, l.name as list_name, p.full_name as owner_name,
           d.contact_status, d.created_at, coalesce(nullif(btrim(d.company_name), ''), nullif(btrim(d.full_name), '')) as lead_name
      from dials d join dial_lists l on l.id = d.list_id and l.deleted_at is null
      left join profiles p on p.id = l.created_by
     where d.email is not null and norm_email(d.email) in (select norm_email(e) from unnest(coalesce(p_emails, '{}')) e)
    union all
    select 'phone', ph.k, d.list_id, l.name, p.full_name, d.contact_status, d.created_at, coalesce(nullif(btrim(d.company_name), ''), nullif(btrim(d.full_name), ''))
      from dials d join dial_lists l on l.id = d.list_id and l.deleted_at is null
      left join profiles p on p.id = l.created_by
      cross join lateral (select right(regexp_replace(x, '\D', '', 'g'), 10) as k
                            from unnest(array[d.mobile_phone, d.company_phone]) x where x is not null) ph
     where length(ph.k) = 10 and ph.k = any (coalesce(p_phones, '{}'))
  ) m
  order by m.kind, m.key, m.created_at desc;
end $$;
revoke all on function public.import_dup_check(text[], text[]) from public, anon;
grant execute on function public.import_dup_check(text[], text[]) to authenticated;
