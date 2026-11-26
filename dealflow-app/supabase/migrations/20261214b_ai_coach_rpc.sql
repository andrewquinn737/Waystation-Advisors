-- AI Call Coach RPCs: track detection, stage logic (deterministic, server-side), practice sessions, worker queue, crons.
-- _ai_* functions take an explicit user and are service-role only (the claude-connector edge fn calls them with the
-- token's profile); the ai_* wrappers use auth.uid() for the CRM page. Idempotent.
set check_function_bodies = off;

-- ---------------------------------------------------------------- track of a call: list mandate, else list-name keywords
create or replace function public.ai_call_track(p_list uuid) returns text language sql stable security definer
set search_path to 'public' as $$
  select coalesce(
    (select case when l.mandate = 'data' then 'data' when l.mandate = 'ma' then 'ma' end from dial_lists l where l.id = p_list),
    (select case when l.name ~* '(data|design_fab|emp_confirmed|arieh|plastics|oilfield_data|signal)' then 'data' else 'ma' end
       from dial_lists l where l.id = p_list),
    'ma');
$$;

-- ---------------------------------------------------------------- stage + focus + coach refresh trigger
-- opener -> objections after 3 passing practice openers in a row OR real-call opener avg >= 7 over the last 5.
-- objections -> full the same way on objection handling. A real-call slide (last-5 opener avg < 5) sends them back.
create or replace function public._ai_coach_recompute(p_user uuid, p_track text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare s ai_coach_state; op numeric; ob numeric; n int; nob int; foc text[]; st text; imm numeric;
begin
  insert into ai_coach_state (user_id, track) values (p_user, p_track) on conflict do nothing;
  select * into s from ai_coach_state where user_id = p_user and track = p_track for update;
  select avg(opener_score), count(*) into op, n from (select opener_score from ai_call_feedback
    where user_id = p_user and track = p_track and opener_score is not null order by created_at desc limit 5) x;
  select avg(objection_score), count(*) into ob, nob from (select objection_score from ai_call_feedback
    where user_id = p_user and track = p_track and objection_score is not null order by created_at desc limit 5) x;
  select avg(case when f.analysis->>'first_reaction' in ('hostile', 'brush_off') then 1 else 0 end) into imm
    from (select analysis from ai_call_feedback where user_id = p_user and track = p_track order by created_at desc limit 10) f;
  select coalesce(array_agg(t order by c desc), '{}') into foc from (
    select o->>'type' t, count(*) c from (select analysis from ai_call_feedback where user_id = p_user and track = p_track
      order by created_at desc limit 20) f, jsonb_array_elements(coalesce(f.analysis->'objections', '[]')) o
     where coalesce((o->>'handled')::boolean, false) = false and o->>'type' is not null group by 1 order by 2 desc limit 3) z;
  if n >= 5 and op < 5 then s.opener_pass_streak := 0; end if;
  st := case when not (s.opener_pass_streak >= 3 or (n >= 5 and op >= 7)) then 'opener'
             when not (s.objection_pass_streak >= 3 or (nob >= 5 and ob >= 7)) then 'objections'
             else 'full' end;
  update ai_coach_state set stage = st, opener_pass_streak = s.opener_pass_streak,
    objection_focus = case when cardinality(foc) > 0 then foc else objection_focus end,
    conv_count = (select count(*) from ai_call_feedback where user_id = p_user and track = p_track),
    stats = jsonb_build_object('opener_avg5', round(op, 1), 'objection_avg5', round(ob, 1), 'immediate_no_rate10', round(imm, 2)),
    updated_at = now()
   where user_id = p_user and track = p_track returning * into s;
  if (s.advice is null and s.conv_count >= 1) or s.conv_count - s.convos_at_advice >= 10 then
    insert into ai_coach_jobs (kind, user_id, track, priority)
    select 'coach_update', p_user, p_track, 4 where not exists (select 1 from ai_coach_jobs
      where kind = 'coach_update' and user_id = p_user and track = p_track and status in ('queued', 'running'));
  end if;
  return to_jsonb(s);
end $$;

-- worker reports a scored practice call; streaks move, stage recomputes
create or replace function public._ai_practice_scored(p_session uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare ps ai_practice_sessions;
begin
  update ai_practice_sessions set status = 'done', result = p_result, ended_at = coalesce(ended_at, now())
   where id = p_session returning * into ps;
  if ps.id is null then return null; end if;
  insert into ai_coach_state (user_id, track) values (ps.user_id, ps.track) on conflict do nothing;
  if p_result ? 'opener_pass' then
    update ai_coach_state set opener_pass_streak = case when (p_result->>'opener_pass')::boolean then opener_pass_streak + 1 else 0 end
     where user_id = ps.user_id and track = ps.track;
  end if;
  if ps.stage <> 'opener' and p_result ? 'objections_pass' and p_result->>'objections_pass' is not null then
    update ai_coach_state set objection_pass_streak = case when (p_result->>'objections_pass')::boolean then objection_pass_streak + 1 else 0 end
     where user_id = ps.user_id and track = ps.track;
  end if;
  return public._ai_coach_recompute(ps.user_id, ps.track);
end $$;

-- ---------------------------------------------------------------- default track for a person: their latest call's list
create or replace function public._ai_default_track(p_user uuid) returns text language sql stable security definer
set search_path to 'public' as $$
  select coalesce((select ai_call_track(c.list_id) from calls c where c.user_id = p_user and c.list_id is not null
                    order by c.started_at desc nulls last limit 1), 'data');
$$;

create or replace function public._ai_overview(p_user uuid, p_track text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare t text := coalesce(p_track, _ai_default_track(p_user));
begin
  insert into ai_coach_state (user_id, track) values (p_user, t) on conflict do nothing;
  return jsonb_build_object(
    'track', t,
    'state', (select to_jsonb(s) from ai_coach_state s where s.user_id = p_user and s.track = t),
    'feedback', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
        select f.call_id, f.opener_score, f.objection_score, f.overall_score, f.feedback, f.analysis, f.created_at,
               c.company_name, c.owner_name, c.duration_sec
          from ai_call_feedback f join calls c on c.id = f.call_id
         where f.user_id = p_user and f.track = t order by f.created_at desc limit 15) x),
    'practice', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]') from (
        select id, stage, status, channel, result, persona->>'label' label, created_at from ai_practice_sessions
         where user_id = p_user and track = t order by created_at desc limit 8) x),
    'connector', exists (select 1 from claude_connector_tokens k where k.profile_id = p_user and k.revoked_at is null
                          and (k.expires_at is null or k.expires_at > now())),
    'connector_used', (select max(last_used_at) from claude_connector_tokens k where k.profile_id = p_user),
    'worker_online', exists (select 1 from ai_workers w where w.id like 'coach%' and w.last_seen > now() - interval '3 minutes'));
