-- Round 4 review fixes (security / email / calls). Ships to live AFTER 20261201 .. 20261203, in that order.
--
-- ============================================================================================================
-- SECTIONS 1, 2 AND 3 ARE LIVE SECURITY HOTFIXES. They are self-contained (they use nothing from sections 4+),
-- so if the rest of this file has to wait, run ONLY sections 1-3b on live first (copy them out as-is; each
-- section is idempotent). Everything below the "END OF LIVE HOTFIXES" line can follow on the normal rollout.
--   1. is_team_lead() was `select true`: anyone, including ANON, could read / write buyers, sellers, deals,
--      commissions and subscription_payments.
--   2. profiles self-update: any signed-in user could flip sourcing_access / sourcing_send_access (and anything
--      else except role / team_id) on their own row.
--   3. SECURITY DEFINER functions without a caller check (log_shared_client_event, get_client_full_name,
--      get_buyer_*, seq_maybe_complete, seq_pick_sender, get_questionnaire_buyer_ids, match_mailbox_owner, person_tz,
--      my_team_ids for anon).
-- ============================================================================================================

-- ============================================================ 1. LIVE HOTFIX: is_team_lead() is a real check
create or replace function public.is_team_lead() returns boolean
 language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('team_lead', 'admin'));
$$;

-- the five legacy finance / deal tables: signed-in users only (policies were role public), nothing for anon
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
            where schemaname = 'public' and tablename in ('buyers', 'sellers', 'deals', 'commissions', 'subscription_payments') loop
    execute format('alter policy %I on %I.%I to authenticated', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;
revoke all on table public.buyers, public.sellers, public.deals, public.commissions, public.subscription_payments from anon;
revoke execute on function public.is_team_lead() from public, anon;
grant execute on function public.is_team_lead() to authenticated, service_role;

-- ============================================================ 2. LIVE HOTFIX: profiles self-update lock
-- A non-admin may change only personal fields. Everything else (role, team_id, sourcing_access, sourcing_send_access,
-- id, created_at and any column added later) is admin-only. The allowed list = the fields the app's own pages write:
-- Profile (name, phone, email, calendly), Calls > Advanced (autodial, transcript calling, recording switches),
-- Notifications, email templates, texting template, avatar, the daily-notification stamp, timezone, onboarding.
-- (The recording switches are in the list on purpose: people turn them on and off for THEIR OWN calls in
-- Calls > Advanced, so locking them would break that screen. Move them out of the list to make them admin-only.)
-- Service role / cron / SQL console (auth.uid() is null) are not restricted.
create or replace function public.protect_profile_admin_fields() returns trigger
 language plpgsql set search_path to 'public', 'pg_temp' as $$
declare
  v_self text[] := array['full_name', 'phone', 'email', 'email_2', 'email_3', 'avatar_url', 'notifications_enabled', 'last_daily_notif_date',
    'calendly_link', 'use_own_calendly_link', 'timezone', 'personalized_email_enabled', 'personalized_email_template', 'personalized_email_subject',
    'email_is_gmail', 'personalized_texting_enabled', 'personalized_texting_template', 'about_us_email_enabled', 'about_us_email_subject',
    'about_us_email_template', 'recommended_first_email_enabled', 'recommended_second_email_enabled', 'autodial_enabled', 'linkedin_template',
    'transcript_calling_enabled', 'record_accepted_calls', 'record_all_calls', 'onboarding_done_at'];
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if new.role is distinct from old.role or new.team_id is distinct from old.team_id then
    raise exception 'Only admins can change role or team assignment';
  end if;
  if (to_jsonb(new) - v_self) is distinct from (to_jsonb(old) - v_self) then
    raise exception 'Only admins can change this setting';
  end if;
  return new;
end $$;
revoke execute on function public.protect_profile_admin_fields() from public, anon, authenticated;   -- trigger function: nobody calls it directly
drop trigger if exists profiles_protect_admin_fields on public.profiles;
create trigger profiles_protect_admin_fields before update on public.profiles for each row execute function public.protect_profile_admin_fields();

-- ============================================================ 3. LIVE HOTFIX: caller checks on SECURITY DEFINER functions
-- Scope helpers: admin, the person who created the client, their team lead, or a teammate in the same team.
create or replace function public.client_in_my_scope(p_client uuid) returns boolean
 language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select auth.uid() is not null and exists (
    select 1 from clients c where c.id = p_client and (
         public.is_admin() or c.created_by = auth.uid() or public.is_team_lead_of(c.created_by)
      or exists (select 1 from profiles o where o.id = c.created_by and o.team_id is not null
                    and o.team_id = any (public.my_team_ids(auth.uid())) and o.role in ('team_lead', 'intern', 'independent_lead'))));
$$;
create or replace function public.buyer_in_my_scope(p_buyer uuid) returns boolean
 language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select auth.uid() is not null and p_buyer is not null and (
       public.is_admin()
    or public.client_in_my_scope(p_buyer)
    or exists (select 1 from public.get_reports_available_buyers() b where b.id = p_buyer));
$$;
revoke execute on function public.client_in_my_scope(uuid), public.buyer_in_my_scope(uuid) from public, anon;
grant execute on function public.client_in_my_scope(uuid), public.buyer_in_my_scope(uuid) to authenticated, service_role;

-- log_shared_client_event: the caller must own p_client_id (as before), the counterpart must be in their scope,
-- and the event is always written as the caller (p_created_by is ignored, never trusted).
create or replace function public.log_shared_client_event(p_client_id uuid, p_counterpart_client_id uuid, p_event_type text, p_event_date timestamptz,
    p_time text, p_created_by uuid, p_category text default null, p_timezone text default null) returns void
 language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_client record; v_counterpart record; v_id1 uuid; v_id2 uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not exists (select 1 from clients where id = p_client_id and (created_by = auth.uid() or is_admin() or is_team_lead_of(created_by))) then
    raise exception 'You can only log an event on a client you created.';
  end if;
  if not public.client_in_my_scope(p_counterpart_client_id) then
    raise exception 'Counterpart client not found.';
  end if;
  select id, full_name, company_name, client_type into v_client from clients where id = p_client_id;
  select id, full_name, company_name, client_type into v_counterpart from clients where id = p_counterpart_client_id;
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
end $$;

-- get_client_full_name: admins and team leads, and only for a client in their scope (RLS on clients is team-scoped)
create or replace function public.get_client_full_name(p_client_id uuid) returns text
 language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select c.full_name from clients c
   where c.id = p_client_id
     and exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('admin', 'team_lead'))
     and public.client_in_my_scope(c.id);
