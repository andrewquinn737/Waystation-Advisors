-- Server-enforced copy gate + guidelines store + Claude connector tokens. Idempotent.
-- Rule: nothing sends unless the server-side check (edge function copy-gate, which runs the SAME
-- js/copyLint.js the review screen uses) has passed the EXACT current text. Any edit, from any
-- path (manual, import, Claude connector), resets the pass until the server re-checks.
set check_function_bodies = off;

alter table public.dials
  add column if not exists copy_ok boolean not null default false,
  add column if not exists copy_errors jsonb,
  add column if not exists copy_warnings jsonb,
  add column if not exists copy_hash text,
  add column if not exists copy_checked_at timestamptz;

create or replace function public.copy_text_hash(s text, e1 text, e2 text) returns text
 language sql immutable as $$ select md5(coalesce(s,'') || chr(30) || coalesce(e1,'') || chr(30) || coalesce(e2,'')) $$;

-- App users (role authenticated/anon) can edit copy but can never mark it checked, and can never
-- touch sequence state; only SECURITY DEFINER functions / the service role can.
create or replace function public.dials_copy_guard() returns trigger
 language plpgsql as $$
declare v_client boolean := current_user in ('authenticated', 'anon');
begin
  if v_client and (new.copy_ok is distinct from old.copy_ok or new.copy_hash is distinct from old.copy_hash
       or new.copy_errors is distinct from old.copy_errors or new.copy_checked_at is distinct from old.copy_checked_at
       or new.sequence is distinct from old.sequence or new.seq_state is distinct from old.seq_state
       or new.seq_day0 is distinct from old.seq_day0 or new.sender_account_id is distinct from old.sender_account_id
       or new.email_1_message_id is distinct from old.email_1_message_id or new.email_1_thread_id is distinct from old.email_1_thread_id) then
    raise exception 'Sequence and copy-check fields are managed by the system';
  end if;
  if new.email_subject is distinct from old.email_subject or new.email_1 is distinct from old.email_1
     or new.email_2 is distinct from old.email_2 or new.full_name is distinct from old.full_name
     or new.company_name is distinct from old.company_name then
    new.copy_ok := false; new.copy_hash := null;
    -- copy can't change after the first email went out (the follow-up threads under the sent text)
    if old.email_1_message_id is not null and (new.email_subject is distinct from old.email_subject or new.email_1 is distinct from old.email_1) then
      raise exception 'The first email was already sent; only the follow-up can still be edited';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists dials_copy_guard on public.dials;
create trigger dials_copy_guard before update on public.dials for each row execute function public.dials_copy_guard();
-- inserts (CSV import) always start unchecked
create or replace function public.dials_copy_insert() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') then
    new.copy_ok := false; new.copy_hash := null; new.copy_errors := null; new.copy_checked_at := null;
    new.sequence := null; new.seq_state := null; new.seq_day0 := null; new.sender_account_id := null;
    new.email_1_message_id := null; new.email_1_thread_id := null;
  end if;
  return new;
end $$;
drop trigger if exists dials_copy_insert on public.dials;
create trigger dials_copy_insert before insert on public.dials for each row execute function public.dials_copy_insert();

-- Called by the copy-gate edge function (service role) with results for a whole list.
-- p_results: [{id, ok, errors[], warnings[], hash}]; a result only counts if the hash still
-- matches the row (an edit that raced the check leaves it unchecked).
create or replace function public.copy_gate_record(p_list_id uuid, p_results jsonb) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare r jsonb; n_ok int := 0; n_bad int := 0; n_started int := 0; v_list record; v_day0 date;
begin
  for r in select * from jsonb_array_elements(p_results) loop
    update dials set copy_ok = (r->>'ok')::boolean, copy_errors = r->'errors', copy_warnings = r->'warnings',
                     copy_hash = r->>'hash', copy_checked_at = now()
     where id = (r->>'id')::uuid and list_id = p_list_id
       and copy_text_hash(email_subject, email_1, email_2) = r->>'hash';
    if (r->>'ok')::boolean then n_ok := n_ok + 1; else n_bad := n_bad + 1; end if;
  end loop;
  -- list already approved: leads fixed since then join the sequence now
  select * into v_list from dial_lists where id = p_list_id;
  if v_list.copy_status = 'approved' then
    v_day0 := case when is_business_day(denver_today()) and extract(hour from now() at time zone 'America/Denver') < 15
                   then denver_today() else next_business_day(denver_today() + 1) end;
    with go as (
      update dials set seq_state = 'active', seq_day0 = v_day0
       where list_id = p_list_id and sequence = 'email5' and seq_state = 'awaiting_copy' and copy_ok
         and copy_hash = copy_text_hash(email_subject, email_1, email_2)
      returning id)
    select count(*) into n_started from go;
    perform seq_build_tasks(d.id) from dials d where d.list_id = p_list_id and d.seq_state = 'active'
      and d.sequence = 'email5' and not exists (select 1 from sequence_tasks t where t.dial_id = d.id);
  end if;
  return jsonb_build_object('passed', n_ok, 'held', n_bad, 'started_now', n_started);
