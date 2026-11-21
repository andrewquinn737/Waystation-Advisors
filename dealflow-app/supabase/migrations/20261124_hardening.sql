-- Hardening (build A, 2026-11-24). Idempotent. Security + deliverability backend. See docs/CRM_DESIGN.md sections 2 and 5.
--  1. No anonymous access: execute revoked from public/anon on every SECURITY DEFINER function (RLS helper predicates stay);
--     guards rewritten null-safe (auth.uid() is null or not coalesce(check,false) -> raise).
--  2. mailbox-admin support: hashed API key, audit table.
--  3. No duplicate sends: 'unknown' scheduled status (never retried), scheduled_id idempotency on email_messages.
--  4. Suppression list + global dedup (address, and company domain for personal-looking addresses).
--  5. Recipient time zone window (9:00-16:00 weekdays), per-domain daily cap, new-mailbox ramp.
--  6. Bounce auto-pause (mailbox and list), admin-only resume.
--  7. Trash list / delete dial cancels queued sends and tasks.
--  8. Mailbox passwords in Supabase Vault (get_mailbox_password / set_mailbox_password, service_role only).
set check_function_bodies = off;

-- ================================================================ columns / tables
alter table public.email_accounts
  add column if not exists ramp_start date,
  add column if not exists bounce_check_from timestamptz,
  add column if not exists password_secret_id uuid;
alter table public.email_accounts alter column password drop not null;
alter table public.dial_lists
  add column if not exists send_paused_reason text,
  add column if not exists bounce_check_from timestamptz;
alter table public.dials
  add column if not exists tz text,
  add column if not exists bounced_at timestamptz;
alter table public.email_messages add column if not exists scheduled_id uuid;
create unique index if not exists email_messages_scheduled_id_uniq on public.email_messages (scheduled_id) where scheduled_id is not null;

alter table public.scheduled_emails drop constraint if exists scheduled_emails_status_check;
alter table public.scheduled_emails add constraint scheduled_emails_status_check
  check (status = any (array['pending','sending','sent','failed','cancelled','unknown']));

grant select (ramp_start, bounce_check_from) on public.email_accounts to authenticated;
grant select (send_paused_reason, bounce_check_from) on public.dial_lists to authenticated;

