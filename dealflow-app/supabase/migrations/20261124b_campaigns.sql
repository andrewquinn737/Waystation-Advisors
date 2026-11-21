-- Campaigns (one per email list), spintax pools, connector campaign tools, admin onboarding, connector token expiry.
-- Idempotent. Applies on top of 20261123_campaigns.sql (campaign_overview stays; the Admin page uses admin_campaigns()).
-- Pause/resume works through dial_lists.copy_status (the dispatcher only sends for 'approved' lists), so this file does
-- NOT redefine any dispatcher / start_emails function.
set check_function_bodies = off;

-- ---------------------------------------------------------------- small column additions
alter table public.dials add column if not exists copy_variant text;                       -- 's<subject idx>/e1:<choices>/f:<choices>'
alter table public.profiles add column if not exists onboarding_done_at timestamptz;
alter table public.claude_connector_tokens add column if not exists expires_at timestamptz;
update public.claude_connector_tokens set expires_at = created_at + interval '90 days' where expires_at is null;
grant select (expires_at) on public.claude_connector_tokens to authenticated;

-- token with an expiry (default 90 days, 1..365). Replaces the 1-arg version.
drop function if exists public.create_claude_connector_token(text);
create or replace function public.create_claude_connector_token(p_label text default 'Claude', p_days int default 90) returns text
 language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare tok text := encode(extensions.gen_random_bytes(32), 'hex'); v_days int := least(greatest(coalesce(p_days, 90), 1), 365);
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  update claude_connector_tokens set revoked_at = now() where profile_id = auth.uid() and revoked_at is null;
  insert into claude_connector_tokens (profile_id, token_hash, label, expires_at)
  values (auth.uid(), encode(extensions.digest(tok, 'sha256'), 'hex'), left(coalesce(p_label,'Claude'), 60), now() + make_interval(days => v_days));
  return tok;
end $$;
grant execute on function public.create_claude_connector_token(text, int) to authenticated;
revoke execute on function public.create_claude_connector_token(text, int) from anon, public;

-- admin onboarding state (own profile only)
create or replace function public.onboarding_status() returns timestamptz
 language sql stable security definer set search_path to 'public' as $$ select onboarding_done_at from profiles where id = auth.uid() $$;
create or replace function public.onboarding_complete(p_done boolean default true) returns void
 language sql security definer set search_path to 'public' as $$
  update profiles set onboarding_done_at = case when coalesce(p_done, true) then now() else null end where id = auth.uid() $$;
grant execute on function public.onboarding_status(), public.onboarding_complete(boolean) to authenticated;
revoke execute on function public.onboarding_status(), public.onboarding_complete(boolean) from anon, public;

-- ---------------------------------------------------------------- campaigns
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null unique references public.dial_lists(id) on delete cascade,
  name text,
  mandate text,
  status text not null default 'draft',
  sender_account_ids uuid[],                 -- null = all of the list owner's eligible mailboxes
  spintax jsonb,                             -- {version, subject_pools, email1_template, followup_template, saved_at, saved_by}
  variant_stats jsonb not null default '{}'::jsonb,
  paused_reason text,
  launched_at timestamptz,
  launched_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$ begin
  alter table public.campaigns add constraint campaigns_status_check check (status in ('draft','ready','live','paused','done'));
exception when duplicate_object then null; end $$;
alter table public.campaigns enable row level security;
drop policy if exists campaigns_admin_read on public.campaigns;
create policy campaigns_admin_read on public.campaigns for select to authenticated using (is_admin());
revoke all on public.campaigns from anon, authenticated;
grant select on public.campaigns to authenticated;

-- a campaign row appears as soon as a list has an email-sequence lead
create or replace function public.campaigns_ensure() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
begin
  insert into campaigns (list_id, name, mandate, created_at)
  select l.id, l.name, l.mandate, l.created_at from dial_lists l where l.id = new.list_id and l.deleted_at is null
  on conflict (list_id) do nothing;
  return new;
