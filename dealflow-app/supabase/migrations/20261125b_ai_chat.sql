-- In-app "Edit with Claude" chat: threads, messages (streamed by a worker on the Oracle VM), a job queue and worker
-- heartbeat. Admins only. Feature flag: app_secrets key 'ai_chat_enabled' = 'true' (delete or set anything else = off).
-- The worker uses the service role (bypasses RLS); people only reach this through RLS (read) and post_ai_message (write).
-- Idempotent.
set check_function_bodies = off;

create table if not exists public.ai_threads (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.dial_lists(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  claude_session_id text,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);
create unique index if not exists ai_threads_one_open on public.ai_threads (list_id, created_by) where status = 'open';

create table if not exists public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.ai_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  partial boolean not null default false,
  meta jsonb not null default '{}'::jsonb,          -- worker sets {"saved": n} when the reply saved draft changes
  created_at timestamptz not null default now()
);
create index if not exists ai_messages_thread_idx on public.ai_messages (thread_id, created_at);

create table if not exists public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.ai_threads(id) on delete cascade,
  prompt text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'blocked_auth', 'waiting')),
  attempts int not null default 0,
  retry_after timestamptz,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);
create index if not exists ai_jobs_status_idx on public.ai_jobs (status, created_at);

create table if not exists public.ai_workers (
  id text primary key,
  last_seen timestamptz not null default now(),
  auth_ok boolean not null default false,
  auth_error text,
  version text
);

-- ---------------------------------------------------------------- RLS: admins read; nobody writes directly
alter table public.ai_threads enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.ai_workers enable row level security;
drop policy if exists ai_threads_admin on public.ai_threads;
create policy ai_threads_admin on public.ai_threads for select to authenticated using (is_admin());
drop policy if exists ai_messages_admin on public.ai_messages;
create policy ai_messages_admin on public.ai_messages for select to authenticated using (is_admin());
drop policy if exists ai_workers_admin on public.ai_workers;
create policy ai_workers_admin on public.ai_workers for select to authenticated using (is_admin());
revoke all on public.ai_threads, public.ai_messages, public.ai_jobs, public.ai_workers from anon, authenticated;
grant select on public.ai_threads, public.ai_messages, public.ai_workers to authenticated;

-- realtime for the message stream (RLS applies: only admins receive rows)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ai_messages') then
    alter publication supabase_realtime add table public.ai_messages;
  end if;
end $$;

-- ---------------------------------------------------------------- feature flag + status
create or replace function public.ai_chat_enabled() returns boolean
 language sql stable security definer set search_path to 'public' as $$
  select coalesce((select lower(btrim(value)) = 'true' from app_secrets where key = 'ai_chat_enabled'), false) $$;

-- what the UI shows: is the chat on, and is a worker alive and signed in
create or replace function public.ai_chat_status() returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare w record;
begin
  if not is_admin() then return jsonb_build_object('enabled', false); end if;
  select * into w from ai_workers order by (last_seen > now() - interval '90 seconds' and auth_ok) desc, last_seen desc limit 1;   -- any online, signed-in worker wins
  return jsonb_build_object('enabled', ai_chat_enabled(),
    'worker', case when w.id is null then null else jsonb_build_object('id', w.id, 'last_seen', w.last_seen,
        'online', w.last_seen > now() - interval '90 seconds', 'auth_ok', w.auth_ok, 'auth_error', w.auth_error, 'version', w.version) end);
end $$;