end $$;

-- ---------------------------------------------------------------- practice: start (persona picked by stage + weakness)
create or replace function public._ai_practice_start(p_user uuid, p_track text, p_stage text default null, p_channel text default 'crm')
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare s ai_coach_state; st text; p ai_personas; rules text; ses ai_practice_sessions; opening text;
begin
  if p_track not in ('data', 'ma') then raise exception 'track must be data or ma'; end if;
  perform _ai_coach_recompute(p_user, p_track);
  select * into s from ai_coach_state where user_id = p_user and track = p_track;
  st := coalesce(nullif(p_stage, ''), s.stage);
  if st not in ('opener', 'objections', 'full') then raise exception 'bad stage'; end if;
  update ai_practice_sessions set status = 'abandoned', ended_at = now() where user_id = p_user and status = 'active';
  -- weighted random draw (Efraimidis-Spirakis): -ln(u)/w smallest wins
  select * into p from ai_personas x where x.track = p_track and x.active
     and case st when 'opener' then x.first_reaction in ('brush_off', 'hostile', 'busy')
                 when 'objections' then cardinality(x.objection_types) > 0
                   and (cardinality(s.objection_focus) = 0 or x.objection_types && s.objection_focus or random() < 0.25)
                 else true end
   order by -ln(greatest(random(), 1e-9)) / greatest(x.weight, 0.01) limit 1;
  if p.id is null then select * into p from ai_personas x where x.track = p_track and x.active order by random() limit 1; end if;
  if p.id is null then raise exception 'no practice prospects loaded for %', p_track; end if;
  select body into rules from ai_kb_docs where track = 'shared' and slug = 'stage_rules_' || st;
  rules := coalesce(rules, 'Play the prospect exactly as described. Stay in character.');
  opening := coalesce(p.persona->>'answer_line', 'Hello?');
  insert into ai_practice_sessions (user_id, track, stage, persona_id, persona, rules, channel, turns)
  values (p_user, p_track, st, p.id, p.persona || jsonb_build_object('label', p.label, 'first_reaction', p.first_reaction,
          'objection_types', to_jsonb(p.objection_types)), rules, p_channel,
          jsonb_build_array(jsonb_build_object('role', 'prospect', 'text', opening, 'at', now())))
  returning * into ses;
  return jsonb_build_object('session_id', ses.id, 'stage', st, 'track', p_track, 'opening', opening,
    'prospect', jsonb_build_object('name', p.persona->>'name', 'company', p.persona->>'company', 'industry', p.persona->>'industry',
                                   'city', p.persona->>'city'),
    'persona', ses.persona, 'rules', rules, 'focus', to_jsonb(s.objection_focus));