$$;

-- get_buyer_*: keep the existing admin / team-lead check and add "this buyer is in my scope" right after it.
-- Done by editing the live function text so the (long) report bodies are not duplicated here. Raises if the text did not match.
do $$
declare f text; r record; d text; n text;
begin
  foreach f in array array['get_buyer_milestone_clients', 'get_buyer_contacted_owners', 'get_buyer_outreach_chart', 'get_buyer_outreach_since_signed', 'get_buyer_progress_summary'] loop
    for r in select oid from pg_proc where pronamespace = 'public'::regnamespace and proname = f loop
      d := pg_get_functiondef(r.oid);
      continue when d like '%buyer_in_my_scope%';
      n := replace(d, E'raise exception ''Not authorized.'';\n  end if;', E'raise exception ''Not authorized.'';\n  end if;\n  if not public.buyer_in_my_scope(p_buyer_id) then raise exception ''Not authorized.''; end if;');
      if n = d then raise exception 'could not patch %: unexpected body, edit by hand', f; end if;
      execute n;
    end loop;
  end loop;
end $$;

-- sequence helpers had no caller check. Internal callers (cron and edge functions on the service role: auth.uid() is null,
-- and the SECURITY DEFINER functions that call them for the signed-in user) keep working.
create or replace function public.seq_maybe_complete(p_dial_id uuid) returns void
 language sql security definer set search_path to 'public', 'pg_temp' as $$
  update dials d set seq_state = 'completed'
   where d.id = p_dial_id and d.seq_state = 'active'
     and (auth.uid() is null or d.created_by = auth.uid() or public.is_admin() or public.is_team_lead_of(d.created_by))
     and not exists (select 1 from sequence_tasks where dial_id = p_dial_id and status in ('pending', 'queued', 'failed'));
