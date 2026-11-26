-- One persona per real call per track, so the weekly retrain can upsert.
create unique index if not exists ai_personas_track_call_uq on public.ai_personas (track, source_call_id);