end $$;
drop trigger if exists dials_campaign_ensure_upd on public.dials;
create trigger dials_campaign_ensure_upd after update of sequence on public.dials
  for each row when (new.sequence = 'email5' and old.sequence is distinct from 'email5') execute function public.campaigns_ensure();
drop trigger if exists dials_campaign_ensure_ins on public.dials;
create trigger dials_campaign_ensure_ins after insert on public.dials
  for each row when (new.sequence = 'email5') execute function public.campaigns_ensure();

-- Recompute campaign rows (create missing, sync name/mandate, status, launch inference, variant stats).
--   paused            -> stays paused until resumed
--   never launched    -> ready (some lead passed the gate) else draft
--   launched          -> ready (leads waiting for a (re)launch) / live (sends pending) / done
create or replace function public.campaign_refresh(p_list uuid default null) returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  insert into campaigns (list_id, name, mandate, created_at)
  select l.id, l.name, l.mandate, l.created_at from dial_lists l
   where l.deleted_at is null and (p_list is null or l.id = p_list)
     and exists (select 1 from dials d where d.list_id = l.id and d.sequence = 'email5')
  on conflict (list_id) do nothing;

  with agg as (
    select d.list_id,
      count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok
                         and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)) as ready,
      count(*) filter (where d.seq_state = 'active') as active,
      count(*) filter (where d.email_1_message_id is not null or d.seq_state in ('active','replied','completed')) as launched_any
    from dials d where (p_list is null or d.list_id = p_list) group by d.list_id),
  pend as (
    select t.list_id, count(*) n from sequence_tasks t join dials d on d.id = t.dial_id and d.seq_state = 'active'
     where t.kind in ('email','followup_email') and t.status in ('pending','queued') and (p_list is null or t.list_id = p_list) group by t.list_id)
  update campaigns c set
      name = l.name, mandate = l.mandate,
      launched_at = coalesce(c.launched_at, case when coalesce(a.launched_any, 0) > 0 then now() end),
      status = case
        when c.status = 'paused' then 'paused'
        when coalesce(a.ready, 0) > 0 then 'ready'
        when c.launched_at is null and coalesce(a.launched_any, 0) = 0 then 'draft'
        when coalesce(p.n, 0) > 0 then 'live'
        else 'done' end,
      updated_at = now()
    from dial_lists l left join agg a on a.list_id = l.id left join pend p on p.list_id = l.id
   where l.id = c.list_id and (p_list is null or c.list_id = p_list);

  update campaigns c set variant_stats = coalesce((
      select jsonb_object_agg(v, jsonb_build_object('sent', s, 'replied', r)) from (
        select split_part(d.copy_variant, '/', 1) v,
               count(*) filter (where d.email_1_message_id is not null) s, count(*) filter (where d.seq_state = 'replied') r
          from dials d where d.list_id = c.list_id and d.copy_variant is not null group by 1) x), '{}'::jsonb)
   where c.spintax is not null and (p_list is null or c.list_id = p_list);
end $$;
revoke execute on function public.campaign_refresh(uuid) from public, anon, authenticated;

-- Leads whose copy changed after launch go back to "awaiting copy": an admin must press Launch again.
-- Their queued-but-unsent emails are un-queued (tasks stay pending, inert while the lead is not active).
create or replace function public.campaign_hold_changed(p_list uuid, p_ids uuid[]) returns int
 language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  update sequence_tasks st set status = 'pending', scheduled_email_id = null
   where st.dial_id = any (p_ids) and st.status = 'queued'
     and st.scheduled_email_id in (select id from scheduled_emails where status = 'pending');
  update scheduled_emails set status = 'cancelled', error = 'Copy changed after launch: waiting for re-launch'
   where dial_id = any (p_ids) and status = 'pending';
  with h as (update dials set seq_state = 'awaiting_copy' where id = any (p_ids) and list_id = p_list and sequence = 'email5' and seq_state = 'active' returning 1)
  select count(*) into n from h;
  perform campaign_refresh(p_list);
  return n;