$$;
revoke execute on function public.seq_pick_sender(uuid, text) from public, anon, authenticated;   -- internal only (no SQL or app caller)
grant execute on function public.seq_pick_sender(uuid, text) to service_role;

create or replace function public.get_questionnaire_buyer_ids() returns setof uuid
 language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select c.id from clients c
   where c.client_type = 'buyer' and c.tracking_flow = 'questionnaire' and auth.uid() is not null
     and (public.is_admin() or public.client_in_my_scope(c.id)
          or exists (select 1 from dial_lists dl where dl.buyer_id = c.id and (dl.created_by = auth.uid() or public.is_team_lead_of(dl.created_by))));
$$;

create or replace function public.match_mailbox_owner(p_display_name text, p_email text) returns uuid
 language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare cand text; hits uuid[];
begin
  if auth.uid() is not null and not public.is_admin() then return null; end if;   -- admin tooling / service role only
  foreach cand in array array[
      p_display_name,
      replace(replace(replace(split_part(coalesce(p_email, ''), '@', 1), '.', ' '), '_', ' '), '-', ' ')]
  loop
    cand := btrim(norm_person_name(cand));
    continue when cand is null or cand = '' or position(' ' in cand) = 0;
    select array_agg(id) into hits from profiles where btrim(norm_person_name(full_name)) = cand;
    if array_length(hits, 1) = 1 then return hits[1]; end if;
  end loop;
  return null;
end $$;

create or replace function public.person_tz(p_profile uuid) returns text
 language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v text;
begin
  -- someone else's time zone is only returned to that person's team lead, a teammate, or an admin
  if auth.uid() is not null and p_profile is distinct from auth.uid() and not (public.is_admin() or public.is_team_lead_of(p_profile)
       or exists (select 1 from profiles o where o.id = p_profile and o.team_id is not null and o.team_id = any (public.my_team_ids(auth.uid())))) then
    return 'America/Denver';
  end if;
  select timezone into v from profiles where id = p_profile;
  if v is null or btrim(v) = '' then return 'America/Denver'; end if;
  perform now() at time zone v;
  return v;
exception when others then return 'America/Denver';
end $$;

-- my_team_ids is an internal helper (used inside definer functions and one policy that anon never reaches)
revoke execute on function public.my_team_ids(uuid) from public, anon;
grant execute on function public.my_team_ids(uuid) to authenticated, service_role;

-- ============================================================ 3b. definer functions without a pinned search_path (advisor WARN)
do $$
declare f text; r record;
begin
  foreach f in array array['create_client_created_event', 'delete_client_event', 'get_buyer_contacted_owners', 'get_buyer_milestone_clients', 'get_buyer_outreach_chart',
      'get_buyer_outreach_since_signed', 'get_buyer_progress_summary', 'get_client_full_name', 'get_eligible_counterparts', 'get_reports_available_buyers',
      'handle_new_user', 'is_admin', 'is_team_lead', 'is_team_lead_of', 'log_shared_client_event', 'reassign_dial_list_buyer', 'set_client_event_confirmed',
      'sync_pipeline_status_on_event_confirm', 'update_client_event'] loop
    for r in select oid::regprocedure as sig from pg_proc where pronamespace = 'public'::regnamespace and proname = f and prosecdef loop
      execute format('alter function %s set search_path = public, pg_temp', r.sig);
    end loop;
  end loop;
end $$;

-- ============================================================ END OF LIVE HOTFIXES (sections 1-3b)

