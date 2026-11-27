-- AI coach voice practice: the browser plays the owner from pre-recorded real lines (no server per turn), then hands the
-- whole call back here to be scored. Clips + the voice kit live in a private bucket any signed-in user can read.

insert into storage.buckets (id, name, public) values ('coach-voice', 'coach-voice', false)
on conflict (id) do nothing;

drop policy if exists "coach-voice read" on storage.objects;
create policy "coach-voice read" on storage.objects for select to authenticated using (bucket_id = 'coach-voice');

-- End a voice practice call with the turns the browser kept (intern + owner lines, in order) and whether the owner hung up.
create or replace function public.ai_practice_end_voice(p_session uuid, p_turns jsonb, p_hung boolean default false)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare t jsonb;
begin
  if p_turns is null or jsonb_typeof(p_turns) <> 'array' or jsonb_array_length(p_turns) > 400 then
    raise exception 'bad turns';
  end if;
  -- keep only the fields the scorer reads; roles are fixed, text is capped
  select coalesce(jsonb_agg(jsonb_build_object('role', case when x->>'role' = 'intern' then 'intern' else 'prospect' end,
                                                'text', left(coalesce(x->>'text', ''), 1200),
                                                'at', coalesce(x->>'at', now()::text),
                                                'source', left(coalesce(x->>'source', ''), 20))), '[]'::jsonb)
    into t from jsonb_array_elements(p_turns) x;
  update ai_practice_sessions set hung_up = coalesce(p_hung, false)
   where id = p_session and user_id = auth.uid() and status = 'active';
  return _ai_practice_end(auth.uid(), p_session, t);
end $$;

revoke all on function public.ai_practice_end_voice(uuid, jsonb, boolean) from public, anon;
grant execute on function public.ai_practice_end_voice(uuid, jsonb, boolean) to authenticated;

-- Start a voice practice call: the normal start, plus the key to the owner's own real call path in the voice kit.
create or replace function public.ai_practice_start_voice(p_track text, p_stage text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r jsonb;
begin
  r := _ai_practice_start(auth.uid(), p_track, p_stage, 'crm');
  return (r - 'persona' - 'rules') || jsonb_build_object('voice', jsonb_build_object(
    'path_call', r->'persona'->>'path_call', 'first_reaction', r->'persona'->>'first_reaction'));
end $$;
revoke all on function public.ai_practice_start_voice(text, text) from public, anon;
grant execute on function public.ai_practice_start_voice(text, text) to authenticated;