create table if not exists public.suppressed_emails (
  email text primary key check (email = lower(email)),
  reason text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create table if not exists public.suppressed_domains (
  domain text primary key check (domain = lower(domain)),
  reason text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
alter table public.suppressed_emails enable row level security;
alter table public.suppressed_domains enable row level security;
revoke all on public.suppressed_emails, public.suppressed_domains from anon, authenticated;

create table if not exists public.mailbox_admin_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,          -- display: user id or 'api-key'
  actor_key text not null,      -- rate-limit bucket: 'user:<id>' or 'key:<hash prefix>'
  action text not null,
  target text,
  ip text,
  detail jsonb
);
create index if not exists mailbox_admin_audit_key_idx on public.mailbox_admin_audit (actor_key, at);
alter table public.mailbox_admin_audit enable row level security;
revoke all on public.mailbox_admin_audit from anon, authenticated;

-- ================================================================ small pure helpers (created before use by indexes)
create or replace function public.norm_email(t text) returns text language sql immutable as $$
  select case when t is null or position('@' in t) = 0 then lower(btrim(coalesce(t, '')))
    else (case when split_part(lower(btrim(t)), '@', 2) in ('gmail.com', 'googlemail.com')
               then replace(split_part(split_part(lower(btrim(t)), '@', 1), '+', 1), '.', '')
               else split_part(split_part(lower(btrim(t)), '@', 1), '+', 1) end)
         || '@' || split_part(lower(btrim(t)), '@', 2) end $$;
create or replace function public.email_domain(t text) returns text language sql immutable as $$
  select split_part(lower(btrim(coalesce(t, ''))), '@', 2) $$;
create index if not exists suppressed_emails_norm_idx on public.suppressed_emails (public.norm_email(email));
create index if not exists dials_active_norm_email_idx on public.dials (public.norm_email(email)) where seq_state = 'active';
create index if not exists dials_active_domain_idx on public.dials (public.email_domain(email)) where seq_state = 'active';

-- free-mail and test domains are not "a company": no company-level dedup on them (extend with app_secrets 'dedup_exempt_domains')
create or replace function public.dedup_domain_exempt(d text) returns boolean
 language sql stable security definer set search_path to 'public' as $$
  select d = '' or d = any (array['gmail.com','googlemail.com','yahoo.com','ymail.com','hotmail.com','outlook.com','live.com','msn.com',
      'aol.com','icloud.com','me.com','mac.com','comcast.net','att.net','sbcglobal.net','verizon.net','bellsouth.net','cox.net',
      'charter.net','protonmail.com','proton.me','mail.com','gmx.com','example.com','example.org','example.net'])
     or exists (select 1 from app_secrets s where s.key = 'dedup_exempt_domains' and d = any (string_to_array(lower(s.value), ','))) $$;

-- ================================================================ time zones for recipients
create or replace function public.state_tz(p_state text) returns text language sql immutable as $$
  select case upper(btrim(coalesce(p_state, '')))
    when 'CT' then 'America/New_York' when 'DE' then 'America/New_York' when 'DC' then 'America/New_York' when 'FL' then 'America/New_York'
    when 'GA' then 'America/New_York' when 'IN' then 'America/New_York' when 'KY' then 'America/New_York' when 'ME' then 'America/New_York'
    when 'MD' then 'America/New_York' when 'MA' then 'America/New_York' when 'MI' then 'America/New_York' when 'NH' then 'America/New_York'
    when 'NJ' then 'America/New_York' when 'NY' then 'America/New_York' when 'NC' then 'America/New_York' when 'OH' then 'America/New_York'
    when 'PA' then 'America/New_York' when 'RI' then 'America/New_York' when 'SC' then 'America/New_York' when 'VT' then 'America/New_York'
    when 'VA' then 'America/New_York' when 'WV' then 'America/New_York'
    when 'CONNECTICUT' then 'America/New_York' when 'DELAWARE' then 'America/New_York' when 'DISTRICT OF COLUMBIA' then 'America/New_York'
    when 'FLORIDA' then 'America/New_York' when 'GEORGIA' then 'America/New_York' when 'INDIANA' then 'America/New_York'
    when 'KENTUCKY' then 'America/New_York' when 'MAINE' then 'America/New_York' when 'MARYLAND' then 'America/New_York'
    when 'MASSACHUSETTS' then 'America/New_York' when 'MICHIGAN' then 'America/New_York' when 'NEW HAMPSHIRE' then 'America/New_York'
    when 'NEW JERSEY' then 'America/New_York' when 'NEW YORK' then 'America/New_York' when 'NORTH CAROLINA' then 'America/New_York'
    when 'OHIO' then 'America/New_York' when 'PENNSYLVANIA' then 'America/New_York' when 'RHODE ISLAND' then 'America/New_York'
    when 'SOUTH CAROLINA' then 'America/New_York' when 'VERMONT' then 'America/New_York' when 'VIRGINIA' then 'America/New_York'
    when 'WEST VIRGINIA' then 'America/New_York'
    when 'AL' then 'America/Chicago' when 'AR' then 'America/Chicago' when 'IL' then 'America/Chicago' when 'IA' then 'America/Chicago'
    when 'KS' then 'America/Chicago' when 'LA' then 'America/Chicago' when 'MN' then 'America/Chicago' when 'MS' then 'America/Chicago'
    when 'MO' then 'America/Chicago' when 'NE' then 'America/Chicago' when 'ND' then 'America/Chicago' when 'OK' then 'America/Chicago'
    when 'SD' then 'America/Chicago' when 'TN' then 'America/Chicago' when 'TX' then 'America/Chicago' when 'WI' then 'America/Chicago'
    when 'ALABAMA' then 'America/Chicago' when 'ARKANSAS' then 'America/Chicago' when 'ILLINOIS' then 'America/Chicago'
    when 'IOWA' then 'America/Chicago' when 'KANSAS' then 'America/Chicago' when 'LOUISIANA' then 'America/Chicago'
    when 'MINNESOTA' then 'America/Chicago' when 'MISSISSIPPI' then 'America/Chicago' when 'MISSOURI' then 'America/Chicago'
    when 'NEBRASKA' then 'America/Chicago' when 'NORTH DAKOTA' then 'America/Chicago' when 'OKLAHOMA' then 'America/Chicago'
    when 'SOUTH DAKOTA' then 'America/Chicago' when 'TENNESSEE' then 'America/Chicago' when 'TEXAS' then 'America/Chicago'
    when 'WISCONSIN' then 'America/Chicago'
    when 'AZ' then 'America/Phoenix' when 'ARIZONA' then 'America/Phoenix'
    when 'CO' then 'America/Denver' when 'ID' then 'America/Denver' when 'MT' then 'America/Denver' when 'NM' then 'America/Denver'
    when 'UT' then 'America/Denver' when 'WY' then 'America/Denver' when 'COLORADO' then 'America/Denver' when 'IDAHO' then 'America/Denver'
    when 'MONTANA' then 'America/Denver' when 'NEW MEXICO' then 'America/Denver' when 'UTAH' then 'America/Denver' when 'WYOMING' then 'America/Denver'
    when 'CA' then 'America/Los_Angeles' when 'NV' then 'America/Los_Angeles' when 'OR' then 'America/Los_Angeles' when 'WA' then 'America/Los_Angeles'
    when 'CALIFORNIA' then 'America/Los_Angeles' when 'NEVADA' then 'America/Los_Angeles' when 'OREGON' then 'America/Los_Angeles'
    when 'WASHINGTON' then 'America/Los_Angeles'
    when 'AK' then 'America/Anchorage' when 'ALASKA' then 'America/Anchorage'
    when 'HI' then 'Pacific/Honolulu' when 'HAWAII' then 'Pacific/Honolulu'
    else null end $$;

create or replace function public.dials_set_tz() returns trigger language plpgsql as $$
begin
  new.tz := public.state_tz(new.state);    -- derived from the state; not client-editable
  return new;
end $$;
drop trigger if exists dials_set_tz on public.dials;
create trigger dials_set_tz before insert or update of state, tz on public.dials
  for each row execute function public.dials_set_tz();
update public.dials set tz = public.state_tz(state) where tz is distinct from public.state_tz(state);

-- recipient window: weekdays 9:00-16:00 local (the send time must be before 16:00)
create or replace function public.recipient_window_ok(p_tz text, p_at timestamptz) returns boolean
 language plpgsql stable as $$
declare l timestamp;
begin
  l := p_at at time zone coalesce(p_tz, 'America/Denver');
  return extract(isodow from l) < 6 and l::time >= '09:00' and l::time < '16:00';
exception when others then
  l := p_at at time zone 'America/Denver';
  return extract(isodow from l) < 6 and l::time >= '09:00' and l::time < '16:00';
end $$;

-- ================================================================ capacity: ramp + per-domain cap
drop function if exists public.mailbox_day_cap(uuid);
create or replace function public.mailbox_day_cap(p_account uuid, p_now timestamptz default now()) returns int
 language sql stable security definer set search_path to 'public' as $$
  select least(20,
               coalesce(a.daily_send_limit, public.mailbox_daily_limit()),
               case when a.ramp_start is null then 1000
                    else 2 + greatest(0, (p_now at time zone public.person_tz(a.owner_id))::date - a.ramp_start) end)
    from email_accounts a where a.id = p_account $$;

create or replace function public.domain_cap() returns int language sql stable security definer set search_path to 'public' as $$
  select coalesce((select nullif(btrim(value), '')::int from app_secrets where key = 'domain_daily_cap'), 60) $$;
-- everything sent + queued today from every mailbox on this mailbox's sending domain
create or replace function public.domain_used_today(p_account uuid, p_now timestamptz default now()) returns int
 language sql stable security definer set search_path to 'public' as $$
  select coalesce(sum(public.mailbox_used_today(a2.id, p_now)), 0)::int
    from email_accounts a1 join email_accounts a2 on lower(split_part(a2.email_address, '@', 2)) = lower(split_part(a1.email_address, '@', 2))
   where a1.id = p_account $$;

-- ================================================================ suppression
create or replace function public.is_suppressed(p_email text) returns boolean
 language sql stable security definer set search_path to 'public' as $$
  select p_email is not null and btrim(p_email) <> '' and (
       exists (select 1 from suppressed_emails s where s.email = lower(btrim(p_email)) or public.norm_email(s.email) = public.norm_email(p_email))
    or exists (select 1 from suppressed_domains d where d.domain = public.email_domain(p_email))) $$;

-- one lead off the email track: not yet emailed -> backup number; mid-sequence -> emails stop, calls stay
create or replace function public.seq_to_backup(p_dial uuid, p_reason text) returns void
 language plpgsql security definer set search_path to 'public' as $$
declare d record;
begin
  select id, email_1_message_id, seq_state into d from dials where id = p_dial;
  if d.id is null or d.seq_state not in ('active', 'awaiting_copy') then return; end if;
  if d.email_1_message_id is null then
    update scheduled_emails s set status = 'cancelled', error = p_reason
      from sequence_tasks t where t.dial_id = p_dial and t.scheduled_email_id = s.id and s.status = 'pending';
    delete from sequence_tasks where dial_id = p_dial;
    update dials set sequence = 'backup', seq_state = null, seq_day0 = null, seq_stop_reason = p_reason where id = p_dial;
  else
    perform seq_stop(p_dial, 'stopped', p_reason, false);
  end if;
end $$;

create or replace function public.suppress_email_internal(p_email text, p_reason text, p_source text, p_by uuid) returns void
 language plpgsql security definer set search_path to 'public' as $$
declare v text := lower(btrim(coalesce(p_email, ''))); x record;
begin
  if v !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then return; end if;
  insert into suppressed_emails (email, reason, source, created_by) values (v, left(p_reason, 200), coalesce(p_source, 'manual'), p_by)
  on conflict (email) do nothing;
  for x in select id from dials where seq_state in ('active', 'awaiting_copy') and email is not null and norm_email(email) = norm_email(v) loop
    perform seq_to_backup(x.id, 'Not emailed: address is on the suppression list (' || left(p_reason, 80) || ').');
  end loop;
end $$;

create or replace function public.suppress_email(p_email text, p_reason text default 'manual') returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or not coalesce(is_admin(), false) then raise exception 'Only an admin can edit the suppression list'; end if;
  perform suppress_email_internal(p_email, coalesce(nullif(btrim(p_reason), ''), 'manual'), 'admin', auth.uid());
end $$;
create or replace function public.unsuppress_email(p_email text) returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or not coalesce(is_admin(), false) then raise exception 'Only an admin can edit the suppression list'; end if;
  delete from suppressed_emails where email = lower(btrim(coalesce(p_email, '')));
end $$;
create or replace function public.suppress_domain(p_domain text, p_reason text default 'manual') returns void
 language plpgsql security definer set search_path to 'public' as $$
declare v text := lower(btrim(coalesce(p_domain, ''))); x record;
begin
  if auth.uid() is null or not coalesce(is_admin(), false) then raise exception 'Only an admin can edit the suppression list'; end if;
  if v !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'Not a domain'; end if;
  insert into suppressed_domains (domain, reason, source, created_by) values (v, coalesce(nullif(btrim(p_reason), ''), 'manual'), 'admin', auth.uid())
  on conflict (domain) do nothing;
  for x in select id from dials where seq_state in ('active', 'awaiting_copy') and email_domain(email) = v loop
    perform seq_to_backup(x.id, 'Not emailed: domain is on the suppression list.');
  end loop;
end $$;

-- Why a lead can't be started: suppressed, or someone already has an active sequence to this address / company
create or replace function public.lead_block_reason(p_dial uuid) returns text
 language plpgsql stable security definer set search_path to 'public' as $$
declare d record;
begin
  select id, email into d from dials where id = p_dial;
  if d.id is null then return null; end if;
  if is_suppressed(d.email) then return 'suppressed'; end if;
  if d.email is not null and exists (
       select 1 from dials o join dial_lists l on l.id = o.list_id
        where o.id <> d.id and o.sequence = 'email5' and o.seq_state = 'active' and l.deleted_at is null and o.email is not null
          and (norm_email(o.email) = norm_email(d.email)
               or (is_personal_email(d.email) and email_domain(o.email) = email_domain(d.email) and not dedup_domain_exempt(email_domain(d.email))))) then
    return 'duplicate';
  end if;
  return null;
end $$;

-- inbound text classifiers (conservative; the reply's own words only, never quoted history)
create or replace function public.reply_top_text(p_body text) returns text language sql immutable as $$
  select left(regexp_replace(regexp_replace(coalesce(p_body, ''), E'(^|\\n)>[^\\n]*', '', 'g'),
                             E'(^|\\n)[ \\t]*(On [^\\n]{0,160}wrote:|-+[ ]*Original Message|From:[ \\t]).*$', '', 'g'), 600) $$;
create or replace function public.reply_wants_stop(p_subject text, p_body text) returns boolean language sql immutable as $$
  select (coalesce(p_subject, '') || ' ' || public.reply_top_text(p_body)) ~*
    '(\m(unsubscribe|opt[ -]?out)\M|\mremove (me|us|my (name|email|address))\M|\mremove (me )?from (your|this|the|our) (email |mailing )?(list|database)\M|\mtake (me|us) off\M|\mstop (emailing|e-mailing|emailed|emails|email|contacting|sending|messaging)\M|\mdo not (email|contact)\M|\mdon''?t (email|contact) (me|us)\M|\mnot interested\M|\mno longer interested\M|\mnever (contact|email)\M|\mleave me alone\M|\mcease and desist\M)'
  or public.reply_top_text(p_body) ~* '^\s*(stop|unsubscribe|remove)\s*[.!]?\s*$' $$;
create or replace function public.bounce_is_hard(p_subject text, p_body text) returns boolean language sql immutable as $$
  select (coalesce(p_subject, '') || ' ' || coalesce(p_body, '')) ~* '(\m5\.(1\.[0-9]{1,3}|2\.1|4\.1)\M|user unknown|no such user|unknown user|recipient address rejected|address not found|does not exist|unknown recipient|invalid recipient|mailbox (not found|unavailable|does not exist)|account (is )?disabled)'
     and (coalesce(p_subject, '') || ' ' || coalesce(p_body, '')) !~* '(\m4\.[0-9]\.[0-9]{1,3}\M|mailbox (is )?full|over quota|try again later)' $$;

-- ================================================================ null-safe intern/lead actions
create or replace function public.seq_prepare_list(p_list_id uuid) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid; n_email int := 0; n_backup int := 0; n_nocopy int := 0; r record;
begin
  select created_by into v_owner from dial_lists where id = p_list_id;
  if v_owner is null then raise exception 'List not found'; end if;
  if auth.uid() is null or not coalesce(auth.uid() = v_owner or is_admin() or is_team_lead_of(v_owner), false) then
    raise exception 'No access to that list';
  end if;
  for r in select * from dials where list_id = p_list_id and sequence is null loop
    if is_personal_email(r.email) then
      update dials set sequence = 'email5', seq_state = 'awaiting_copy' where id = r.id;
      n_email := n_email + 1;
      if coalesce(btrim(r.email_1),'') = '' or coalesce(btrim(r.email_subject),'') = '' then n_nocopy := n_nocopy + 1; end if;
    else
      update dials set sequence = 'backup', seq_state = null where id = r.id;
      n_backup := n_backup + 1;
    end if;
  end loop;
  update dial_lists set copy_status = 'pending_review'
   where id = p_list_id and copy_status = 'none'
     and exists (select 1 from dials where list_id = p_list_id and sequence = 'email5' and seq_state = 'awaiting_copy');
  return jsonb_build_object('email_sequence', n_email, 'backup', n_backup, 'call_sequence', n_backup, 'missing_copy', n_nocopy);
end $$;

create or replace function public.complete_sequence_task(p_task_id uuid, p_outcome text default null, p_note text default null, p_skip boolean default false)
 returns void language plpgsql security definer set search_path to 'public' as $$
declare t record;
begin
  select * into t from sequence_tasks where id = p_task_id for update;
  if t is null then raise exception 'Task not found'; end if;
  if auth.uid() is null or not coalesce(auth.uid() = t.owner_id or is_admin() or is_team_lead_of(t.owner_id), false) then raise exception 'Not your task'; end if;
  if t.kind in ('email','followup_email') then raise exception 'Emails send automatically'; end if;
  if t.status not in ('pending','failed') then return; end if;  -- double-click safe
  update sequence_tasks set status = case when p_skip then 'skipped' else 'done' end,
         outcome = p_outcome, note = nullif(btrim(coalesce(p_note,'')),''), completed_at = now(), completed_by = auth.uid()
   where id = p_task_id;
  perform seq_maybe_complete(t.dial_id);
end $$;

create or replace function public.stop_sequence(p_dial_id uuid, p_reason text default 'Stopped by user')
 returns void language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid;
begin
  select created_by into v_owner from dials where id = p_dial_id;
  if auth.uid() is null or not coalesce(auth.uid() = v_owner or is_admin() or is_team_lead_of(v_owner), false) then raise exception 'Not your lead'; end if;
  perform seq_stop(p_dial_id, 'stopped', p_reason, true);
end $$;

create or replace function public.trash_dial_list(p_list_id uuid) returns void
 language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid;
begin
  select created_by into v_owner from dial_lists where id = p_list_id and deleted_at is null;
  if not found then raise exception 'Tab not found.'; end if;
  if auth.uid() is null or not coalesce(v_owner = auth.uid() or is_admin(), false) then
    raise exception 'You can only delete your own tabs.';
  end if;
  update dial_lists set deleted_at = now(), deleted_by = auth.uid() where id = p_list_id;
end $$;

-- ================================================================ start_candidates / start_emails (suppression + dedup + pause)
drop function if exists public.start_candidates(uuid, int, uuid[]);
create or replace function public.start_candidates(p_list_id uuid, p_limit int default null, p_skip uuid[] default '{}')
 returns table(id uuid, email text, mv_result text, mv_checked_at timestamptz, blocked text)
 language sql stable security definer set search_path to 'public' as $$
  select d.id, d.email, d.mv_result, d.mv_checked_at, public.lead_block_reason(d.id) from dials d
   where d.list_id = p_list_id and d.sequence = 'email5' and d.seq_state = 'awaiting_copy'
     and d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)
     and not (d.id = any (coalesce(p_skip, '{}')))
   order by d.created_at, d.id limit p_limit $$;

create or replace function public.start_emails(p_list_id uuid, p_count int default null, p_dial_ids uuid[] default null) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_list record; r record; v_day0 date; v_tz text; v_started int := 0; v_backup int := 0; v_unver int := 0;
  v_susp int := 0; v_dup int := 0; v_block text;
  v_held int; v_ready int; v_cap int := 0; v_left int := 0; v_firsts int; v_day_cap int := 0; v_now timestamptz := now(); b uuid;
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
            limit p_count   -- null = all
  loop
    v_block := lead_block_reason(r.id);       -- evaluated per lead, so two leads of one company in this batch: the first wins
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
  for b in select owner_eligible_mailboxes(v_list.created_by, v_list.mandate) loop
    v_day_cap := v_day_cap + mailbox_day_cap(b, v_now);
    v_cap := v_cap + greatest(0, mailbox_day_cap(b, v_now) - mailbox_used_today(b, v_now));
  end loop;
  select count(*) into v_firsts from sequence_tasks where owner_id = v_list.created_by and kind = 'email' and status = 'pending';
  return jsonb_build_object('started', v_started, 'held_for_copy', v_held, 'moved_to_backup', v_backup,
    'suppressed', v_susp, 'duplicate', v_dup,
    'needs_verification', v_unver, 'remaining_ready', v_ready, 'today_capacity', v_cap,
    'est_days_to_send_firsts', case when v_day_cap > 0 then ceil(v_firsts::numeric / v_day_cap)::int end,
    'first_send_day', v_day0);
end $$;
create or replace function public.approve_list_copy(p_list_id uuid) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  return public.start_emails(p_list_id, null, null);
end $$;

create or replace function public.email_queue_status(p_owner uuid default auth.uid()) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_now timestamptz := now(); v_tz text; v_boxes jsonb; v_lists jsonb; v_next timestamptz; v_sent int; v_cap int; v_rem int;
begin
  if auth.uid() is null or p_owner is null then raise exception 'Sign in first'; end if;
  if not coalesce(auth.uid() = p_owner or is_admin() or is_team_lead_of(p_owner), false) then
    raise exception 'No access to that person';
  end if;
  v_tz := person_tz(p_owner);
  select coalesce(jsonb_agg(jsonb_build_object('address', a.email_address, 'cap', mailbox_day_cap(a.id, v_now),
           'used', mailbox_used_today(a.id, v_now)) order by a.email_address), '[]'),
         coalesce(sum(mailbox_day_cap(a.id, v_now)), 0), coalesce(sum(greatest(0, mailbox_day_cap(a.id, v_now) - mailbox_used_today(a.id, v_now))), 0)
    into v_boxes, v_cap, v_rem
    from email_accounts a where a.owner_id = p_owner and not a.needs_assignment and coalesce(a.send_paused_reason,'') = '';
  select count(*) into v_sent from email_messages m join email_accounts a on a.id = m.account_id
   where a.owner_id = p_owner and m.direction = 'outbound' and (m.sent_at at time zone v_tz)::date = (v_now at time zone v_tz)::date;
  select min(s.send_at) into v_next from scheduled_emails s join email_accounts a on a.id = s.account_id
   where a.owner_id = p_owner and s.status = 'pending' and s.send_at >= v_now;
  select coalesce(jsonb_agg(x order by x->>'name'), '[]') into v_lists from (
    select jsonb_build_object('list_id', l.id, 'name', l.name, 'paused', l.send_paused_reason,
      'ready_not_started', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok
                              and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
      'active', count(*) filter (where d.seq_state = 'active'),
      'replied', count(*) filter (where d.seq_state = 'replied'),
      'bounced', count(*) filter (where d.seq_state = 'bounced'),
      'backup', count(*) filter (where d.sequence = 'backup')) x
      from dial_lists l join dials d on d.list_id = l.id
     where l.created_by = p_owner and l.deleted_at is null group by l.id, l.name, l.send_paused_reason) q;
  return jsonb_build_object('timezone', v_tz, 'sent_today', v_sent, 'capacity_today', v_cap, 'remaining_today', v_rem,
                            'next_send_at', v_next, 'mailboxes', v_boxes, 'lists', v_lists);
end $$;

-- ================================================================ dispatcher (recipient window, domain cap, ramp, pauses, suppression)
create or replace function public.sequence_dispatch(p_now timestamptz default now()) returns int
 language plpgsql security definer set search_path to 'public' as $$
declare m record; t record; n int := 0; v_tz text; v_local timestamp; v_today date; v_last timestamptz; v_at timestamptz;
  v_r double precision; v_subject text; v_body text; v_sid uuid; xs record;
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
                                 group by st.owner_id having min(st.due_on) <= person_today(st.owner_id, p_now))) a
           cross join lateral mailbox_send_counts(a.id) c
     where c.sent + c.scheduled < c.daily_limit
     order by c.sent + c.scheduled, a.id
  loop
    v_tz := m.tz; v_local := p_now at time zone v_tz; v_today := v_local::date;
    continue when not is_business_day(v_today) or v_local::time < '08:30' or v_local::time >= '17:00';
    continue when mailbox_used_today(m.id, p_now) >= m.cap;                         -- cap incl. new-mailbox ramp
    continue when domain_used_today(m.id, p_now) >= domain_cap();                   -- all mailboxes on one sending domain
    v_last := mailbox_last_send(m.id);
    continue when v_last is not null and v_last > p_now + interval '15 minutes';
    v_r := 240 + random() * 300;                                   -- 4-9 minutes
    v_at := case when v_last is null or v_last <= p_now - interval '9 minutes' then p_now + make_interval(secs => v_r)
                 else greatest(p_now, v_last + make_interval(secs => v_r)) end;
    continue when (v_at at time zone v_tz)::date <> v_today or (v_at at time zone v_tz)::time >= '17:00';  -- waits for the next business day
    select st.id, st.kind, st.dial_id, d.email, d.full_name, d.email_subject, d.email_1, d.email_2,
           d.email_1_message_id, d.email_1_thread_id, d.created_by as dial_owner
      into t
      from sequence_tasks st join dials d on d.id = st.dial_id join dial_lists l on l.id = st.list_id
     where st.owner_id = m.owner_id and st.status = 'pending' and st.kind in ('email','followup_email')
       and st.due_on <= v_today and d.seq_state = 'active' and l.copy_status = 'approved' and l.deleted_at is null
       and l.send_paused_reason is null
       and d.copy_ok and d.copy_hash = md5(coalesce(d.email_subject,'') || chr(30) || coalesce(d.email_1,'') || chr(30) || coalesce(d.email_2,''))
       and (l.mandate is null or m.mandate is null or l.mandate = m.mandate)
       and public.recipient_window_ok(coalesce(d.tz, m.tz), v_at)                  -- 9:00-16:00 weekdays where the owner of the business is
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