-- ============================================================ 4. security minors
-- dials INSERT: the target list must be one the caller can already see (RLS filtered), not just any uuid
drop policy if exists dials_insert_own on public.dials;
create policy dials_insert_own on public.dials for insert with check (
  created_by = auth.uid() and (list_id is null or exists (select 1 from dial_lists dl where dl.id = dials.list_id)));

-- email attachments (storage): the same people the table policy lets in (owner, admin, the owner's team lead, the client's creator / lead); signed-in only
drop policy if exists email_attachments_storage_select on storage.objects;
create policy email_attachments_storage_select on storage.objects for select to authenticated using (
  bucket_id = 'email-attachments' and exists (
    select 1 from email_messages em join email_accounts ea on ea.id = em.account_id
     where em.id::text = (storage.foldername(objects.name))[1]
       and (ea.owner_id = auth.uid() or is_admin() or is_team_lead_of(ea.owner_id)
            or exists (select 1 from clients c where c.id = em.client_id and (c.created_by = auth.uid() or is_team_lead_of(c.created_by))))));

-- avatars bucket: images only, 2 MB, writes only into your own folder, signed-in users only
update storage.buckets set file_size_limit = 2097152, allowed_mime_types = array['image/*'] where id = 'avatars';
alter policy avatars_insert_own on storage.objects to authenticated;
alter policy avatars_update_own on storage.objects to authenticated;
alter policy avatars_delete_own on storage.objects to authenticated;

-- ============================================================ 5. email
-- 5a. a resumed mailbox / list starts counting bounces from now, whichever path cleared the pause (edge function, SQL, resume_sending)
create or replace function public.reset_bounce_window() returns trigger
 language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if old.send_paused_reason is not null and new.send_paused_reason is null then new.bounce_check_from := now(); end if;
  return new;
end $$;
drop trigger if exists email_accounts_reset_bounce_window on public.email_accounts;
create trigger email_accounts_reset_bounce_window before update of send_paused_reason on public.email_accounts for each row execute function public.reset_bounce_window();
drop trigger if exists dial_lists_reset_bounce_window on public.dial_lists;
create trigger dial_lists_reset_bounce_window before update of send_paused_reason on public.dial_lists for each row execute function public.reset_bounce_window();

-- 5b. Campaigns: a list the bounce guard paused shows as Paused (with the reason); a partly launched campaign shows Running
create or replace function public.admin_campaigns(p_fresh boolean default true) returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v jsonb;
begin
  if not coalesce(is_admin(), false) then raise exception 'Admins only'; end if;
  if coalesce(p_fresh, true) then perform campaign_refresh(null); end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.rank, x.created_at desc), '[]') into v from (
    select y.*, case y.status when 'ready' then 0 when 'live' then 1 when 'paused' then 2 when 'draft' then 3 else 4 end as rank from (
      select c.id, c.list_id, c.name, c.mandate,
             case when l.send_paused_reason is not null then 'paused'
                  when c.status = 'ready' and count(*) filter (where d.seq_state = 'active') > 0 then 'live'
                  else c.status end as status,
             case when l.send_paused_reason is not null then l.send_paused_reason else c.paused_reason end as paused_reason,
             (l.send_paused_reason is not null) as bounce_paused,
             c.launched_at, c.created_at, p.full_name as owner, l.created_by as owner_id,
             (c.spintax is not null) as has_spintax, coalesce((c.spintax->>'version')::int, 0) as spintax_version, c.variant_stats,
             (select count(*) from owner_eligible_mailboxes(l.created_by, l.mandate)) as mailboxes,
             jsonb_build_object(
               'leads', count(d.id) filter (where d.sequence = 'email5'),
               'ready', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
               'need_fix', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and not (d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2))),
               'copy_changed', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)
                                                  and l.copy_approved_at is not null and d.copy_checked_at > l.copy_approved_at),
               'started', count(*) filter (where d.sequence = 'email5' and d.seq_state is not null and d.seq_state <> 'awaiting_copy'),
               'active', count(*) filter (where d.seq_state = 'active'),
               'sent_first', count(*) filter (where d.email_1_message_id is not null),
               'replied', count(*) filter (where d.seq_state = 'replied'),
               'bounced', count(*) filter (where d.seq_state = 'bounced'),
               'backup', count(*) filter (where d.sequence = 'backup'),
               'emails_sent', (select count(*) from email_messages m join scheduled_emails s on s.id = m.scheduled_id join dials sd on sd.id = s.dial_id where sd.list_id = c.list_id and m.direction = 'outbound'),
               'contacted', count(*) filter (where d.email_1_message_id is not null),
               'interested', count(*) filter (where d.sequence = 'email5' and d.contact_status in ('callback_interested', 'intro_call_scheduled')),
               'intro_calls', count(*) filter (where d.sequence = 'email5' and d.contact_status = 'intro_call_scheduled')) as counts
        from campaigns c join dial_lists l on l.id = c.list_id and l.deleted_at is null
        left join profiles p on p.id = l.created_by left join dials d on d.list_id = l.id
       group by c.id, p.full_name, l.id, l.created_by, l.mandate, l.send_paused_reason, l.copy_approved_at
       limit 200) y) x;
  return v;
