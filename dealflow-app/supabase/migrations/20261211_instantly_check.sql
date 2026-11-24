-- Instantly check: a lead whose address (or, for a personal address, whose company domain) is already in any
-- Instantly campaign is never put on the CRM 5-step. Instantly sends outside the CRM, so the instantly-sync edge
-- function copies every Instantly lead into instantly_leads hourly. Any lead loaded in a campaign counts as emailed:
-- Instantly's API does not say which leads have been sent yet, and a loaded lead is queued to be.
--   * seq_prepare_list routes such leads to the call track ('backup', which starts call3 on the first No answer).
--   * lead_block_reason returns 'instantly', so start_emails moves them to calls instead of starting them.
--   * instantly_apply (called by the sync) moves leads already waiting for copy to calls.

create table if not exists public.instantly_leads (
  email text primary key,
  domain text,
  campaign text,
  first_seen timestamptz not null default now(),
  synced_at timestamptz not null default now()
);
create index if not exists instantly_leads_domain_idx on public.instantly_leads (domain);
alter table public.instantly_leads enable row level security;
revoke all on public.instantly_leads from anon, authenticated;

create or replace function public.instantly_emailed(p_email text) returns boolean
 language sql stable security definer set search_path to 'public' as $$
  select p_email is not null and btrim(p_email) <> '' and exists (
    select 1 from instantly_leads i
     where i.email = norm_email(p_email)
        or (coalesce(is_personal_email(p_email), false) and not dedup_domain_exempt(email_domain(p_email))
            and i.domain = email_domain(p_email))) $$;
revoke all on function public.instantly_emailed(text) from public, anon, authenticated;

create or replace function public.lead_block_reason(p_dial uuid) returns text
 language plpgsql stable security definer set search_path to 'public' as $$
declare d record;
begin
  select id, email into d from dials where id = p_dial;
  if d.id is null then return null; end if;
  if is_suppressed(d.email) then return 'suppressed'; end if;
  if instantly_emailed(d.email) then return 'instantly'; end if;
  if d.email is not null and exists (
       select 1 from dials o join dial_lists l on l.id = o.list_id
        where o.id <> d.id and o.sequence = 'email5' and o.seq_state = 'active' and l.deleted_at is null and o.email is not null
          and (norm_email(o.email) = norm_email(d.email)
               or (is_personal_email(d.email) and email_domain(o.email) = email_domain(d.email) and not dedup_domain_exempt(email_domain(d.email))))) then
    return 'duplicate';
  end if;
  return null;
end $$;

create or replace function public.seq_prepare_list(p_list_id uuid, p_limit integer default null::integer)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v_owner uuid; n_email int := 0; n_backup int := 0; n_nocopy int := 0; n_inst int := 0; v_left int := 0; v_can boolean;
begin
  select created_by into v_owner from dial_lists where id = p_list_id;
  if v_owner is null then raise exception 'List not found'; end if;
  if auth.uid() is null or not coalesce(auth.uid() = v_owner or is_admin() or is_team_lead_of(v_owner), false) then
    raise exception 'No access to that list';
  end if;
  v_can := seq_can_email(v_owner);
  with todo as (
    select id, email, v_can and coalesce(is_personal_email(email), false) as pe0 from dials
     where list_id = p_list_id and sequence is null order by id limit p_limit),
  todo2 as (select id, pe0, pe0 and instantly_emailed(email) as inst from todo),
  up as (
    update dials d set sequence = case when t.pe0 and not t.inst then 'email5' else 'backup' end,
                       seq_state = case when t.pe0 and not t.inst then 'awaiting_copy' else null end,
                       seq_stop_reason = case when t.inst then 'Not emailed: already in an Instantly campaign. On the call track.' else d.seq_stop_reason end
      from todo2 t where d.id = t.id
    returning (t.pe0 and not t.inst) as pe, t.inst as inst,
              (coalesce(btrim(d.email_1),'') = '' or coalesce(btrim(d.email_subject),'') = '') as nocopy)
  select count(*) filter (where pe), count(*) filter (where not pe), count(*) filter (where pe and nocopy), count(*) filter (where inst)
    into n_email, n_backup, n_nocopy, n_inst from up;
  select count(*) into v_left from dials where list_id = p_list_id and sequence is null;
  update dial_lists set copy_status = 'pending_review'
   where id = p_list_id and copy_status = 'none'
     and exists (select 1 from dials where list_id = p_list_id and sequence = 'email5' and seq_state = 'awaiting_copy');
  return jsonb_build_object('email_sequence', n_email, 'backup', n_backup, 'call_sequence', n_backup, 'missing_copy', n_nocopy,
                            'already_in_instantly', n_inst, 'remaining', v_left, 'can_email', v_can);