-- ================================================================ queue -> function: settings out of the function body
do $$
declare d text; a text[];
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p where p.proname = 'dispatch_scheduled_emails' and p.pronamespace = 'public'::regnamespace;
  if d is not null and d ~ 'functions/v1/email-send' then
    a := regexp_match(d, 'url := ''([^'']+)''');
    if a is not null then insert into app_secrets (key, value) values ('dispatch_fn_url', a[1]) on conflict (key) do nothing; end if;
    a := regexp_match(d, '''Authorization'', ''Bearer ([^'']+)''');
    if a is not null then insert into app_secrets (key, value) values ('dispatch_bearer', a[1]) on conflict (key) do nothing; end if;
    a := regexp_match(d, '''x-cron-secret'', ''([^'']+)''');
    if a is not null then insert into app_secrets (key, value) values ('dispatch_cron_secret', a[1]) on conflict (key) do nothing; end if;
  end if;
end $$;

-- A row stuck in 'sending' for 15 min becomes 'unknown' (the message may or may not have gone): never retried automatically.
create or replace function public.dispatch_scheduled_emails() returns integer
 language plpgsql security definer set search_path to 'public' as $$
declare r record; n integer := 0; v_url text; v_bearer text; v_secret text;
begin
  select value into v_url from app_secrets where key = 'dispatch_fn_url';
  select value into v_bearer from app_secrets where key = 'dispatch_bearer';
  select value into v_secret from app_secrets where key = 'dispatch_cron_secret';
  if v_url is null or v_bearer is null or v_secret is null then raise exception 'dispatch settings missing in app_secrets'; end if;

  update scheduled_emails set status = 'unknown', error = 'Send result unknown — check Sent folder'
   where status = 'sending' and claimed_at < now() - interval '15 minutes';

  for r in
    select s.id from scheduled_emails s
      join email_accounts a on a.id = s.account_id
      left join dials d on d.id = s.dial_id
      left join dial_lists l on l.id = d.list_id
     where s.status = 'pending' and s.send_at <= now()
       and coalesce(a.send_paused_reason, '') = ''
       and (l.id is null or (l.deleted_at is null and l.send_paused_reason is null))
     order by s.send_at
     limit 20
     for update of s skip locked
  loop
    update scheduled_emails set status = 'sending', claimed_at = now() where id = r.id;
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_bearer, 'x-cron-secret', v_secret),
      body := jsonb_build_object('scheduled_id', r.id),
      timeout_milliseconds := 60000);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ================================================================ task trigger (unknown = needs review; non-burning pauses)