end $$;

-- Resume works for both kinds of pause: the admin's own pause and the bounce guard's list pause
create or replace function public.campaign_resume(p_list uuid) returns void
 language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_list_paused boolean; v_camp_paused boolean;
begin
  if not coalesce(is_admin(), false) then raise exception 'Admins only'; end if;
  select send_paused_reason is not null into v_list_paused from dial_lists where id = p_list;
  select status = 'paused' into v_camp_paused from campaigns where list_id = p_list;
  if not coalesce(v_list_paused, false) and not coalesce(v_camp_paused, false) then raise exception 'Campaign is not paused'; end if;
  if coalesce(v_list_paused, false) then perform resume_sending('list', p_list); end if;
  if coalesce(v_camp_paused, false) then
    update campaigns set status = 'live', paused_reason = null, updated_at = now() where list_id = p_list;
    update dial_lists set copy_status = 'approved' where id = p_list and copy_status = 'pending_review'
       and exists (select 1 from dials where list_id = p_list and seq_state = 'active');
  end if;
  perform campaign_refresh(p_list);
end $$;

-- 5c. replies. An auto-reply is decided by headers (set by email-sync) or a strict SUBJECT pattern, never by what the body says.
-- Anything with interest or stop / remove / unsubscribe wording is a person, whatever the headers say.
create or replace function public.email_is_auto_reply(p_from text, p_subject text, p_snippet text) returns boolean
 language sql immutable set search_path to 'public', 'pg_temp' as $$
  select coalesce(p_subject, '') ~* '^\s*((re|fw|fwd)\s*:\s*)*(automatic reply|auto[- ]?reply|auto[- ]?response|autoresponse|automated (reply|response)|out of (the )?office|ooo\M|away from (the )?office|on (annual |maternity |parental )?leave\M|vacation (reply|response|notice)|abwesenheit|auto:)' $$;

create or replace function public.email_human_language(p_subject text, p_body text) returns boolean
 language sql immutable set search_path to 'public', 'pg_temp' as $$
  select public.reply_wants_stop(p_subject, p_body)
      or (coalesce(p_subject, '') || ' ' || public.reply_top_text(p_body)) ~*
         '(\m(i am|i''m|we are|we''re) (very |definitely |quite |also )?interested\M|\minterested (in|to)\M|\myes[,.!]|\myes\M\s+(please|i|we)|sounds (good|great|interesting)|\mtell me more\M|\mmore (info|information|details)\M|\mlet''s (talk|chat|speak|schedule|set up|connect)\M|\mhappy to (talk|chat|speak|connect|meet)\M|\mgive me a call\M|\mschedule a (call|time|meeting)\M)' $$;

create or replace function public.email_messages_flag_system() returns trigger
 language plpgsql set search_path to 'public', 'pg_temp' as $$