end $$;
revoke execute on function public.copy_gate_record(uuid, jsonb) from public, anon, authenticated;

-- Approval now means "send every lead whose copy passed the server check; hold the rest".
create or replace function public.approve_list_copy(p_list_id uuid) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_list record; n int := 0; n_held int := 0; n_unchecked int := 0; r record; v_day0 date; v_boxes int;
begin
  select * into v_list from dial_lists where id = p_list_id;
  if v_list is null then raise exception 'List not found'; end if;
  if not (auth.uid() = v_list.created_by or is_admin() or is_team_lead_of(v_list.created_by)) then
    raise exception 'Only the list owner, their team lead, or an admin can approve this copy';
  end if;
  select count(*) into v_boxes from email_accounts a
   where a.owner_id = v_list.created_by and not a.needs_assignment and coalesce(a.send_paused_reason,'') = ''
     and (v_list.mandate is null or a.mandate is null or a.mandate = v_list.mandate);
  if v_boxes = 0 then
    raise exception 'The list owner has no sending mailbox for this kind of outreach yet. Ask an admin to assign one.';
  end if;
  v_day0 := case when is_business_day(denver_today()) and extract(hour from now() at time zone 'America/Denver') < 15
                 then denver_today() else next_business_day(denver_today() + 1) end;
  for r in select * from dials where list_id = p_list_id and sequence = 'email5' and seq_state = 'awaiting_copy' loop
    if r.copy_checked_at is null or r.copy_hash is distinct from copy_text_hash(r.email_subject, r.email_1, r.email_2) then
      n_unchecked := n_unchecked + 1; continue;
    end if;
    if not r.copy_ok then n_held := n_held + 1; continue; end if;
    update dials set seq_state = 'active', seq_day0 = v_day0 where id = r.id;
    perform seq_build_tasks(r.id);
    n := n + 1;
  end loop;
  if n_unchecked > 0 and n = 0 and n_held = 0 then
    raise exception 'These emails have not been checked by the server yet. Reopen the review and try again.';
  end if;
  update dial_lists set copy_status = 'approved', copy_approved_at = now(), copy_approved_by = auth.uid() where id = p_list_id;
  return jsonb_build_object('started', n, 'held', n_held, 'unchecked', n_unchecked, 'first_send_day', v_day0,
    'mailboxes', v_boxes,
    'daily_capacity', (select coalesce(sum(coalesce(daily_send_limit, mailbox_daily_limit())),0) from email_accounts a
       where a.owner_id = v_list.created_by and not a.needs_assignment and coalesce(a.send_paused_reason,'') = ''
         and (v_list.mandate is null or a.mandate is null or a.mandate = v_list.mandate)));
end $$;

-- ---------------------------------------------------------------- guidelines (single source)
create table if not exists public.copy_guidelines (
  mandate text primary key check (mandate in ('ma','data')),
  body text not null,
  version text not null,
  updated_at timestamptz not null default now()
);
alter table public.copy_guidelines enable row level security;
drop policy if exists copy_guidelines_read on public.copy_guidelines;
create policy copy_guidelines_read on public.copy_guidelines for select to authenticated using (true);
revoke all on public.copy_guidelines from anon, authenticated;
grant select on public.copy_guidelines to authenticated;