create or replace function public.scheduled_emails_seq_sync() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare t record; m record; v_sent_day date; v_owner uuid;
begin
  if new.status is not distinct from old.status then return new; end if;
  select * into t from sequence_tasks where scheduled_email_id = new.id;
  if t is null then return new; end if;
  if new.status = 'sent' then
    update sequence_tasks set status = 'done', completed_at = coalesce(new.sent_at, now()) where id = t.id;
    if t.kind = 'email' then
      select message_id, thread_id into m from email_messages where id = new.sent_message_id;
      select created_by into v_owner from dials where id = t.dial_id;
      v_sent_day := (coalesce(new.sent_at, now()) at time zone person_tz(v_owner))::date;
      update dials set email_1_message_id = m.message_id, email_1_thread_id = m.thread_id, seq_day0 = v_sent_day where id = t.dial_id;
      perform seq_build_tasks(t.dial_id);
    end if;
    perform seq_maybe_complete(t.dial_id);
  elsif new.status = 'unknown' then
    -- the server may have accepted it: a human checks the Sent folder; no retry (a retry could double-send)
    update sequence_tasks set status = 'failed', last_error = 'Send result unknown — check Sent folder' where id = t.id;
  elsif new.status = 'failed' then
    if coalesce(new.error,'') ~* '^(daily limit|mailbox paused|login failed)' or coalesce(new.error,'') ~* 'daily limit' then
      -- not the lead's fault: back to pending without using up an attempt
      update sequence_tasks set status = 'pending', scheduled_email_id = null, last_error = new.error,
             attempts = greatest(0, attempts - 1) where id = t.id;
      if t.kind = 'email' then update dials set sender_account_id = null where id = t.dial_id and email_1_message_id is null; end if;
    elsif t.attempts >= 3 then
      update sequence_tasks set status = 'failed', last_error = new.error where id = t.id;
    else
      update sequence_tasks set status = 'pending', scheduled_email_id = null, last_error = new.error where id = t.id;
    end if;
  elsif new.status = 'cancelled' and t.status = 'queued' then
    update sequence_tasks set status = 'cancelled', last_error = new.error where id = t.id;
  end if;
  return new;