declare v_auto boolean;
begin
  if new.direction = 'inbound' then
    new.system_kind := public.email_system_kind(new.from_address, new.subject);
    new.is_system := new.system_kind is not null;
    v_auto := new.system_kind is null and (coalesce(new.is_auto_reply, false) or public.email_is_auto_reply(new.from_address, new.subject, new.snippet));
    if v_auto and public.email_human_language(new.subject, coalesce(new.body_text, new.snippet)) then v_auto := false; end if;
    new.is_auto_reply := v_auto;
    if v_auto then new.is_read := true; end if;      -- out-of-office mail does not add to the unread count
  end if;
  return new;
end $$;

-- a notice that says the failure is permanent is a hard bounce (the retry-once rule is only for mailbox-full style failures)
create or replace function public.bounce_is_hard(p_subject text, p_body text) returns boolean
 language sql immutable set search_path to 'public', 'pg_temp' as $$
  select (coalesce(p_subject, '') || ' ' || coalesce(p_body, '')) ~* '(\m5\.(1\.[0-9]{1,3}|2\.1|4\.1)\M|user unknown|no such user|unknown user|recipient address rejected|address not found|does not exist|unknown recipient|invalid recipient|mailbox (not found|unavailable|does not exist)|account (is )?disabled|failed permanently|permanent(ly)? (failure|error|fail)|permanent fatal error)'
     and (coalesce(p_subject, '') || ' ' || coalesce(p_body, '')) !~* '(\m4\.[0-9]\.[0-9]{1,3}\M|mailbox (is )?full|over quota|try again later)' $$;

-- 5d. inbound mail: delay notices are not bounces; a real soft bounce is retried once; system mail from the lead's company domain is not a reply
create or replace function public.email_inbound_seq_check() returns trigger
 language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare d record; v_from text := lower(btrim(coalesce(new.from_address,''))); v_txt text; v_known boolean; v_hard boolean; v_soft int;
        v_at timestamptz := coalesce(new.sent_at, new.created_at, now()); v_dom text := public.email_domain(v_from); v_matched text[] := '{}'; m text;
        v_local text := split_part(v_from, '@', 1);
