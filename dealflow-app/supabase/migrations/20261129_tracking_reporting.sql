-- Tracking / reporting / intro-call scheduling stage (2026-11-29).
-- Findings from docs/LIVE_USAGE_MAP.md this fixes:
--   * 95% of busy_callback / callback_interested dials had no callback_at (the time modal could be cancelled).
--   * 110 dials sit in "intro call scheduled" but only 60 have a client; 29 of 92 intro events are backdated; the intro_call_log
--     credit was written by the browser BEFORE the client/event existed (98 log rows vs 92 events).
--   * call_status_changes could get two rows for one user/dial/day/method (12 on the live copy) -> a contact counted twice.
--   * report_dial_rollups only refreshed this and last week, so a category corrected afterwards never reached older weeks.
--   * notifications were never marked read.
-- Everything here is schema/functions only. Data fixes for TEST live in tools/testenv/backfill_tracking.py (see the live notes there).

-- ---------------------------------------------------------------------------------------------------------------------
-- 0. helpers
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.next_business_morning(p_tz text, p_hour int default 10) returns timestamptz
language plpgsql stable set search_path = public as $$
declare v_tz text := coalesce(nullif(p_tz, ''), 'America/Denver'); d date;
begin
  begin d := (now() at time zone v_tz)::date + 1; exception when others then v_tz := 'America/Denver'; d := (now() at time zone v_tz)::date + 1; end;
  while extract(isodow from d) >= 6 loop d := d + 1; end loop;
  return (d::timestamp + make_interval(hours => p_hour)) at time zone v_tz;
end $$;