end $$;

-- ================================================================ inbound: replies, bounces, suppression
create or replace function public.email_inbound_seq_check() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare d record; v_from text := lower(btrim(coalesce(new.from_address,''))); v_txt text; v_known boolean; v_hard boolean;
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
    values (d.id, d.list_id, d.created_by, 100, 0, 'reply', person_today(d.created_by))
    on conflict (dial_id, step) do nothing;
  end loop;
  -- an unsubscribe / stop / not-interested reply from someone we emailed: never email them again
  if v_from ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' and reply_wants_stop(new.subject, new.body_text) then
    v_known := exists (select 1 from dials where lower(email) = v_from)
            or exists (select 1 from email_messages o, jsonb_array_elements(coalesce(o.to_addresses, '[]'::jsonb)) a
                        where o.account_id = new.account_id and o.direction = 'outbound' and lower(a->>'address') = v_from);
    if v_known then perform suppress_email_internal(v_from, 'Asked to stop / unsubscribe', 'reply', null); end if;
  end if;
  return new;
end $$;

-- ================================================================ bounce auto-pause (cron every 15 min) + admin resume
create or replace function public.check_bounce_rates() returns int
 language plpgsql security definer set search_path to 'public' as $$
declare r record; n int := 0;
begin
  for r in
    select d.sender_account_id as acct, count(*) as sent, count(*) filter (where d.bounced_at is not null) as bounced
      from sequence_tasks t join dials d on d.id = t.dial_id join email_accounts a on a.id = d.sender_account_id
     where t.kind = 'email' and t.status = 'done' and t.completed_at > now() - interval '7 days'
       and t.completed_at > coalesce(a.bounce_check_from, '-infinity'::timestamptz)
     group by d.sender_account_id
    having count(*) >= 20 and (count(*) filter (where d.bounced_at is not null))::numeric / count(*) > 0.03
  loop
    update email_accounts set send_paused_reason = 'Auto-paused: bounce rate ' || round(100.0 * r.bounced / r.sent, 1) || '%'
     where id = r.acct and coalesce(send_paused_reason, '') = '';
    if found then n := n + 1; end if;
  end loop;
  for r in
    select t.list_id, count(*) as sent, count(*) filter (where d.bounced_at is not null) as bounced
      from sequence_tasks t join dials d on d.id = t.dial_id join dial_lists l on l.id = t.list_id
     where t.kind = 'email' and t.status = 'done' and t.completed_at > now() - interval '7 days' and l.deleted_at is null
       and t.completed_at > coalesce(l.bounce_check_from, '-infinity'::timestamptz)
     group by t.list_id
    having count(*) >= 20 and (count(*) filter (where d.bounced_at is not null))::numeric / count(*) > 0.03
  loop
    update dial_lists set send_paused_reason = 'Auto-paused: bounce rate ' || round(100.0 * r.bounced / r.sent, 1) || '%'
     where id = r.list_id and send_paused_reason is null;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function public.resume_sending(p_kind text, p_id uuid) returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or not coalesce(is_admin(), false) then raise exception 'Only an admin can resume sending'; end if;
  if p_kind = 'mailbox' then
    update email_accounts set send_paused_reason = null, bounce_check_from = now() where id = p_id;
    if not found then raise exception 'No such mailbox'; end if;
    with q as (select s.id, row_number() over (order by s.send_at) rn from scheduled_emails s
                where s.account_id = p_id and s.status = 'pending' and s.send_at < now())
    update scheduled_emails s set send_at = now() + make_interval(mins => (4 * q.rn + floor(random() * 5))::int) from q where s.id = q.id;
  elsif p_kind = 'list' then
    update dial_lists set send_paused_reason = null, bounce_check_from = now() where id = p_id;
    if not found then raise exception 'No such list'; end if;
    with q as (select s.id, row_number() over (partition by s.account_id order by s.send_at) rn from scheduled_emails s
                join dials d on d.id = s.dial_id where d.list_id = p_id and s.status = 'pending' and s.send_at < now())
    update scheduled_emails s set send_at = now() + make_interval(mins => (4 * q.rn + floor(random() * 5))::int) from q where s.id = q.id;
  else
    raise exception 'kind must be mailbox or list';
  end if;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'bounce-guard';