begin
  if new.direction is distinct from 'inbound' then return new; end if;
  v_txt := lower(coalesce(new.body_text,'') || ' ' || coalesce(new.subject,''));
  if v_from ~ '^(mailer-daemon|postmaster|mail-daemon)@' or coalesce(new.subject,'') ~* '(undeliver|delivery status notification|delivery has failed|returned mail|failure notice)' then
    -- "still trying" notices are not failures: the address may yet be delivered, so nothing changes
    if coalesce(new.subject,'') ~* '\(delay\)|delivery delay|delayed|warning: (message )?could not be delivered|not yet (been )?delivered'
       or coalesce(new.body_text,'') ~* '(will (keep|continue) (to )?(try|retry|attempt)|still (be )?trying to deliver|delivery (has been |is )?delayed|no action is (required|needed))' then
      return new;
    end if;
    v_hard := bounce_is_hard(new.subject, new.body_text);
    for d in select id, email, seq_state from dials where email is not null and sender_account_id = new.account_id
                and (seq_state in ('active', 'bounced') or email_1_message_id is not null)
                and position(lower(email) in v_txt) > 0 loop
      v_soft := 0;
      if d.seq_state in ('active', 'bounced') then
        update dials set bounced_at = coalesce(bounced_at, now()),
               bounce_kind = case when v_hard or bounce_kind = 'hard' then 'hard' else 'soft' end,
               soft_bounces = soft_bounces + case when v_hard then 0 else 1 end
         where id = d.id returning soft_bounces into v_soft;
      end if;
      -- hard bounce: stop now. Soft bounce (mailbox full): the next email gets one more try; the second soft bounce stops it
      if d.seq_state = 'active' and (v_hard or coalesce(v_soft, 0) >= 2) then perform seq_stop(d.id, 'bounced', 'Email bounced', false); end if;
      if v_hard then perform suppress_email_internal(d.email, 'Hard bounce', 'bounce', null); end if;
    end loop;
    return new;
  end if;
  -- out-of-office / auto-replies are not replies
  if coalesce(new.is_auto_reply, false) then return new; end if;
  for d in select dd.id, dd.email, dd.created_by, dd.list_id from dials dd where dd.seq_state = 'active' and (
             lower(dd.email) = v_from
          or (new.thread_id is not null and dd.email_1_thread_id = new.thread_id)
          or (new.in_reply_to is not null and dd.email_1_message_id = new.in_reply_to)
          or (v_dom <> '' and dd.sender_account_id = new.account_id and public.email_domain(dd.email) = v_dom and not public.dedup_domain_exempt(v_dom)
              and v_local !~ '^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|postmaster|mailer-daemon|mail-daemon|quarantine|abuse|security|bounces?|notifications?|alerts?|system|daemon|spam|helpdesk)([-_.+0-9]|$)')) loop
    perform seq_stop(d.id, 'replied', 'Owner replied by email', false);
    v_matched := v_matched || lower(d.email);
    insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on)
    values (d.id, d.list_id, d.created_by, 100, 0, 'reply', add_business_days(person_today(d.created_by), 2))
    on conflict (dial_id, step) do nothing;
  end loop;
  update sequence_tasks st set status = 'pending', outcome = null, completed_at = null, completed_by = null,
         due_on = add_business_days(person_today(st.owner_id), 2)
    from dials dd where dd.id = st.dial_id and (lower(dd.email) = v_from or (new.thread_id is not null and dd.email_1_thread_id = new.thread_id))
     and st.kind = 'reply' and st.status = 'done' and st.completed_at is not null and v_at > st.completed_at;
  if v_from ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' and reply_wants_stop(new.subject, new.body_text) then
    v_known := exists (select 1 from dials where lower(email) = v_from)
            or exists (select 1 from email_messages o, jsonb_array_elements(coalesce(o.to_addresses, '[]'::jsonb)) a
                        where o.account_id = new.account_id and o.direction = 'outbound' and lower(a->>'address') = v_from);
    if v_known then perform suppress_email_internal(v_from, 'Asked to stop / unsubscribe', 'reply', null); end if;
    foreach m in array v_matched loop
      if m is not null and m <> v_from then perform suppress_email_internal(m, 'Asked to stop / unsubscribe (reply from ' || v_from || ')', 'reply', null); end if;
    end loop;
  end if;
  return new;
end $$;

-- 5e. Do not email: free-mail domains and made-up domains are refused; company domains are previewed (leads affected) before they are added
create or replace function public.is_freemail_domain(d text) returns boolean
 language sql immutable set search_path to 'public', 'pg_temp' as $$
  select lower(btrim(coalesce(d, ''))) ~ '^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|pm|gmx|mail|zoho|yandex|fastmail|hey|comcast|att|sbcglobal|verizon|bellsouth|cox|charter|earthlink|juno|netzero)\.[a-z.]+$' $$;
create or replace function public.is_plausible_domain(d text) returns boolean
 language sql immutable set search_path to 'public', 'pg_temp' as $$
  select lower(btrim(coalesce(d, ''))) ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+(com|net|org|edu|gov|mil|int|info|biz|name|pro|mobi|io|ai|app|dev|co|me|tv|xyz|online|site|tech|cloud|agency|group|company|solutions|services|consulting|llc|inc|law|health|care|energy|capital|partners|global|network|digital|studio|design|media|works|systems|software|store|shop|us|[a-z]{2})$' $$;

create or replace function public.suppress_preview(p_text text) returns jsonb
 language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare tok text; v text; v_e int := 0; v_doms jsonb := '[]'; v_ref jsonb := '[]'; v_bad text[] := '{}'; v_leads int;