end $$;
revoke execute on function public.campaign_hold_changed(uuid, uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------- admin RPCs (Admin page)
create or replace function public.admin_campaigns() returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v jsonb;
begin
  if not coalesce(is_admin(), false) then raise exception 'Admins only'; end if;
  perform campaign_refresh(null);
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
             'backup', count(*) filter (where d.sequence = 'backup')) as counts
      from campaigns c join dial_lists l on l.id = c.list_id and l.deleted_at is null
      left join profiles p on p.id = l.created_by left join dials d on d.list_id = l.id
     group by c.id, p.full_name, l.created_by, l.mandate
     limit 200) x;
  return v;
end $$;
revoke all on function public.admin_campaigns() from public, anon;
grant execute on function public.admin_campaigns() to authenticated;

create or replace function public.campaign_pause(p_list uuid, p_reason text default 'Paused by admin') returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  if not coalesce(is_admin(), false) then raise exception 'Admins only'; end if;
  if not exists (select 1 from campaigns where list_id = p_list) then raise exception 'Campaign not found'; end if;
  update campaigns set status = 'paused', paused_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Paused by admin'), 200), updated_at = now() where list_id = p_list;
  update dial_lists set copy_status = 'pending_review' where id = p_list and copy_status = 'approved';   -- dispatcher sends only for 'approved'
  update sequence_tasks st set status = 'pending', scheduled_email_id = null
   where st.list_id = p_list and st.status = 'queued' and st.scheduled_email_id in (select id from scheduled_emails where status = 'pending');
  update scheduled_emails set status = 'cancelled', error = 'Campaign paused'
   where status = 'pending' and dial_id in (select id from dials where list_id = p_list);
end $$;
create or replace function public.campaign_resume(p_list uuid) returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  if not coalesce(is_admin(), false) then raise exception 'Admins only'; end if;
  if not exists (select 1 from campaigns where list_id = p_list and status = 'paused') then raise exception 'Campaign is not paused'; end if;
  update campaigns set status = 'live', paused_reason = null, updated_at = now() where list_id = p_list;
  update dial_lists set copy_status = 'approved' where id = p_list and copy_status = 'pending_review'
     and exists (select 1 from dials where list_id = p_list and seq_state = 'active');
  perform campaign_refresh(p_list);
end $$;
-- called by the Admin page after a successful start-emails launch (records who launched)
create or replace function public.campaign_launched(p_list uuid) returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  if not coalesce(is_admin(), false) then raise exception 'Admins only'; end if;
  update campaigns set launched_at = coalesce(launched_at, now()), launched_by = auth.uid() where list_id = p_list and launched_by is null;
  perform campaign_refresh(p_list);
end $$;
revoke all on function public.campaign_pause(uuid, text), public.campaign_resume(uuid), public.campaign_launched(uuid) from public, anon;
grant execute on function public.campaign_pause(uuid, text), public.campaign_resume(uuid), public.campaign_launched(uuid) to authenticated;

