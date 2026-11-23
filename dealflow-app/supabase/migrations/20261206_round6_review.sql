-- Round 6 review fixes (security + email/admin). Safe to re-run.
-- 1. Forged paired_event_id: the definer event RPCs only touch the paired event when it points back at this event and sits on a client
--    the caller can reach; and direct writes of paired_event_id / client_events.buyer_id are refused (only log_shared_client_event sets a pair).
-- 2. Reference columns on clients (intended_buyer_id, source_list_id, source_dial_id) must point at things the caller can reach.
--    set_intro_call_time no longer picks someone else's client that squats a dial id.
-- 3. transfer_client_ownership: an intern or lead can only hand a client to an admin or a team lead of their own team.
-- 4. test_call_policy no longer hands the allowlisted number to every user: clients get {free, allow: [] (admins: the list)} and ask
--    test_call_allowed(number) instead. The calls insert trigger uses the internal full policy.
-- 5. mailbox_send_counts reports the real daily cap (20 at most).
-- Live rollout: apply this file once; nothing here changes behaviour for data already stored.

-- ---------- 1. paired events ----------
create or replace function public.event_pair_ok(p_event uuid, p_pair uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_pair is not null and exists (
    select 1 from client_events p
     where p.id = p_pair and p.paired_event_id = p_event and public.client_in_my_scope(p.client_id))
$$;
revoke all on function public.event_pair_ok(uuid, uuid) from public, anon;
grant execute on function public.event_pair_ok(uuid, uuid) to authenticated;

create or replace function public.delete_client_event(p_event_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owns boolean; v_pair uuid;
begin
  select exists(select 1 from client_events ce join clients c on c.id = ce.client_id
    where ce.id = p_event_id and (c.created_by = auth.uid() or is_admin() or is_team_lead_of(c.created_by))) into v_owns;
  if not v_owns then raise exception 'You can only delete an event on a client you created.'; end if;
  select paired_event_id into v_pair from client_events where id = p_event_id;
  if not public.event_pair_ok(p_event_id, v_pair) then v_pair := null; end if;
  delete from client_events where id = p_event_id;
  if v_pair is not null then delete from client_events where id = v_pair; end if;
end $$;

create or replace function public.update_client_event(p_event_id uuid, p_event_date timestamptz, p_time text, p_report text default null, p_timezone text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owns boolean; v_pair uuid;
begin
  select exists(select 1 from client_events ce join clients c on c.id = ce.client_id
    where ce.id = p_event_id and (c.created_by = auth.uid() or is_admin() or is_team_lead_of(c.created_by))) into v_owns;
  if not v_owns then raise exception 'You can only update an event on a client you created.'; end if;
  select paired_event_id into v_pair from client_events where id = p_event_id;
  if not public.event_pair_ok(p_event_id, v_pair) then v_pair := null; end if;
  update client_events set event_date = p_event_date,
      details = coalesce(details, '{}'::jsonb) || jsonb_build_object('time', p_time, 'timezone', p_timezone) ||
        case when p_report is not null then jsonb_build_object('report', p_report) else '{}'::jsonb end
  where id = p_event_id;
  if v_pair is not null then
    update client_events set event_date = p_event_date,
        details = coalesce(details, '{}'::jsonb) || jsonb_build_object('time', p_time, 'timezone', p_timezone) ||
          case when p_report is not null then jsonb_build_object('report', p_report) else '{}'::jsonb end
    where id = v_pair;
  end if;
end $$;

create or replace function public.set_client_event_confirmed(p_event_id uuid, p_confirmed boolean, p_report text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owns boolean; v_pair uuid;
begin
  select exists(select 1 from client_events ce join clients c on c.id = ce.client_id
    where ce.id = p_event_id and (c.created_by = auth.uid() or is_admin() or is_team_lead_of(c.created_by))) into v_owns;
  if not v_owns then raise exception 'You can only update an event on a client you created.'; end if;
  select paired_event_id into v_pair from client_events where id = p_event_id;
  if not public.event_pair_ok(p_event_id, v_pair) then v_pair := null; end if;
  if p_report is not null then
    update client_events set confirmed = p_confirmed, details = coalesce(details, '{}'::jsonb) || jsonb_build_object('report', p_report) where id = p_event_id;
  else
    update client_events set confirmed = p_confirmed where id = p_event_id;
  end if;
  if v_pair is not null then
    if p_report is not null then
      update client_events set confirmed = p_confirmed, details = coalesce(details, '{}'::jsonb) || jsonb_build_object('report', p_report) where id = v_pair;
    else
      update client_events set confirmed = p_confirmed where id = v_pair;
    end if;
  end if;
end $$;

-- log_shared_client_event is the only writer of a pair: it raises the flag the guard below looks for.
create or replace function public.log_shared_client_event(p_client_id uuid, p_counterpart_client_id uuid, p_event_type text, p_event_date timestamptz, p_time text, p_created_by uuid, p_category text default null, p_timezone text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_client record; v_counterpart record; v_id1 uuid; v_id2 uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not exists (select 1 from clients where id = p_client_id and (created_by = auth.uid() or is_admin() or is_team_lead_of(created_by))) then
    raise exception 'You can only log an event on a client you created.';
  end if;
  if not public.client_in_my_scope(p_counterpart_client_id) then raise exception 'Counterpart client not found.'; end if;
  select id, full_name, company_name, client_type into v_client from clients where id = p_client_id;
  select id, full_name, company_name, client_type into v_counterpart from clients where id = p_counterpart_client_id;
  perform set_config('app.pair_write', '1', true);
  insert into client_events (client_id, event_type, event_date, details, created_by)
  values (p_client_id, p_event_type, p_event_date,
          jsonb_build_object('time', p_time, 'timezone', p_timezone, 'category', p_category,
                             'counterpart_client_id', v_counterpart.id, 'counterpart_name', v_counterpart.full_name), auth.uid())
  returning id into v_id1;
  insert into client_events (client_id, event_type, event_date, details, created_by)
  values (p_counterpart_client_id, p_event_type, p_event_date,
          jsonb_build_object('time', p_time, 'timezone', p_timezone, 'category', p_category,
                             'counterpart_client_id', v_client.id, 'counterpart_name', v_client.full_name), auth.uid())
  returning id into v_id2;
  update client_events set paired_event_id = v_id2 where id = v_id1;
  update client_events set paired_event_id = v_id1 where id = v_id2;
  perform set_config('app.pair_write', '', true);
end $$;

create or replace function public.client_events_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then return new; end if;
  if coalesce(current_setting('app.pair_write', true), '') = '1' or pg_trigger_depth() > 1 then return new; end if;   -- depth > 1: the foreign key clearing a pair when its other half is deleted
  if tg_op = 'INSERT' then
    new.paired_event_id := null;
  else
    if new.paired_event_id is distinct from old.paired_event_id then raise exception 'That link cannot be changed here.'; end if;
    if new.buyer_id is distinct from old.buyer_id then raise exception 'The buyer on an event is set by the system.'; end if;
  end if;
  return new;
end $$;
revoke all on function public.client_events_guard() from public, anon, authenticated;
drop trigger if exists client_events_guard on public.client_events;
create trigger client_events_guard before insert or update on public.client_events for each row execute function public.client_events_guard();

-- ---------- 2. reference columns on clients ----------
create or replace function public.clients_ref_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') or auth.uid() is null then return new; end if;
  if new.intended_buyer_id is not null and (tg_op = 'INSERT' or new.intended_buyer_id is distinct from old.intended_buyer_id)
     and not public.client_in_my_scope(new.intended_buyer_id) then
    raise exception 'That buyer is not on your team.';
  end if;
  if new.source_list_id is not null and (tg_op = 'INSERT' or new.source_list_id is distinct from old.source_list_id)
     and not exists (select 1 from dial_lists l where l.id = new.source_list_id and (l.created_by = auth.uid() or is_admin() or is_team_lead_of(l.created_by))) then
    raise exception 'That list is not yours.';
  end if;
  if new.source_dial_id is not null and (tg_op = 'INSERT' or new.source_dial_id is distinct from old.source_dial_id)
     and not exists (select 1 from dials d where d.id = new.source_dial_id and (d.created_by = auth.uid() or is_admin() or is_team_lead_of(d.created_by))) then
    raise exception 'That company is not yours.';
  end if;
  return new;
end $$;
revoke all on function public.clients_ref_guard() from public, anon, authenticated;
drop trigger if exists clients_ref_guard on public.clients;
create trigger clients_ref_guard before insert or update on public.clients for each row execute function public.clients_ref_guard();

-- set_intro_call_time: only look at a client the caller may act on when finding it from a dial id
do $$
declare d text;
begin
  select pg_get_functiondef('public.set_intro_call_time(uuid,uuid,timestamptz,text,text,text,boolean)'::regprocedure) into d;
  d := replace(d, 'select id into v_client from clients where source_dial_id = p_dial_id;',
    'select c.id into v_client from clients c where c.source_dial_id = p_dial_id and (c.created_by = auth.uid() or public.is_admin() or public.is_team_lead_of(c.created_by)) order by c.created_at limit 1;');
  execute d;
end $$;

-- ---------- 3. client transfer stays inside the caller's team ----------
create or replace function public.transfer_client_ownership(p_client_id uuid, p_new_owner uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_new_owner_role text; v_new_owner_name text;
begin
  select created_by into v_owner from clients where id = p_client_id;
  if v_owner is null then raise exception 'Client not found.'; end if;
  if not (v_owner = auth.uid() or is_admin()) then raise exception 'You can only transfer a client you are responsible for.'; end if;
  select role, full_name into v_new_owner_role, v_new_owner_name from profiles where id = p_new_owner;
  if v_new_owner_role is null or v_new_owner_role not in ('team_lead', 'admin') then raise exception 'You can only transfer to a team lead or admin.'; end if;
  if not is_admin() and v_new_owner_role = 'team_lead' and not (public.my_team_ids(p_new_owner) && public.my_team_ids(auth.uid())) then
    raise exception 'You can only transfer to a team lead on your own team, or an admin.';
  end if;
  update clients set created_by = p_new_owner, assigned_to = p_new_owner, intern_name = v_new_owner_name where id = p_client_id;
end $$;

-- ---------- 4. test call lock: the number no longer reaches every user ----------
create or replace function public.test_call_policy_internal() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if not exists (select 1 from app_secrets where key = 'IS_TEST_PROJECT' and value = '1') then return null; end if;
  select value into v from app_secrets where key = 'TEST_CALL_ALLOWLIST';
  return jsonb_build_object('allow', to_jsonb(coalesce(string_to_array(nullif(v,''), ','), '{}'::text[])), 'free', test_call_free_user());
end $$;
revoke all on function public.test_call_policy_internal() from public, anon, authenticated;

create or replace function public.test_call_policy() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p jsonb := public.test_call_policy_internal();
begin
  if p is null then return null; end if;
  return jsonb_build_object('free', coalesce((p->>'free')::boolean, false),
                            'allow', case when public.is_admin() then p->'allow' else '[]'::jsonb end);
end $$;
revoke all on function public.test_call_policy() from public, anon;
grant execute on function public.test_call_policy() to authenticated;

create or replace function public.test_call_allowed(p_number text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare p jsonb := public.test_call_policy_internal();
begin
  if p is null or coalesce((p->>'free')::boolean, false) then return true; end if;
  return exists (select 1 from jsonb_array_elements_text(p->'allow') a where test_call_digits(a) = test_call_digits(p_number));
end $$;
revoke all on function public.test_call_allowed(text) from public, anon;
grant execute on function public.test_call_allowed(text) to authenticated;

create or replace function public.calls_test_lock() returns trigger
language plpgsql security definer set search_path = public as $$
declare pol jsonb;
begin
  if coalesce(auth.role(),'') not in ('authenticated','anon') then return new; end if;
  pol := public.test_call_policy_internal();
  if pol is null or coalesce((pol->>'free')::boolean, false) then return new; end if;
  if not exists (select 1 from jsonb_array_elements_text(pol->'allow') a
                 where test_call_digits(a) = test_call_digits(new.to_number)) then
    raise exception 'Test app: calls limited to the test number' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.calls_test_lock() from public, anon, authenticated;

-- ---------- 5. the daily number on Email accounts is the real cap ----------
create or replace function public.mailbox_send_counts(p_account_id uuid)
returns table(sent integer, scheduled integer, daily_limit integer)
language sql security definer set search_path = public as $$
  select
    (select count(*)::int from email_messages m
      where m.account_id = p_account_id and m.direction = 'outbound' and m.sent_at > now() - interval '24 hours'),
    (select count(*)::int from scheduled_emails s
      where s.account_id = p_account_id and s.status in ('pending','sending')),
    least(20, coalesce((select a.daily_send_limit from email_accounts a where a.id = p_account_id), public.mailbox_daily_limit()));
$$;