create or replace function public.notify_user(p_user uuid, p_msg text, p_type text, p_link text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  if (select notifications_enabled from profiles where id = p_user) is not false then
    insert into notifications (user_id, message, type, link) values (p_user, p_msg, p_type, p_link);
  end if;
end $$;
revoke execute on function public.notify_user(uuid, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. callbacks always carry a time
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.dials add column if not exists callback_defaulted boolean not null default false;

create or replace function public.dials_default_callback() returns trigger
language plpgsql security definer set search_path = public as $$
declare tz text; v_in boolean; v_was boolean;
begin
  v_in  := new.contact_status in ('busy_callback', 'callback_interested');
  v_was := tg_op = 'UPDATE' and old.contact_status in ('busy_callback', 'callback_interested');
  if v_in then
    if new.callback_at is null or (not v_was and new.callback_at < now()) then
      select coalesce(nullif(p.timezone, ''), 'America/Denver') into tz from profiles p where p.id = coalesce(auth.uid(), new.created_by);
      new.callback_at := public.next_business_morning(tz, 10);
      new.callback_user_id := coalesce(auth.uid(), new.callback_user_id, new.created_by);
      new.callback_reminded_at := null;
      new.callback_defaulted := true;
    elsif tg_op = 'UPDATE' and new.callback_at is distinct from old.callback_at then
      new.callback_defaulted := false;                       -- someone picked the time themselves
      new.callback_user_id := coalesce(new.callback_user_id, auth.uid(), new.created_by);
    end if;
  elsif v_was then                                           -- left the callback categories: the reminder no longer applies
    new.callback_at := null; new.callback_user_id := null; new.callback_reminded_at := null; new.callback_defaulted := false;
  end if;
  return new;
end $$;
drop trigger if exists dials_default_callback on public.dials;
create trigger dials_default_callback before update of contact_status, callback_at on public.dials
  for each row execute function public.dials_default_callback();
revoke execute on function public.dials_default_callback() from public, anon, authenticated;

-- Overdue callbacks: one reminder per day per callback that is still open and more than 30 minutes late (the minute job only
-- covers the 5 minutes before / 30 minutes after the time).
create or replace function public.run_overdue_callback_digest() returns void
language plpgsql security definer set search_path = public as $$
declare r record; v_today date;
begin
  for r in
    select d.callback_user_id as uid, count(*) n, min(d.id::text)::uuid as first_id
    from dials d join dial_lists dl on dl.id = d.list_id and dl.deleted_at is null
    where d.callback_at is not null and d.callback_user_id is not null and d.callback_at < now() - interval '30 minutes'
      and d.callback_at > now() - interval '14 days' and d.contact_status in ('busy_callback', 'callback_interested')
    group by 1
  loop
    v_today := (now() at time zone coalesce((select nullif(timezone, '') from profiles where id = r.uid), 'America/Denver'))::date;
    if not exists (select 1 from notifications n where n.user_id = r.uid and n.type = 'callback_overdue'
                   and (n.created_at at time zone coalesce((select nullif(timezone, '') from profiles where id = r.uid), 'America/Denver'))::date = v_today) then
      perform public.notify_user(r.uid, r.n || case when r.n = 1 then ' callback is' else ' callbacks are' end || ' overdue. Open one to call them back.',
                                 'callback_overdue', '/dials.html?dial=' || r.first_id);
    end if;
  end loop;
end $$;
revoke execute on function public.run_overdue_callback_digest() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. one contact marker per user / dial / method / day
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.csc_no_duplicate_day() returns trigger
language plpgsql security definer set search_path = public as $$
declare tz text; ds timestamptz;
begin
  if new.dial_id is null or new.user_id is null then return new; end if;
  select coalesce(nullif(p.timezone, ''), 'America/Denver') into tz from profiles p where p.id = new.user_id;
  tz := coalesce(tz, 'America/Denver');
  begin ds := date_trunc('day', new.changed_at at time zone tz) at time zone tz; exception when others then ds := date_trunc('day', new.changed_at); end;
  if exists (select 1 from call_status_changes c where c.dial_id = new.dial_id and c.user_id = new.user_id
             and c.contact_method is not distinct from new.contact_method and c.changed_at >= ds and c.changed_at < ds + interval '1 day') then
    return null;                                             -- already counted today for this number: skip, never double count
  end if;
  return new;
end $$;
drop trigger if exists csc_no_duplicate_day on public.call_status_changes;
create trigger csc_no_duplicate_day before insert on public.call_status_changes
  for each row execute function public.csc_no_duplicate_day();
revoke execute on function public.csc_no_duplicate_day() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. "Intro booked" always creates / links the client + the intro event (never an orphan, never backdated on its own)
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.intro_call_log add column if not exists client_id uuid references public.clients(id) on delete cascade;
create unique index if not exists intro_call_log_client_unique on public.intro_call_log (client_id) where client_id is not null;

create or replace function public.intro_recipients(p_creator uuid) returns table(uid uuid)
language sql stable security definer set search_path = public as $$
  select p.id from profiles p
  where p.id <> coalesce(p_creator, '00000000-0000-0000-0000-000000000000'::uuid)
    and ((p.role = 'admin' and p.id = (select a.id from profiles a where a.role = 'admin' order by a.created_at, a.id limit 1))   -- the main admin
         or (p.role = 'team_lead' and exists (select 1 from profiles c where c.id = p_creator and c.team_id is not null and c.team_id = any (public.my_team_ids(p.id)))))
$$;
revoke execute on function public.intro_recipients(uuid) from public, anon, authenticated;

-- Creates (or links) the client of a dial in "intro call scheduled" and makes sure it has an intro event. Used by the status trigger
-- below and by the TEST backfill.
create or replace function public.ensure_intro_client_for_dial(p_dial_id uuid, p_actor uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare d record; v_list record; v_type text; v_client uuid; v_name text; v_actor_name text;
begin
  select * into d from dials where id = p_dial_id;
  if d.id is null then return null; end if;
  select * into v_list from dial_lists where id = d.list_id;
  v_type := coalesce(v_list.dial_type, 'seller');
  select id into v_client from clients where source_dial_id = d.id;
  if v_client is null then
    v_name := coalesce(nullif(btrim(d.full_name), ''), nullif(btrim(d.company_name), ''), 'Unnamed owner');
    select full_name into v_actor_name from profiles where id = p_actor;
    insert into clients (client_type, full_name, city, state, email, mobile_phone, company_phone, linkedin, company_name, industry, other_notes,
                         intern_name, assigned_to, created_by, source_list_id, intended_buyer_id, website, source_dial_id)
    values (v_type, v_name, coalesce(d.city, ''), coalesce(d.state, ''), coalesce(d.email, ''), coalesce(d.mobile_phone, ''), coalesce(d.company_phone, ''),
            coalesce(d.linkedin, ''), case when v_type = 'seller' then coalesce(d.company_name, '') else '' end,
            case when v_type = 'seller' then coalesce(d.industry, '') else '' end, coalesce(d.call_notes, ''),
            coalesce(v_actor_name, ''), p_actor, p_actor, d.list_id, case when v_type = 'seller' then v_list.buyer_id else null end, d.website, d.id)
    returning id into v_client;
  end if;
  if not exists (select 1 from client_events where client_id = v_client and event_type = 'intro_call') then
    -- No date is invented in the past: the placeholder is tomorrow, flagged "time to be set" until the real time is entered.
    insert into client_events (client_id, event_type, event_date, details, created_by)
    values (v_client, 'intro_call', now() + interval '1 day', jsonb_build_object('time_pending', true, 'auto', true, 'via', 'dial'), p_actor);
  end if;
  return v_client;
end $$;
revoke execute on function public.ensure_intro_client_for_dial(uuid, uuid) from public, anon, authenticated;

-- Status -> "intro call scheduled" (from any screen, any role): the client and a pending intro event exist from that moment.
create or replace function public.dials_intro_booked() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_client uuid; v_auto_event uuid;
begin
  if new.contact_status = 'intro_call_scheduled' and old.contact_status is distinct from 'intro_call_scheduled' then
    perform public.ensure_intro_client_for_dial(new.id, coalesce(auth.uid(), new.created_by));
  elsif old.contact_status = 'intro_call_scheduled' and new.contact_status is distinct from 'intro_call_scheduled' then
    -- Tapped by mistake and corrected before any time was entered: remove the placeholder (and the client only if it is still empty).
    select c.id into v_client from clients c where c.source_dial_id = new.id;
    if v_client is not null then
      select e.id into v_auto_event from client_events e
        where e.client_id = v_client and e.event_type = 'intro_call' and e.confirmed = false
          and coalesce((e.details->>'time_pending')::boolean, false) and coalesce((e.details->>'auto')::boolean, false) limit 1;
      if v_auto_event is not null then
        delete from client_events where id = v_auto_event;
        delete from intro_call_log where client_id = v_client;
        if not exists (select 1 from client_events where client_id = v_client and event_type <> 'created')
           and not exists (select 1 from email_messages where client_id = v_client) then
          delete from clients where id = v_client;
        end if;
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists dials_intro_booked on public.dials;
create trigger dials_intro_booked after update of contact_status on public.dials
  for each row execute function public.dials_intro_booked();
revoke execute on function public.dials_intro_booked() from public, anon, authenticated;

-- Every new intro_call event: one credit per client in the intro log (the Profile "Intro calls" count), and a team notification.
create or replace function public.client_event_intro_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record; v_who text; v_when text; r record; v_tz text;
begin
  if new.event_type <> 'intro_call' then return new; end if;
  select cl.id, cl.client_type, cl.full_name, cl.created_by into c from clients cl where cl.id = new.client_id;
  if c.id is null then return new; end if;
  insert into intro_call_log (user_id, client_type, scheduled_at, client_id)
  select coalesce(new.created_by, c.created_by), coalesce(c.client_type, 'seller'), new.created_at, c.id
  where not exists (select 1 from intro_call_log l where l.client_id = c.id)
  on conflict do nothing;
  select full_name into v_who from profiles where id = coalesce(new.created_by, c.created_by);
  for r in select uid from public.intro_recipients(coalesce(new.created_by, c.created_by)) loop
    select nullif(timezone, '') into v_tz from profiles where id = r.uid;
    v_when := case when coalesce((new.details->>'time_pending')::boolean, false) then 'time to be set'
                   else to_char(new.event_date at time zone coalesce(v_tz, 'America/Chicago'), 'Dy Mon FMDD, FMHH12:MI AM') end;
    perform public.notify_user(r.uid, coalesce(v_who, 'A teammate') || ' booked an intro call with ' || coalesce(c.full_name, 'a new client') || ' (' || v_when || ').',
                               'intro_booked', '/clients.html?client=' || c.id);
  end loop;
  return new;
end $$;
drop trigger if exists client_event_intro_created on public.client_events;
create trigger client_event_intro_created after insert on public.client_events
  for each row execute function public.client_event_intro_created();
revoke execute on function public.client_event_intro_created() from public, anon, authenticated;

-- The single entry point the app uses to put a real time on the intro call (replaces direct client_events inserts).
-- Updates the pending / unconfirmed intro event of the client instead of adding a second one; refuses a time in the past
-- unless the caller says it already happened (p_past_ok).
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
      details = (coalesce(details, '{}'::jsonb) - 'time_pending' - 'auto') || jsonb_build_object('via', p_via, 'time', p_time, 'timezone', p_timezone)
    where id = v_event;
    select full_name into v_who from profiles where id = auth.uid();
    if v_was_pending then
      for r in select uid from public.intro_recipients(v_creator) loop
        select nullif(timezone, '') into v_tz from profiles where id = r.uid;
        v_when := to_char(p_event_date at time zone coalesce(v_tz, 'America/Chicago'), 'Dy Mon FMDD, FMHH12:MI AM');
        perform public.notify_user(r.uid, 'Intro call time set for ' || coalesce(v_name, 'a client') || ': ' || v_when || '.', 'intro_booked', '/clients.html?client=' || v_client);
      end loop;
    end if;
  else
    insert into client_events (client_id, event_type, event_date, details, created_by)
    values (v_client, 'intro_call', p_event_date, jsonb_build_object('via', p_via, 'time', p_time, 'timezone', p_timezone), coalesce(auth.uid(), v_creator))
    returning id into v_event;                               -- the insert trigger writes the log credit and notifies the team
  end if;
  return v_event;
end $$;
grant execute on function public.set_intro_call_time(uuid, uuid, timestamptz, text, text, text, boolean) to authenticated;

-- Prompt to confirm once the date has passed: owner gets a notification 30 min after the call time, again each day, 3 times max.
create or replace function public.run_intro_confirm_prompts() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select e.id, e.details, c.id as client_id, c.full_name, c.created_by
    from client_events e join clients c on c.id = e.client_id
    where e.event_type = 'intro_call' and e.confirmed = false
      and not coalesce((e.details->>'time_pending')::boolean, false)
      and e.event_date < now() - interval '30 minutes' and e.event_date > now() - interval '14 days'
      and coalesce((e.details->>'confirm_prompts')::int, 0) < 3
      and (e.details->>'confirm_prompted_at' is null or (e.details->>'confirm_prompted_at')::timestamptz < now() - interval '23 hours')
  loop
    perform public.notify_user(r.created_by, 'Did your intro call with ' || coalesce(r.full_name, 'your client') || ' happen? Open the client and confirm it.',
                               'intro_confirm', '/clients.html?client=' || r.client_id);
    update client_events set details = coalesce(details, '{}'::jsonb) || jsonb_build_object('confirm_prompts', coalesce((r.details->>'confirm_prompts')::int, 0) + 1, 'confirm_prompted_at', now())
    where id = r.id;
  end loop;
end $$;
revoke execute on function public.run_intro_confirm_prompts() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. reports: refresh the last 4 weeks (a corrected category must reach older weeks); never overwrite a week with no log rows
-- ---------------------------------------------------------------------------------------------------------------------
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'compute_report_rollups';
  v_new := v_def;
  if v_new not like '%v_week_start - 21%' then
    v_new := replace(v_new, 'array[v_week_start, v_week_start - 7]', 'array[v_week_start, v_week_start - 7, v_week_start - 14, v_week_start - 21]');
    v_new := replace(v_new, E'    v_period_end_excl := v_period_start + 5;\n',
      E'    v_period_end_excl := v_period_start + 5;\n    if not exists (select 1 from call_status_changes x where x.changed_at >= (v_period_start::timestamp at time zone ''America/Chicago'') and x.changed_at < (v_period_end_excl::timestamp at time zone ''America/Chicago'')) then continue; end if;\n');
  end if;
  if v_new not like '%rollup rows no longer backed%' then
    -- rows of a period this run did not rewrite (their tab/dial was deleted) are stale: remove them, but only when the log still has data for the period
    v_new := replace(v_new, E'computed_at = now();\n    end loop;\n',
      E'computed_at = now();\n    end loop;\n    -- rollup rows no longer backed by the log\n    delete from report_dial_rollups where period_start = v_period_start and period_type = case when v_period_end_excl - v_period_start = 5 then ''week'' else ''month'' end and computed_at < now() and exists (select 1 from call_status_changes x where x.changed_at >= (v_period_start::timestamp at time zone ''America/Chicago'') and x.changed_at < (v_period_end_excl::timestamp at time zone ''America/Chicago''));\n');
  end if;
  if v_new = v_def then return; end if;
  if v_new not like '%v_week_start - 21%' or v_new not like '%then continue; end if;%' or v_new not like '%rollup rows no longer backed%' then raise exception 'compute_report_rollups patch did not apply'; end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Calendly connection (admin only; the token is never readable from the browser)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.calendly_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return jsonb_build_object(
    'connected', exists (select 1 from app_secrets where key = 'CALENDLY_TOKEN' and btrim(value) <> '') and exists (select 1 from app_secrets where key = 'CALENDLY_EVENT_TYPE_URI' and btrim(value) <> ''),
    'has_token', exists (select 1 from app_secrets where key = 'CALENDLY_TOKEN' and btrim(value) <> ''),
    'event_type_uri', (select value from app_secrets where key = 'CALENDLY_EVENT_TYPE_URI'));
end $$;
grant execute on function public.calendly_status() to authenticated;

create or replace function public.calendly_connect(p_token text, p_event_type_uri text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_token is not null and btrim(p_token) <> '' then
    insert into app_secrets (key, value) values ('CALENDLY_TOKEN', btrim(p_token)) on conflict (key) do update set value = excluded.value;
  end if;
  if p_event_type_uri is not null and btrim(p_event_type_uri) <> '' then
    insert into app_secrets (key, value) values ('CALENDLY_EVENT_TYPE_URI', btrim(p_event_type_uri)) on conflict (key) do update set value = excluded.value;
  end if;
end $$;
grant execute on function public.calendly_connect(text, text) to authenticated;

create or replace function public.calendly_disconnect() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  delete from app_secrets where key in ('CALENDLY_TOKEN', 'CALENDLY_EVENT_TYPE_URI');
end $$;
grant execute on function public.calendly_disconnect() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. jobs
-- ---------------------------------------------------------------------------------------------------------------------
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('intro-confirm-prompts', 'overdue-callback-digest');
  perform cron.schedule('intro-confirm-prompts', '*/15 * * * *', 'select public.run_intro_confirm_prompts()');
  perform cron.schedule('overdue-callback-digest', '*/30 * * * *', 'select public.run_overdue_callback_digest()');
exception when others then raise notice 'cron not available: %', sqlerrm;
end $$;