-- ---------------------------------------------------------------- connector helpers (service role only; each re-checks can_manage_list)
create or replace function public.connector_list_campaigns(p_profile uuid, p_status text default null) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v jsonb;
begin
  perform campaign_refresh(null);
  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) into v from (
    select jsonb_build_object('list_id', c.list_id, 'name', c.name, 'mandate', c.mandate, 'status', c.status, 'owner', p.full_name,
      'has_spintax', c.spintax is not null, 'spintax_version', coalesce((c.spintax->>'version')::int, 0),
      'counts', jsonb_build_object(
        'leads', count(d.id),
        'passed', count(*) filter (where d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
        'held', count(*) filter (where not d.copy_ok and d.copy_checked_at is not null and d.copy_hash is not null
                                   and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
        'unchecked', count(*) filter (where d.copy_checked_at is null or d.copy_hash is distinct from copy_text_hash(d.email_subject, d.email_1, d.email_2)),
        'sent', count(*) filter (where d.email_1_message_id is not null))) as x
      from campaigns c join dial_lists l on l.id = c.list_id and l.deleted_at is null
      join dials d on d.list_id = l.id and d.sequence = 'email5' left join profiles p on p.id = l.created_by
     where can_manage_list(p_profile, c.list_id) and (p_status is null or c.status = p_status)
     group by c.id, p.full_name) s;
  return v;
end $$;

create or replace function public.connector_get_campaign(p_profile uuid, p_list uuid) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare c record; l record; v_buyer jsonb; v_samples jsonb; v_counts jsonb; v_g record;
begin
  if not can_manage_list(p_profile, p_list) then return null; end if;
  perform campaign_refresh(p_list);
  select * into c from campaigns where list_id = p_list;
  if c is null then return null; end if;
  select l2.*, p.full_name as owner into l from dial_lists l2 left join profiles p on p.id = l2.created_by where l2.id = p_list;
  select jsonb_build_object('type', b.client_type, 'confidential_company_name_never_write_it_in_emails', b.company_name, 'industry', b.industry,
           'city', b.city, 'state', b.state, 'looking_for', b.looking_for, 'notes', b.other_notes, 'employees', b.employee_count,
           'founded_year', b.founded_year, 'annual_revenue', b.annual_revenue, 'budget_min', b.money_to_spend_min, 'budget_max', b.money_to_spend_max,
           'intake_form', b.intake_form)
    into v_buyer from clients b where b.id = l.buyer_id;
  select jsonb_build_object(
      'leads', count(*), 'passed', count(*) filter (where d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
      'held', count(*) filter (where not d.copy_ok and d.copy_checked_at is not null and d.copy_hash is not null and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
      'unchecked', count(*) filter (where d.copy_checked_at is null or d.copy_hash is distinct from copy_text_hash(d.email_subject, d.email_1, d.email_2)),
      'first_email_sent', count(*) filter (where d.email_1_message_id is not null),
      'without_email_copy', count(*) filter (where coalesce(btrim(d.email_1), '') = '')) into v_counts
    from dials d where d.list_id = p_list and d.sequence = 'email5';
  select coalesce(jsonb_agg(s), '[]'::jsonb) into v_samples from (
    select jsonb_build_object('company', d.company_name, 'first_name', split_part(btrim(d.full_name), ' ', 1), 'city', d.city, 'state', d.state,
             'industry', d.industry, 'website', d.website, 'summary', left(d.summary, 400)) s
      from dials d where d.list_id = p_list and d.sequence = 'email5' order by md5(d.id::text) limit 12) q;
  select body, version into v_g from copy_guidelines where mandate = coalesce(l.mandate, 'ma');
  return jsonb_build_object('list_id', p_list, 'name', c.name, 'mandate', l.mandate, 'status', c.status, 'owner', l.owner,
    'paused_reason', c.paused_reason, 'launched_at', c.launched_at, 'counts', v_counts, 'buyer_brief', v_buyer,
    'guidelines', case when v_g.body is null then null else jsonb_build_object('mandate', coalesce(l.mandate, 'ma'), 'version', v_g.version, 'body', v_g.body) end,
    'saved_spintax', c.spintax, 'sample_leads', v_samples,
    'merge_tags', jsonb_build_array('first_name', 'company', 'city'));
end $$;

-- every email-sequence lead of the list, as the expander needs them
create or replace function public.connector_campaign_leads(p_profile uuid, p_list uuid) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not can_manage_list(p_profile, p_list) then return null; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'full_name', d.full_name, 'company_name', d.company_name, 'city', d.city,
            'state', d.state, 'sent', d.email_1_message_id is not null, 'seq_state', d.seq_state) order by d.id), '[]'::jsonb)
            from dials d where d.list_id = p_list and d.sequence = 'email5');