select cron.schedule('bounce-guard', '*/15 * * * *', 'select public.check_bounce_rates()');

-- ================================================================ deleting a list / lead cancels what is queued
create or replace function public.dial_lists_cancel_on_trash() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update scheduled_emails s set status = 'cancelled', error = 'List deleted'
      from dials d where d.list_id = new.id and s.dial_id = d.id and s.status = 'pending';
    update sequence_tasks set status = 'cancelled', last_error = 'List deleted'
     where list_id = new.id and status in ('pending', 'queued', 'failed');
  end if;
  return new;
end $$;
drop trigger if exists dial_lists_cancel_on_trash on public.dial_lists;
create trigger dial_lists_cancel_on_trash after update of deleted_at on public.dial_lists
  for each row execute function public.dial_lists_cancel_on_trash();

create or replace function public.dials_cancel_on_delete() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
begin
  update scheduled_emails set status = 'cancelled', error = 'Lead deleted' where dial_id = old.id and status = 'pending';
  return old;
end $$;
drop trigger if exists dials_cancel_on_delete on public.dials;
create trigger dials_cancel_on_delete before delete on public.dials
  for each row execute function public.dials_cancel_on_delete();

-- ================================================================ vault: mailbox passwords
create or replace function public.set_mailbox_password(p_account uuid, p_password text) returns void
 language plpgsql security definer set search_path to 'public', 'vault' as $$