end $$;
revoke all on function public.seq_prepare_list(uuid, int) from public, anon;
grant execute on function public.seq_prepare_list(uuid, int) to authenticated;

-- Called by instantly-sync with [{email, campaign}, ...]. Upserts, then moves matching leads still waiting for copy to calls.
create or replace function public.instantly_apply(p_rows jsonb) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare n_up int; n_moved int := 0; r record;
begin
  insert into instantly_leads (email, domain, campaign, synced_at)
  select distinct on (norm_email(x->>'email')) norm_email(x->>'email'), email_domain(x->>'email'), left(x->>'campaign', 200), now()
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
   where coalesce(btrim(x->>'email'), '') like '%@%'
  on conflict (email) do update set campaign = excluded.campaign, domain = excluded.domain, synced_at = now();
  get diagnostics n_up = row_count;
  for r in select d.id from dials d join dial_lists l on l.id = d.list_id
            where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and l.deleted_at is null and instantly_emailed(d.email)
  loop
    perform seq_to_backup(r.id, 'Not emailed: already in an Instantly campaign. Moved to calls.');
    n_moved := n_moved + 1;
  end loop;
  return jsonb_build_object('upserted', n_up, 'moved_to_calls', n_moved);
end $$;
revoke all on function public.instantly_apply(jsonb) from public, anon, authenticated;
grant execute on function public.instantly_apply(jsonb) to service_role;

create or replace function public.run_instantly_sync() returns void
 language plpgsql security definer set search_path to 'public' as $$
declare v_url text; v_bearer text; v_secret text;
begin
  select replace(value, '/email-send', '/instantly-sync') into v_url from app_secrets where key = 'dispatch_fn_url';
  select value into v_bearer from app_secrets where key = 'dispatch_bearer';
  select value into v_secret from app_secrets where key = 'dispatch_cron_secret';
  if v_url is null or v_bearer is null or v_secret is null then raise exception 'dispatch settings missing in app_secrets'; end if;
  perform net.http_post(url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_bearer, 'x-cron-secret', v_secret),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
end $$;
revoke all on function public.run_instantly_sync() from public, anon, authenticated;

do $$ begin perform cron.unschedule('instantly-sync'); exception when others then null; end $$;
select cron.schedule('instantly-sync', '7 * * * *', 'select public.run_instantly_sync()');

-- start_emails: an 'instantly' block moves the lead to calls (counted with duplicates).
CREATE OR REPLACE FUNCTION public.start_emails(p_list_id uuid, p_count integer DEFAULT NULL::integer, p_dial_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_list record; r record; v_day0 date; v_tz text; v_started int := 0; v_backup int := 0; v_unver int := 0;
  v_susp int := 0; v_dup int := 0; v_block text; v_seen int := 0;
  v_held int; v_ready int; v_cap int := 0; v_firsts int; v_day_cap int := 0; v_now timestamptz := now(); b uuid;
  v_no_email int; v_backup_all int;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  perform pg_advisory_xact_lock(hashtextextended('start_emails:' || p_list_id::text, 0));
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
    elsif v_block = 'instantly' then
      perform seq_to_backup(r.id, 'Not emailed: this address or company is already in an Instantly campaign. Moved to calls.');
      v_dup := v_dup + 1;
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
end $function$;
