-- Calling stage (2026-11-22). Replayed on TEST against the copied live data.
-- 1. calls.call_outcome / contact_status_after / call_notes / callback_at were 100% NULL: the outcome lived only on dials + call_status_changes.
--    Triggers on dials now write the category, the call notes and the callback time onto the dial's latest call (<= 12 h old).
-- 2. "Summaries missing 40%": 517 calls were flagged transcribed although nobody answered (no lines ever), 845 had 1-3 lines and the
--    summary function skipped them (<4 lines). Unanswered calls are no longer flagged transcribed; every call with lines gets a summary
--    (call-summary: <3 lines = deterministic note); the catch-up job now looks 14 days back and needs >= 1 line.
-- 3. skip_reason gains not_connected / mic_busy / mic_missing (the client wrote "not_connected 503" and the check constraint rejected it).

alter table public.calls drop constraint if exists calls_skip_reason_check;
alter table public.calls add constraint calls_skip_reason_check check (skip_reason = any (array[
  'all_party_state','area_code_all_party','unknown_state','rtc_failed','mic_denied','stt_failed','no_cell','not_connected','mic_busy','mic_missing']::text[]));

-- (1) link the outcome to the call
create or replace function public.link_call_outcome() returns trigger
language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select c.id into cid from calls c
   where c.dial_id = new.id and c.direction = 'outbound' and c.started_at > now() - interval '12 hours'
     and (auth.uid() is null or c.user_id = auth.uid())
   order by c.started_at desc limit 1;
  if cid is null then return new; end if;
  if tg_argv[0] = 'status' then
    update calls set call_outcome = nullif(new.contact_status, 'uncontacted'), contact_status_after = new.contact_status,
                     call_notes = coalesce(new.call_notes, call_notes), callback_at = coalesce(new.callback_at, callback_at)
     where id = cid;
  else
    update calls set call_notes = new.call_notes, callback_at = coalesce(new.callback_at, callback_at) where id = cid;
  end if;
  return new;
end $$;
drop trigger if exists dials_link_call_outcome on public.dials;
create trigger dials_link_call_outcome after update of contact_status on public.dials
  for each row execute function public.link_call_outcome('status');
drop trigger if exists dials_link_call_notes on public.dials;
create trigger dials_link_call_notes after update of call_notes, callback_at on public.dials
  for each row when (old.call_notes is distinct from new.call_notes or old.callback_at is distinct from new.callback_at)
  execute function public.link_call_outcome('notes');

-- backfill: the last call of each dial/user/day takes that day's call_status_changes row (status at call + notes)
with lastc as (
  select distinct on (c.dial_id, c.user_id, (c.started_at at time zone 'America/New_York')::date)
         c.id, c.dial_id, c.user_id, (c.started_at at time zone 'America/New_York')::date d
    from calls c where c.dial_id is not null and c.direction = 'outbound' and c.call_outcome is null
   order by c.dial_id, c.user_id, (c.started_at at time zone 'America/New_York')::date, c.started_at desc),
src as (
  select distinct on (l.id) l.id, s.contact_status_at_call st, s.call_notes n
    from lastc l join call_status_changes s on s.dial_id = l.dial_id and s.user_id = l.user_id
     and (s.changed_at at time zone 'America/New_York')::date = l.d
   order by l.id, s.changed_at desc)
update calls c set call_outcome = nullif(src.st, 'uncontacted'), contact_status_after = src.st, call_notes = nullif(src.n, '')
  from src where c.id = src.id and src.st is not null;

-- (2) clean up flags
update calls c set transcribed = false
 where transcribed and skip_reason is null and coalesce(answered, false) = false
   and not exists (select 1 from call_lines l where l.call_id = c.id);
update calls c set transcribed = false, skip_reason = 'stt_failed'
 where transcribed and skip_reason is null and answered
   and not exists (select 1 from call_lines l where l.call_id = c.id);
-- rows a closed tab left open: end them so the summary job can see them
update calls c set ended_at = coalesce(c.answered_at, c.started_at) + make_interval(secs => coalesce(c.duration_sec, 0))
 where ended_at is null and started_at < now() - interval '3 hours';

-- catch-up job: >= 1 line, 14 days back, 20 per run (keeps the live body's URL/headers: patched in place)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.call_summary_catchup'::regproc);
  d := replace(d, '>= 4', '>= 1');
  d := replace(d, 'now() - interval ''3 hours''', 'now() - interval ''14 days''');
  d := replace(d, 'limit 10', 'limit 20');
  if d not like '%>= 1%' or d not like '%14 days%' then raise exception 'catch-up patch did not apply'; end if;
  execute d;
end $$;