declare sid uuid; v_null boolean;
begin
  if p_password is null or p_password = '' then raise exception 'password required'; end if;
  select password_secret_id into sid from email_accounts where id = p_account;
  if not found then raise exception 'no such mailbox'; end if;
  if sid is null then
    sid := vault.create_secret(p_password, 'mailbox_password_' || p_account::text, 'mailbox password');
    update email_accounts set password_secret_id = sid where id = p_account;
  else
    perform vault.update_secret(sid, p_password);
  end if;
  -- plaintext column: dropped only where the flag says so (test first); elsewhere kept in sync for rollout
  v_null := exists (select 1 from app_secrets where key = 'null_plaintext_passwords' and value = 'true');
  update email_accounts set password = case when v_null then null else p_password end where id = p_account;
end $$;

create or replace function public.get_mailbox_password(p_account uuid) returns text
 language plpgsql security definer set search_path to 'public', 'vault' as $$
declare sid uuid; pw text; v text;
begin
  select password_secret_id, password into sid, pw from email_accounts where id = p_account;
  if sid is not null then
    select decrypted_secret into v from vault.decrypted_secrets where id = sid;
    if v is not null then return v; end if;
  end if;
  return pw;
end $$;

do $$
declare r record;
begin
  for r in select id, password from email_accounts where password is not null and password <> '' and password_secret_id is null loop
    perform public.set_mailbox_password(r.id, r.password);
  end loop;
  if exists (select 1 from app_secrets where key = 'null_plaintext_passwords' and value = 'true') then
    update email_accounts set password = null where password_secret_id is not null;
  end if;