end $$;

create or replace function public._ai_practice_say(p_user uuid, p_session uuid, p_text text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare ps ai_practice_sessions; j uuid;
begin
  select * into ps from ai_practice_sessions where id = p_session and user_id = p_user for update;
  if ps.id is null or ps.status <> 'active' then raise exception 'practice call is not active'; end if;
  if ps.hung_up then raise exception 'the prospect hung up; end the call to get your score'; end if;
  if length(trim(coalesce(p_text, ''))) = 0 then raise exception 'say something'; end if;
  if exists (select 1 from ai_coach_jobs where session_id = p_session and kind = 'practice_turn' and status in ('queued', 'running')) then
    raise exception 'the prospect is still answering';
  end if;
  update ai_practice_sessions set turns = turns || jsonb_build_array(jsonb_build_object('role', 'intern', 'text', left(p_text, 2000), 'at', now()))
   where id = p_session;
  insert into ai_coach_jobs (kind, user_id, session_id, track, priority) values ('practice_turn', p_user, p_session, ps.track, 1)
  returning id into j;
  return jsonb_build_object('job_id', j);
end $$;

create or replace function public._ai_practice_end(p_user uuid, p_session uuid, p_turns jsonb default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare ps ai_practice_sessions;
begin
  select * into ps from ai_practice_sessions where id = p_session and user_id = p_user for update;
  if ps.id is null then raise exception 'practice call not found'; end if;
  if ps.status not in ('active') then return jsonb_build_object('status', ps.status); end if;
  update ai_practice_sessions set status = 'scoring', ended_at = now(),
         turns = case when p_turns is not null and jsonb_typeof(p_turns) = 'array' and jsonb_array_length(p_turns) > 0 then p_turns else turns end
   where id = p_session;
  insert into ai_coach_jobs (kind, user_id, session_id, track, priority) values ('practice_score', p_user, p_session, ps.track, 2);
  return jsonb_build_object('status', 'scoring');
end $$;

create or replace function public._ai_practice_get(p_user uuid, p_session uuid) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object('session', to_jsonb(ps) - 'rules' - 'claude_session_id',
    'pending', exists (select 1 from ai_coach_jobs j where j.session_id = ps.id and j.status in ('queued', 'running')),
    'error', (select j.error from ai_coach_jobs j where j.session_id = ps.id and j.status = 'failed' order by created_at desc limit 1))
  from ai_practice_sessions ps where ps.id = p_session and ps.user_id = p_user;
$$;

-- ---------------------------------------------------------------- CRM wrappers (auth.uid())
create or replace function public.ai_coach_overview(p_track text default null) returns jsonb language sql security definer
set search_path to 'public' as $$ select _ai_overview(auth.uid(), p_track) $$;
create or replace function public.ai_practice_start(p_track text, p_stage text default null) returns jsonb language sql security definer
set search_path to 'public' as $$ select _ai_practice_start(auth.uid(), p_track, p_stage, 'crm') - 'persona' - 'rules' $$;
create or replace function public.ai_practice_say(p_session uuid, p_text text) returns jsonb language sql security definer
set search_path to 'public' as $$ select _ai_practice_say(auth.uid(), p_session, p_text) $$;
create or replace function public.ai_practice_end(p_session uuid) returns jsonb language sql security definer
set search_path to 'public' as $$ select _ai_practice_end(auth.uid(), p_session, null) $$;
create or replace function public.ai_practice_get(p_session uuid) returns jsonb language sql security definer
set search_path to 'public' as $$ select _ai_practice_get(auth.uid(), p_session) $$;

-- ---------------------------------------------------------------- worker queue
create or replace function public.claim_ai_coach_job(p_worker text default 'coach') returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare j ai_coach_jobs;
begin
  insert into ai_workers (id, last_seen, auth_ok) values (p_worker, now(), true)
    on conflict (id) do update set last_seen = now();
  update ai_coach_jobs set status = case when attempts >= 3 then 'failed' else 'queued' end,
         error = coalesce(error, 'worker timed out') where status = 'running' and claimed_at < now() - interval '15 minutes';
  select * into j from ai_coach_jobs x where x.status = 'queued' order by x.priority, x.created_at limit 1 for update skip locked;
  if j.id is null then return null; end if;
  update ai_coach_jobs set status = 'running', attempts = attempts + 1, claimed_at = now() where id = j.id returning * into j;
  return to_jsonb(j);
end $$;

create or replace function public.finish_ai_coach_job(p_id uuid, p_result jsonb default null, p_error text default null) returns void
language sql security definer set search_path to 'public' as $$
  update ai_coach_jobs set status = case when p_error is null then 'done' when attempts >= 3 then 'failed' else 'queued' end,
         result = p_result, error = p_error, done_at = case when p_error is null then now() end where id = p_id;
$$;

-- every 5 min: queue feedback for real conversations (>=3 lines each side) that ended in the last 3 days
create or replace function public.ai_coach_enqueue_feedback() returns int language plpgsql security definer
set search_path to 'public' as $$
declare n int;
begin
  insert into ai_coach_jobs (kind, user_id, call_id, track, priority)
  select 'call_feedback', c.user_id, c.id, ai_call_track(c.list_id), 5 from calls c
   where c.ended_at between now() - interval '3 days' and now() - interval '2 minutes' and c.user_id is not null
     and not exists (select 1 from ai_call_feedback f where f.call_id = c.id)
     and (select count(*) from call_lines l where l.call_id = c.id and l.speaker = 'owner') >= 3
     and (select count(*) from call_lines l where l.call_id = c.id and l.speaker = 'intern') >= 3
  on conflict do nothing;
  get diagnostics n = row_count; return n;
end $$;

revoke execute on function public.ai_call_track(uuid), public._ai_coach_recompute(uuid, text), public._ai_practice_scored(uuid, jsonb),
  public._ai_default_track(uuid), public._ai_overview(uuid, text), public._ai_practice_start(uuid, text, text, text),
  public._ai_practice_say(uuid, uuid, text), public._ai_practice_end(uuid, uuid, jsonb), public._ai_practice_get(uuid, uuid),
  public.claim_ai_coach_job(text), public.finish_ai_coach_job(uuid, jsonb, text), public.ai_coach_enqueue_feedback()
  from public, anon, authenticated;
revoke execute on function public.ai_coach_overview(text), public.ai_practice_start(text, text), public.ai_practice_say(uuid, text),
  public.ai_practice_end(uuid), public.ai_practice_get(uuid) from public, anon;
grant execute on function public.ai_coach_overview(text), public.ai_practice_start(text, text), public.ai_practice_say(uuid, text),
  public.ai_practice_end(uuid), public.ai_practice_get(uuid) to authenticated;

do $$ begin
  perform cron.unschedule(jobname) from cron.job where jobname in ('ai-coach-feedback', 'ai-coach-weekly');
  perform cron.schedule('ai-coach-feedback', '*/5 * * * *', 'select public.ai_coach_enqueue_feedback()');
  perform cron.schedule('ai-coach-weekly', '0 9 * * 1',
    $c$insert into public.ai_coach_jobs (kind, track, priority) values ('weekly_retrain', 'data', 9), ('weekly_retrain', 'ma', 9)$c$);
end $$;