begin
  if auth.uid() is null or not coalesce(is_admin(), false) then raise exception 'Only an admin can edit the suppression list'; end if;
  foreach tok in array regexp_split_to_array(lower(coalesce(p_text, '')), '[\s,;]+') loop
    v := btrim(tok, ' <>"''()');
    if v = '' then continue; end if;
    if v ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then v_e := v_e + 1;
    elsif v ~ '^@?[a-z0-9.-]+\.[a-z]{2,}$' then
      v := ltrim(v, '@');
      if public.is_freemail_domain(v) or public.dedup_domain_exempt(v) then v_ref := v_ref || to_jsonb(v);
      elsif not public.is_plausible_domain(v) then v_bad := v_bad || v;
      else
        select count(*) into v_leads from dials where sequence = 'email5' and seq_state in ('active', 'awaiting_copy') and public.email_domain(email) = v;
        v_doms := v_doms || jsonb_build_object('domain', v, 'leads', v_leads);
      end if;
    else v_bad := v_bad || v; end if;
  end loop;
  return jsonb_build_object('emails', v_e, 'domains', v_doms, 'refused', v_ref, 'skipped', to_jsonb(v_bad));
end $$;

create or replace function public.suppress_many(p_text text, p_reason text default 'manual') returns jsonb
 language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare tok text; v_reason text := coalesce(nullif(btrim(p_reason), ''), 'manual'); v_e int := 0; v_d int := 0; v_old int := 0;
        v_bad text[] := '{}'; v_ref text[] := '{}'; v text;
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
      if public.is_freemail_domain(v) or public.dedup_domain_exempt(v) then v_ref := v_ref || v;       -- never a whole free-mail domain
      elsif not public.is_plausible_domain(v) then v_bad := v_bad || v;
      elsif exists (select 1 from suppressed_domains where domain = v) then v_old := v_old + 1;
      else perform suppress_domain(v, v_reason); v_d := v_d + 1; end if;
    else v_bad := v_bad || v; end if;
  end loop;
  return jsonb_build_object('emails', v_e, 'domains', v_d, 'already', v_old, 'skipped', to_jsonb(v_bad), 'refused', to_jsonb(v_ref));
end $$;
revoke execute on function public.suppress_preview(text) from public, anon;
grant execute on function public.suppress_preview(text) to authenticated, service_role;

-- the search treats % and _ as plain characters
create or replace function public.suppression_list(p_search text default null, p_limit integer default 100, p_offset integer default 0) returns jsonb
 language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
declare v_q text := '%' || replace(replace(replace(lower(btrim(coalesce(p_search, ''))), '\', '\\'), '%', '\%'), '_', '\_') || '%'; v_total int; v jsonb;
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

-- 5f. two Launch clicks at once (two tabs): the second waits for the first and then finds nothing left to start
do $$
declare r record; d text; n text;
begin
  for r in select oid from pg_proc where pronamespace = 'public'::regnamespace and proname = 'start_emails' loop
    d := pg_get_functiondef(r.oid);
    continue when d like '%pg_advisory_xact_lock%';
    n := replace(d, E'  if auth.uid() is null then raise exception ''Sign in first''; end if;\n', E'  if auth.uid() is null then raise exception ''Sign in first''; end if;\n  perform pg_advisory_xact_lock(hashtextextended(''start_emails:'' || p_list_id::text, 0));\n');
    if n = d then raise exception 'could not patch start_emails: unexpected body, edit by hand'; end if;
    execute n;
  end loop;
end $$;

-- ============================================================ 6. calls
-- a call row that was left open (page closed, phone died) is closed by the app the next time that person opens Calls; the reason is recorded
alter table public.calls add column if not exists end_reason text;
create or replace function public.close_my_stale_calls() returns integer
 language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare n int;
begin
  if auth.uid() is null then return 0; end if;
  update calls set ended_at = coalesce(answered_at, started_at, now()), end_reason = coalesce(end_reason, 'left_open')
   where user_id = auth.uid() and ended_at is null and started_at < now() - interval '2 hours';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.close_my_stale_calls() from public, anon;
grant execute on function public.close_my_stale_calls() to authenticated, service_role;