-- ---------------------------------------------------------------- post a message (admin) -> thread + message + job
create or replace function public.post_ai_message(p_list_id uuid, p_text text) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_me uuid := auth.uid(); v_thread uuid; v_msg uuid; v_job uuid; v_text text := btrim(coalesce(p_text, ''));
begin
  if v_me is null or not is_admin() then raise exception 'Admins only'; end if;
  if not ai_chat_enabled() then raise exception 'The Claude chat is switched off'; end if;
  if not can_manage_list(v_me, p_list_id) then raise exception 'List not found'; end if;
  if v_text = '' then raise exception 'Type a message first'; end if;
  if length(v_text) > 4000 then raise exception 'That message is too long (4000 characters max)'; end if;
  if (select count(*) from ai_messages m join ai_threads t on t.id = m.thread_id
       where t.created_by = v_me and m.role = 'user' and m.created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many messages this hour. Try again later.';
  end if;
  select id into v_thread from ai_threads where list_id = p_list_id and created_by = v_me and status = 'open';
  if v_thread is null then
    insert into ai_threads (list_id, created_by) values (p_list_id, v_me) returning id into v_thread;
  end if;
  if exists (select 1 from ai_jobs where thread_id = v_thread and status in ('queued', 'running', 'waiting')) then
    raise exception 'Claude is still working on your last message';
  end if;
  -- a message that was waiting on a signed-out Claude is superseded by this newer one (history carries it)
  update ai_jobs set status = 'failed', error = 'superseded by a newer message' where thread_id = v_thread and status = 'blocked_auth';
  insert into ai_messages (thread_id, role, content) values (v_thread, 'user', v_text) returning id into v_msg;
  insert into ai_jobs (thread_id, prompt) values (v_thread, v_text) returning id into v_job;
  return jsonb_build_object('thread_id', v_thread, 'message_id', v_msg, 'job_id', v_job);
end $$;

-- start a fresh conversation for this list (the old one stays readable but is closed)
create or replace function public.ai_new_thread(p_list_id uuid) returns void
 language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or not is_admin() then raise exception 'Admins only'; end if;
  if exists (select 1 from ai_jobs j join ai_threads t on t.id = j.thread_id
              where t.list_id = p_list_id and t.created_by = auth.uid() and t.status = 'open' and j.status in ('queued', 'running', 'waiting')) then
    raise exception 'Claude is still working. Wait for the reply first.';
  end if;
  update ai_threads set status = 'closed' where list_id = p_list_id and created_by = auth.uid() and status = 'open';
end $$;

-- ---------------------------------------------------------------- claim (service role only)
-- Returns null when nothing is due, else everything the worker needs to build the prompt.
-- p_only_like / p_not_like: optional list-name patterns, so a test worker and the real worker never take each other's jobs.
-- p_allow_blocked: the worker is signed in again, so jobs parked as blocked_auth (under 2 hours old) may run.
drop function if exists public.claim_ai_job(boolean);
create or replace function public.claim_ai_job(p_allow_blocked boolean default false, p_only_like text default null, p_not_like text default null) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare j record; t record; l record; g record; hist jsonb;
begin
  update ai_jobs set status = 'failed', error = 'worker timed out' where status = 'running' and claimed_at < now() - interval '30 minutes';
  update ai_jobs set status = 'failed', error = 'expired while Claude was signed out' where status = 'blocked_auth' and created_at < now() - interval '2 hours';
  select * into j from ai_jobs x
   where ((x.status = 'queued' and (x.retry_after is null or x.retry_after <= now()))
       or (x.status = 'waiting' and x.retry_after <= now())
       or (p_allow_blocked and x.status = 'blocked_auth'))
     and not exists (select 1 from ai_jobs r where r.thread_id = x.thread_id and r.status = 'running')
     and (p_only_like is null or exists (select 1 from ai_threads tt join dial_lists ll on ll.id = tt.list_id where tt.id = x.thread_id and ll.name like p_only_like))
     and (p_not_like is null or not exists (select 1 from ai_threads tt join dial_lists ll on ll.id = tt.list_id where tt.id = x.thread_id and ll.name like p_not_like))
   order by x.created_at limit 1 for update skip locked;
  if j.id is null then return null; end if;
  update ai_jobs set status = 'running', attempts = attempts + 1, claimed_at = now(), error = null where id = j.id;
  select * into t from ai_threads where id = j.thread_id;
  select id, name, mandate into l from dial_lists where id = t.list_id;
  select body, version into g from copy_guidelines where mandate = l.mandate;
  select coalesce(jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content) order by m.created_at, m.id), '[]'::jsonb) into hist
    from (select * from ai_messages where thread_id = j.thread_id and not partial and role in ('user', 'assistant')
           order by created_at desc, id desc limit 21) m;
  return jsonb_build_object('job', jsonb_build_object('id', j.id, 'prompt', j.prompt, 'attempts', j.attempts + 1),
    'thread', jsonb_build_object('id', t.id, 'created_by', t.created_by, 'claude_session_id', t.claude_session_id),
    'list', jsonb_build_object('id', l.id, 'name', l.name, 'mandate', l.mandate),
    'guidelines', case when g.body is null then null else jsonb_build_object('body', g.body, 'version', g.version) end,
    'history', hist);
end $$;

revoke execute on function public.ai_chat_enabled(), public.claim_ai_job(boolean, text, text) from public, anon, authenticated;
revoke execute on function public.ai_chat_status(), public.post_ai_message(uuid, text), public.ai_new_thread(uuid) from public, anon;
grant execute on function public.ai_chat_status(), public.post_ai_message(uuid, text), public.ai_new_thread(uuid) to authenticated;
grant execute on function public.ai_chat_enabled(), public.claim_ai_job(boolean, text, text) to service_role;

-- ---------------------------------------------------------------- the worker's connector token gets a higher call budget
-- (a bulk edit is ~2 calls per draft; the people limit of 120 per 10 minutes is too small for it)
create or replace function public.connector_rate_hit(p_token_id uuid, p_max int default 120) returns boolean
 language plpgsql security definer set search_path to 'public' as $$
declare n int; v_max int := p_max;
begin
  if exists (select 1 from claude_connector_tokens where id = p_token_id and label = 'ai-worker') then v_max := greatest(p_max, 600); end if;
  delete from claude_connector_calls where token_id = p_token_id and called_at < now() - interval '1 hour';
  select count(*) into n from claude_connector_calls where token_id = p_token_id and called_at > now() - interval '10 minutes';
  if n >= v_max then return false; end if;
  insert into claude_connector_calls (token_id) values (p_token_id);
  return true;
end $$;
revoke execute on function public.connector_rate_hit(uuid, int) from public, anon, authenticated;