end $$;

-- write expanded copy (only leads whose first email has not gone out and who are still in play), store the pools,
-- and send changed ACTIVE leads back to awaiting-copy (re-launch required).
create or replace function public.connector_apply_copy(p_profile uuid, p_list uuid, p_rows jsonb, p_spintax jsonb, p_note text default null) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_written int := 0; v_ids uuid[]; v_held int := 0; v_ver int;
begin
  if not can_manage_list(p_profile, p_list) then raise exception 'List not found'; end if;
  perform campaign_refresh(p_list);
  perform set_config('waystation.copy_source', 'claude_connector', true);
  perform set_config('waystation.copy_by', p_profile::text, true);
  perform set_config('waystation.copy_note', left(coalesce(p_note, 'Campaign spintax'), 500), true);
  with src as (select (x->>'id')::uuid id, x->>'s' s, x->>'e1' e1, x->>'e2' e2, x->>'v' v from jsonb_array_elements(p_rows) x),
  upd as (
    update dials d set email_subject = src.s, email_1 = src.e1, email_2 = src.e2, copy_variant = src.v
      from src
     where d.id = src.id and d.list_id = p_list and d.sequence = 'email5' and d.email_1_message_id is null
       and d.seq_state in ('awaiting_copy', 'active')
       and (d.email_subject is distinct from src.s or d.email_1 is distinct from src.e1 or d.email_2 is distinct from src.e2 or d.copy_variant is distinct from src.v)
    returning d.id)
  select count(*), array_agg(id) into v_written, v_ids from upd;
  if v_ids is not null then v_held := campaign_hold_changed(p_list, v_ids); end if;
  select coalesce((spintax->>'version')::int, 0) + 1 into v_ver from campaigns where list_id = p_list;
  update campaigns set spintax = p_spintax || jsonb_build_object('version', coalesce(v_ver, 1), 'saved_at', now(), 'saved_by', p_profile), updated_at = now()
   where list_id = p_list;
  return jsonb_build_object('written', v_written, 'held_for_relaunch', v_held, 'version', coalesce(v_ver, 1));
end $$;

-- save_rewrite (single draft) also sends a changed ACTIVE lead back for re-launch
create or replace function public.connector_save_copy(p_profile uuid, p_dial uuid, p_subject text, p_e1 text, p_e2 text, p_note text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare d record; v_held int := 0;
begin
  select * into d from dials where id = p_dial and sequence = 'email5' for update;
  if d is null or not can_manage_list(p_profile, d.list_id) then raise exception 'Draft not found'; end if;
  if d.email_1_message_id is not null
     and (coalesce(p_subject, d.email_subject) is distinct from d.email_subject or coalesce(p_e1, d.email_1) is distinct from d.email_1) then
    raise exception 'The first email was already sent; only the follow-up can still be edited';
  end if;
  perform set_config('waystation.copy_source', 'claude_connector', true);
  perform set_config('waystation.copy_by', p_profile::text, true);
  perform set_config('waystation.copy_note', left(coalesce(p_note, ''), 500), true);
  update dials set email_subject = coalesce(p_subject, email_subject), email_1 = coalesce(p_e1, email_1),
                   email_2 = coalesce(p_e2, email_2) where id = p_dial;
  if d.seq_state = 'active' then v_held := campaign_hold_changed(d.list_id, array[p_dial]); end if;
  return jsonb_build_object('ok', true, 'list_id', d.list_id, 'held_for_relaunch', v_held);
end $$;

revoke execute on function public.connector_list_campaigns(uuid, text), public.connector_get_campaign(uuid, uuid),
  public.connector_campaign_leads(uuid, uuid), public.connector_apply_copy(uuid, uuid, jsonb, jsonb, text),
  public.connector_save_copy(uuid, uuid, text, text, text, text) from public, anon, authenticated;

-- backfill: a campaign row for every list that already has email-sequence leads
select public.campaign_refresh(null);