-- ---------------------------------------------------------------- copy history (who changed what, how)
create table if not exists public.copy_revisions (
  id bigint generated always as identity primary key,
  dial_id uuid not null references public.dials(id) on delete cascade,
  changed_by uuid references public.profiles(id) on delete set null,
  source text not null check (source in ('manual','claude_connector','import')),
  before jsonb, after jsonb, note text,
  created_at timestamptz not null default now()
);
create index if not exists copy_revisions_dial_idx on public.copy_revisions (dial_id, created_at desc);
alter table public.copy_revisions enable row level security;
drop policy if exists copy_revisions_read on public.copy_revisions;
create policy copy_revisions_read on public.copy_revisions for select using (
  exists (select 1 from dials d where d.id = copy_revisions.dial_id
          and (d.created_by = auth.uid() or is_admin() or is_team_lead_of(d.created_by))));
revoke all on public.copy_revisions from anon, authenticated;
grant select on public.copy_revisions to authenticated;

create or replace function public.dials_copy_history() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
begin
  if new.email_subject is distinct from old.email_subject or new.email_1 is distinct from old.email_1 or new.email_2 is distinct from old.email_2 then
    insert into copy_revisions (dial_id, changed_by, source, before, after)
    values (new.id, auth.uid(), coalesce(nullif(current_setting('waystation.copy_source', true), ''), 'manual'),
            jsonb_build_object('subject', old.email_subject, 'email_1', old.email_1, 'email_2', old.email_2),
            jsonb_build_object('subject', new.email_subject, 'email_1', new.email_1, 'email_2', new.email_2));
  end if;
  return new;
end $$;
drop trigger if exists dials_copy_history on public.dials;
create trigger dials_copy_history after update of email_subject, email_1, email_2 on public.dials
  for each row execute function public.dials_copy_history();

-- ---------------------------------------------------------------- Claude connector tokens
-- One personal connector URL per person. Only a hash is stored; the token is shown once.
create table if not exists public.claude_connector_tokens (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table public.claude_connector_tokens enable row level security;
drop policy if exists claude_tokens_own on public.claude_connector_tokens;
create policy claude_tokens_own on public.claude_connector_tokens for select using (profile_id = auth.uid() or is_admin());
revoke all on public.claude_connector_tokens from anon, authenticated;
grant select (id, profile_id, label, created_at, last_used_at, revoked_at) on public.claude_connector_tokens to authenticated;

create or replace function public.create_claude_connector_token(p_label text default 'Claude') returns text
 language plpgsql security definer set search_path to 'public', 'extensions' as $$
declare tok text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  update claude_connector_tokens set revoked_at = now() where profile_id = auth.uid() and revoked_at is null;
  insert into claude_connector_tokens (profile_id, token_hash, label)
  values (auth.uid(), encode(extensions.digest(tok, 'sha256'), 'hex'), left(coalesce(p_label,'Claude'), 60));
  return tok;
end $$;
create or replace function public.revoke_claude_connector_tokens() returns void
 language sql security definer set search_path to 'public' as $$
  update claude_connector_tokens set revoked_at = now() where profile_id = auth.uid() and revoked_at is null $$;
grant execute on function public.create_claude_connector_token(text), public.revoke_claude_connector_tokens() to authenticated;
revoke execute on function public.create_claude_connector_token(text), public.revoke_claude_connector_tokens() from anon;

-- ---------------------------------------------------------------- helpers for copy-gate / connector
create or replace function public.can_manage_list(p_user uuid, p_list_id uuid) returns boolean
 language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from dial_lists l join profiles p on p.id = p_user
    where l.id = p_list_id and l.deleted_at is null
      and (l.created_by = p_user or p.role = 'admin'
           or (p.role = 'team_lead' and exists (select 1 from profiles o where o.id = l.created_by
                 and o.team_id = any (my_team_ids(p_user))))))
$$;
-- every email-sequence lead of a list (whole list = context for the cross-lead repetition rule),
-- with the hash of the exact text being checked
create or replace function public.copy_gate_rows(p_list_id uuid)
 returns table(id uuid, full_name text, company_name text, email_subject text, email_1 text, email_2 text, hash text)
 language sql stable security definer set search_path to 'public' as $$
  select d.id, d.full_name, d.company_name, d.email_subject, d.email_1, d.email_2,
         copy_text_hash(d.email_subject, d.email_1, d.email_2)
    from dials d where d.list_id = p_list_id and d.sequence = 'email5'
$$;
revoke execute on function public.can_manage_list(uuid, uuid), public.copy_gate_rows(uuid) from public, anon, authenticated;
