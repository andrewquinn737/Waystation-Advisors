-- Claude connector (remote MCP edge function `claude-connector`): rate limit, scoped read helpers and the
-- save function. All functions are service-role only; the edge function passes the token's profile id and
-- every function re-checks can_manage_list. Idempotent.
set check_function_bodies = off;

-- ---------------------------------------------------------------- rate limit (120 tool calls / token / 10 min)
create table if not exists public.claude_connector_calls (
  id bigint generated always as identity primary key,
  token_id uuid not null references public.claude_connector_tokens(id) on delete cascade,
  called_at timestamptz not null default now()
);
create index if not exists claude_connector_calls_idx on public.claude_connector_calls (token_id, called_at desc);
alter table public.claude_connector_calls enable row level security;
revoke all on public.claude_connector_calls from anon, authenticated;

create or replace function public.connector_rate_hit(p_token_id uuid, p_max int default 120) returns boolean
 language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  delete from claude_connector_calls where token_id = p_token_id and called_at < now() - interval '1 hour';
  select count(*) into n from claude_connector_calls where token_id = p_token_id and called_at > now() - interval '10 minutes';
  if n >= p_max then return false; end if;
  insert into claude_connector_calls (token_id) values (p_token_id);
  return true;
end $$;

-- history rows record WHO changed copy even when the writer is a SECURITY DEFINER function (no auth.uid())
create or replace function public.dials_copy_history() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
begin
  if new.email_subject is distinct from old.email_subject or new.email_1 is distinct from old.email_1 or new.email_2 is distinct from old.email_2 then
    insert into copy_revisions (dial_id, changed_by, source, before, after, note)
    values (new.id, coalesce(auth.uid(), nullif(current_setting('waystation.copy_by', true), '')::uuid),
            coalesce(nullif(current_setting('waystation.copy_source', true), ''), 'manual'),
            jsonb_build_object('subject', old.email_subject, 'email_1', old.email_1, 'email_2', old.email_2),
            jsonb_build_object('subject', new.email_subject, 'email_1', new.email_1, 'email_2', new.email_2),
            nullif(current_setting('waystation.copy_note', true), ''));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- reads
create or replace function public.connector_my_lists(p_profile uuid) returns jsonb
 language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('id', l.id, 'name', l.name, 'mandate', l.mandate, 'copy_status', l.copy_status,
      'counts', jsonb_build_object(
        'total', count(d.id),
        'passed', count(*) filter (where d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
        'held', count(*) filter (where not d.copy_ok and d.copy_checked_at is not null and d.copy_hash is not null
                                   and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
        'unchecked', count(*) filter (where d.copy_checked_at is null or d.copy_hash is distinct from copy_text_hash(d.email_subject, d.email_1, d.email_2)),
        'sent', count(*) filter (where d.email_1_message_id is not null))) as x
    from dial_lists l join dials d on d.list_id = l.id and d.sequence = 'email5'
    where can_manage_list(p_profile, l.id)
    group by l.id) s
$$;

-- one lead the person may manage, else null (identical for "doesn't exist" and "not yours")
create or replace function public.connector_get_dial(p_profile uuid, p_dial uuid) returns jsonb
 language sql stable security definer set search_path to 'public' as $$
  select to_jsonb(d) || jsonb_build_object('list_mandate', l.mandate, 'list_name', l.name)
    from dials d join dial_lists l on l.id = d.list_id
   where d.id = p_dial and d.sequence = 'email5' and can_manage_list(p_profile, d.list_id)
$$;

create or replace function public.connector_drafts(p_profile uuid, p_list uuid, p_filter text, p_limit int, p_offset int) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_rows jsonb; v_total int;
begin
  if not can_manage_list(p_profile, p_list) then return null; end if;
  with b as (
    select d.*, case when d.copy_checked_at is null or d.copy_hash is distinct from copy_text_hash(d.email_subject, d.email_1, d.email_2) then 'unchecked'
                     when d.copy_ok then 'passed' else 'held' end as st
      from dials d where d.list_id = p_list and d.sequence = 'email5'),
  f as (select * from b where p_filter = 'all' or st = p_filter)
  select (select count(*) from f),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'company_name', company_name, 'full_name', full_name, 'email', email,
           'industry', industry, 'city', city, 'state', state, 'summary', left(summary, 600), 'website', website,
           'email_subject', email_subject, 'email_1', email_1, 'email_2', email_2,
           'copy_ok', st = 'passed', 'copy_state', st,
           'copy_errors', case when st = 'held' then coalesce(copy_errors, '[]'::jsonb) else '[]'::jsonb end,
           'copy_warnings', case when st = 'unchecked' then '[]'::jsonb else coalesce(copy_warnings, '[]'::jsonb) end,
           'already_sent', email_1_message_id is not null) order by company_name, id), '[]'::jsonb)
    into v_total, v_rows
    from (select * from f order by company_name, id limit greatest(least(p_limit, 50), 1) offset greatest(p_offset, 0)) g;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

create or replace function public.connector_history(p_profile uuid, p_dial uuid) returns jsonb
 language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('when', r.created_at, 'source', r.source, 'by', p.full_name,
           'note', r.note, 'before', r.before, 'after', r.after) order by r.created_at desc, r.id desc), '[]'::jsonb)
    from (select * from copy_revisions where dial_id = p_dial
           and exists (select 1 from dials d where d.id = p_dial and d.sequence = 'email5' and can_manage_list(p_profile, d.list_id))
           order by created_at desc, id desc limit 10) r
    left join profiles p on p.id = r.changed_by
$$;

-- ---------------------------------------------------------------- write
create or replace function public.connector_save_copy(p_profile uuid, p_dial uuid, p_subject text, p_e1 text, p_e2 text, p_note text)
 returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare d record;
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
  return jsonb_build_object('ok', true, 'list_id', d.list_id);
end $$;

revoke execute on function public.connector_rate_hit(uuid, int), public.connector_my_lists(uuid), public.connector_get_dial(uuid, uuid),
  public.connector_drafts(uuid, uuid, text, int, int), public.connector_history(uuid, uuid),
  public.connector_save_copy(uuid, uuid, text, text, text, text) from public, anon, authenticated;
