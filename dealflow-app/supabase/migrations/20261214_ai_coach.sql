-- AI Call Coach: knowledge base, real-prospect persona bank, per-call feedback, per-intern coach state, practice calls,
-- a job queue for the coach worker on the Oracle VM (subscription `claude -p`, no API key), and weekly retrain runs.
-- Two tracks: 'data' (Working Signal data sales) and 'ma' (Waystation M&A). Interns read their own rows; team leads
-- read their team; admins read all. All writes go through RPCs (20261214b_ai_coach_rpc.sql) or the service-role worker.
-- Idempotent.
set check_function_bodies = off;

create table if not exists public.ai_kb_docs (
  id uuid primary key default gen_random_uuid(),
  track text not null check (track in ('data', 'ma', 'shared')),
  slug text not null,
  title text not null,
  body text not null,
  kind text not null default 'deep' check (kind in ('router', 'deep', 'calls_playbook', 'research', 'prompt', 'guide')),
  weight numeric not null default 1,      -- calls_playbook 3, router 2, research 0.5: the worker orders context by weight
  version int not null default 1,
  updated_at timestamptz not null default now(),
  unique (track, slug)
);

create table if not exists public.ai_personas (
  id uuid primary key default gen_random_uuid(),
  track text not null check (track in ('data', 'ma')),
  source_call_id uuid,                     -- the real call this prospect was modeled on (LIVE id; no FK on purpose)
  label text not null,                     -- e.g. "Skeptical fab-shop owner, asks who's buying"
  persona jsonb not null,                  -- role, tone, talk_style, signature_phrases, company, industry, real lines
  first_reaction text not null,            -- hostile | brush_off | busy | curious | engaged
  objection_types text[] not null default '{}',
  outcome text,                            -- what the real call ended in
  weight numeric not null default 1,
  active boolean not null default true,
  version int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists ai_personas_track_idx on public.ai_personas (track, active);

create table if not exists public.ai_call_feedback (
  call_id uuid primary key references public.calls(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  track text not null check (track in ('data', 'ma')),
  opener_score int check (opener_score between 0 and 10),
  objection_score int check (objection_score between 0 and 10),
  overall_score int check (overall_score between 0 and 10),
  feedback text not null,                  -- what the intern sees: 2 keeps, 2 fixes, 1 line to try next time
  analysis jsonb not null default '{}'::jsonb,  -- opener quote, reaction, objections [{type, quote, response, handled}]
  created_at timestamptz not null default now()
);
create index if not exists ai_call_feedback_user_idx on public.ai_call_feedback (user_id, created_at desc);

create table if not exists public.ai_coach_state (
  user_id uuid not null references public.profiles(id) on delete cascade,
  track text not null check (track in ('data', 'ma')),
  stage text not null default 'opener' check (stage in ('opener', 'objections', 'full')),
  advice text,                             -- the coach's current plan for this intern (refreshed every 10 conversations)
  advice_at timestamptz,
  conv_count int not null default 0,       -- real conversations with feedback
  convos_at_advice int not null default 0,
  opener_pass_streak int not null default 0,     -- practice calls in a row where the opener passed
  objection_pass_streak int not null default 0,
  objection_focus text[] not null default '{}',  -- weakest objection types, from real calls + practice
  stats jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, track)
);

create table if not exists public.ai_practice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  track text not null check (track in ('data', 'ma')),
  stage text not null check (stage in ('opener', 'objections', 'full')),
  persona_id uuid references public.ai_personas(id) on delete set null,
  persona jsonb not null,                  -- snapshot, so a retrain never changes a session mid-call
  rules text not null,                     -- stage rules the prospect plays by
  turns jsonb not null default '[]'::jsonb,   -- [{role: 'intern'|'prospect', text, at}]
  status text not null default 'active' check (status in ('active', 'scoring', 'done', 'abandoned')),
  channel text not null default 'crm' check (channel in ('crm', 'connector')),
  hung_up boolean not null default false,
  result jsonb,                            -- {opener_pass, objections_pass, score, feedback}
  claude_session_id text,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists ai_practice_user_idx on public.ai_practice_sessions (user_id, created_at desc);

create table if not exists public.ai_coach_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('call_feedback', 'coach_update', 'practice_turn', 'practice_score', 'weekly_retrain')),
  user_id uuid references public.profiles(id) on delete cascade,
  call_id uuid references public.calls(id) on delete cascade,
  session_id uuid references public.ai_practice_sessions(id) on delete cascade,
  track text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  priority int not null default 5,         -- practice_turn 1 (someone is waiting), feedback 5, retrain 9
  attempts int not null default 0,
  error text,
  result jsonb,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  done_at timestamptz
);
create index if not exists ai_coach_jobs_q on public.ai_coach_jobs (status, priority, created_at);
create unique index if not exists ai_coach_jobs_one_feedback on public.ai_coach_jobs (call_id) where kind = 'call_feedback';

create table if not exists public.ai_training_runs (
  id uuid primary key default gen_random_uuid(),
  track text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb,   -- calls used, weights, personas refreshed, judge accuracy
  notes text
);

-- ---------------------------------------------------------------- RLS
alter table public.ai_kb_docs enable row level security;
alter table public.ai_personas enable row level security;
alter table public.ai_call_feedback enable row level security;
alter table public.ai_coach_state enable row level security;
alter table public.ai_practice_sessions enable row level security;
alter table public.ai_coach_jobs enable row level security;
alter table public.ai_training_runs enable row level security;
revoke all on public.ai_kb_docs, public.ai_personas, public.ai_call_feedback, public.ai_coach_state,
  public.ai_practice_sessions, public.ai_coach_jobs, public.ai_training_runs from anon, authenticated;
grant select on public.ai_kb_docs, public.ai_personas, public.ai_call_feedback, public.ai_coach_state,
  public.ai_practice_sessions, public.ai_training_runs to authenticated;

drop policy if exists ai_kb_read on public.ai_kb_docs;
create policy ai_kb_read on public.ai_kb_docs for select to authenticated using (kind <> 'prompt' or is_admin());
drop policy if exists ai_personas_read on public.ai_personas;
create policy ai_personas_read on public.ai_personas for select to authenticated using (is_admin());
drop policy if exists ai_feedback_read on public.ai_call_feedback;
create policy ai_feedback_read on public.ai_call_feedback for select to authenticated
  using (user_id = auth.uid() or is_admin() or is_team_lead_of(user_id));
drop policy if exists ai_state_read on public.ai_coach_state;
create policy ai_state_read on public.ai_coach_state for select to authenticated
  using (user_id = auth.uid() or is_admin() or is_team_lead_of(user_id));
drop policy if exists ai_practice_read on public.ai_practice_sessions;
create policy ai_practice_read on public.ai_practice_sessions for select to authenticated
  using (user_id = auth.uid() or is_admin() or is_team_lead_of(user_id));
drop policy if exists ai_runs_read on public.ai_training_runs;
create policy ai_runs_read on public.ai_training_runs for select to authenticated using (is_admin());