end $$;

-- ================================================================ mailbox-admin API key: store only the hash
do $$
begin
  if exists (select 1 from app_secrets where key = 'mailbox_admin_api_key') then
    insert into app_secrets (key, value)
    select 'mailbox_admin_api_key_hash', encode(extensions.digest(convert_to(value, 'utf8'), 'sha256'), 'hex')
      from app_secrets where key = 'mailbox_admin_api_key'
    on conflict (key) do nothing;
    delete from app_secrets where key = 'mailbox_admin_api_key'
     and exists (select 1 from app_secrets where key = 'mailbox_admin_api_key_hash');
  end if;
end $$;

-- ================================================================ grants: nothing anonymous
-- Every SECURITY DEFINER function in public loses PUBLIC and anon; authenticated keeps what it had; service_role always.
-- Kept for anon: boolean RLS predicates evaluated inside policies (they are null-safe and take no free-form input)
-- and wp_key_ok (policy helper of the wp_* tables; those tables are a live-only item, see CRM_DESIGN.md section 5).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, has_function_privilege('authenticated', p.oid, 'execute') as auth_had
             from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef
              and p.proname not in ('is_admin', 'is_team_lead', 'is_team_lead_of', 'my_team_ids', 'has_sourcing_access', 'wp_key_ok')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.auth_had then execute format('grant execute on function %s to authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
-- internal-only
revoke execute on function public.start_candidates(uuid, int, uuid[]), public.seq_to_backup(uuid, text),
  public.suppress_email_internal(text, text, text, uuid), public.lead_block_reason(uuid), public.check_bounce_rates(),
  public.set_mailbox_password(uuid, text), public.get_mailbox_password(uuid), public.mailbox_day_cap(uuid, timestamptz),
  public.domain_used_today(uuid, timestamptz), public.domain_cap(), public.is_suppressed(text), public.dedup_domain_exempt(text),
  public.dispatch_scheduled_emails(), public.sequence_dispatch(timestamptz)
  from public, anon, authenticated;
grant execute on function public.start_candidates(uuid, int, uuid[]), public.seq_to_backup(uuid, text),
  public.suppress_email_internal(text, text, text, uuid), public.lead_block_reason(uuid), public.check_bounce_rates(),
  public.set_mailbox_password(uuid, text), public.get_mailbox_password(uuid), public.mailbox_day_cap(uuid, timestamptz),
  public.domain_used_today(uuid, timestamptz), public.domain_cap(), public.is_suppressed(text), public.dedup_domain_exempt(text),
  public.dispatch_scheduled_emails(), public.sequence_dispatch(timestamptz) to service_role;
grant execute on function public.suppress_email(text, text), public.unsuppress_email(text), public.suppress_domain(text, text),
  public.resume_sending(text, uuid) to authenticated;
-- future functions: no implicit anon execute
alter default privileges for role postgres in schema public revoke execute on functions from anon;
