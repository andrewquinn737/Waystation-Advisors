-- Send rules v2 (Mason, 2026-11-22). Idempotent. Re-defines the engine functions it changes.
--  1. Window 8:30-17:00 weekdays in the LIST OWNER's time zone (profiles.timezone, default America/Denver).
--  2. Cap: min(20, daily_send_limit) emails per MAILBOX per local day, first emails + follow-ups together (follow-ups first).
--  3. Random 4-9 min spacing between consecutive sends FROM THE SAME MAILBOX; one queued send per mailbox per run.
--  4. No auto call sequence: leads without a personal email are 'backup' numbers (no tasks, no schedule).
--  5. start_emails(list, n, ids) starts the next N ready leads; approve_list_copy is a wrapper.
--  6. Address verification (MillionVerifier via edge functions) before the first email; result on dials.
--  7. Cross-batch copy uniqueness: sent_sentence_index (team sends, 180 days) + lead_copy_hashes (other active/ready leads).
--  8. my_followups view; email_queue_status().
set check_function_bodies = off;

-- ---------------------------------------------------------------- time zones
create or replace function public.person_tz(p_profile uuid) returns text
 language plpgsql stable security definer set search_path to 'public' as $$
declare v text;
begin
  select timezone into v from profiles where id = p_profile;
  if v is null or btrim(v) = '' then return 'America/Denver'; end if;
  perform now() at time zone v;            -- raises on an unknown zone
  return v;
exception when others then return 'America/Denver';
end $$;
create or replace function public.person_today(p_profile uuid, p_now timestamptz default now()) returns date
 language sql stable security definer set search_path to 'public' as $$
  select (p_now at time zone person_tz(p_profile))::date $$;

-- ---------------------------------------------------------------- columns / tables
alter table public.dials add column if not exists mv_result text, add column if not exists mv_checked_at timestamptz;

-- call3 is retired: those leads become backup numbers (no tasks, no schedule)
alter table public.dials drop constraint if exists dials_sequence_check;
delete from public.sequence_tasks where dial_id in (select id from public.dials where sequence = 'call3');
update public.dials set sequence = 'backup', seq_state = null, seq_day0 = null where sequence = 'call3';
alter table public.dials add constraint dials_sequence_check check (sequence is null or sequence in ('email5','backup'));

-- MillionVerifier result cache (30 days). Service role only.
create table if not exists public.email_verifications (
  email text primary key,
  result text not null,
  checked_at timestamptz not null default now(),
  source text not null default 'millionverifier'
);
alter table public.email_verifications enable row level security;
revoke all on public.email_verifications from anon, authenticated;

create table if not exists public.sent_sentence_index (
  hash text primary key,
  first_seen timestamptz not null
);
alter table public.sent_sentence_index enable row level security;
revoke all on public.sent_sentence_index from anon, authenticated;
create index if not exists sent_sentence_index_seen_idx on public.sent_sentence_index (first_seen);

create table if not exists public.lead_copy_hashes (
  dial_id uuid not null references public.dials(id) on delete cascade,
  list_id uuid not null references public.dial_lists(id) on delete cascade,
  hash text not null,
  primary key (dial_id, hash)
);
create index if not exists lead_copy_hashes_hash_idx on public.lead_copy_hashes (hash);
alter table public.lead_copy_hashes enable row level security;
revoke all on public.lead_copy_hashes from anon, authenticated;

-- ---------------------------------------------------------------- sentence normalizer (parity with js/copyLint.js)
-- copyLint.js: splitEmail (greeting / sign-off stripped) -> body.split(/(?<=[.!?])\s+|\n+/) -> normSentence -> >= 5 words
create or replace function public.copy_norm_sentence(s text) returns text language sql immutable as $$
  select btrim(regexp_replace(
           regexp_replace(lower(regexp_replace(normalize(coalesce(s,''), NFD), '[̀-ͯ]', '', 'g')),
                          '[^[:alnum:][:space:]'']', ' ', 'g'),
           '\s+', ' ', 'g'))
$$;
create or replace function public.copy_email_body(t text) returns text language plpgsql immutable as $$
declare lines text[]; n int; st int := 1; en int; i int;
begin
  lines := string_to_array(regexp_replace(coalesce(t,''), E'\r\n?', E'\n', 'g'), E'\n');
  n := coalesce(array_length(lines, 1), 0);
  if n = 0 then return ''; end if;
  while st <= n and regexp_replace(lines[st], '^\s+|\s+$', '', 'g') = '' loop st := st + 1; end loop;
  if st <= n and regexp_replace(lines[st], '^\s+|\s+$', '', 'g') ~* '^(hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\y[^.!?\n]{0,60}$' then
    st := st + 1;
  end if;
  en := n + 1;
  i := n;
  while i >= st and i >= n - 5 loop
    if regexp_replace(lines[i], '^\s+|\s+$', '', 'g') ~* '^(best|best regards|kind regards|warm regards|regards|thanks|thank you|many thanks|cheers|sincerely|respectfully|talk soon|all the best|take care|appreciate it|thanks again)\s*[,.!]?$' then
      en := i; exit;
    end if;
    i := i - 1;
  end loop;
  if en - 1 < st then return ''; end if;
  return regexp_replace(array_to_string(lines[st:en-1], E'\n'), '^\s+|\s+$', '', 'g');
end $$;
create or replace function public.copy_sentences(t text) returns text[] language sql immutable as $$
  select coalesce(array_agg(s order by ord), '{}'::text[]) from (
    select public.copy_norm_sentence(x) s, ord
      from regexp_split_to_table(public.copy_email_body(t), '(?<=[.!?])\s+|\n+') with ordinality as r(x, ord)) q
   where array_length(string_to_array(s, ' '), 1) >= 5
$$;
create or replace function public.copy_body_norm(t text) returns text language sql immutable as $$
  select public.copy_norm_sentence(public.copy_email_body(t)) $$;
create or replace function public.copy_body_hash(norm text) returns text language sql immutable as $$
  select md5('B' || chr(30) || norm) $$;

-- every outbound email (sent by anyone on the team, any path) feeds the index
create or replace function public.index_outbound_message() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare v_seen timestamptz := coalesce(new.sent_at, new.created_at, now()); v_norm text;
begin
  if new.direction is distinct from 'outbound' or coalesce(new.body_text,'') = '' then return new; end if;
  insert into sent_sentence_index (hash, first_seen)
  select md5(s), v_seen from unnest(copy_sentences(new.body_text)) s
  on conflict (hash) do update set first_seen = least(sent_sentence_index.first_seen, excluded.first_seen);
  v_norm := copy_body_norm(new.body_text);
  if v_norm <> '' then
    insert into sent_sentence_index (hash, first_seen) values (copy_body_hash(v_norm), v_seen)
    on conflict (hash) do update set first_seen = least(sent_sentence_index.first_seen, excluded.first_seen);
  end if;
  return new;
end $$;
drop trigger if exists index_outbound_message on public.email_messages;
create trigger index_outbound_message after insert on public.email_messages
  for each row execute function public.index_outbound_message();
-- backfill history (idempotent)
insert into public.sent_sentence_index (hash, first_seen)
select md5(s), min(coalesce(m.sent_at, m.created_at)) from public.email_messages m, unnest(public.copy_sentences(m.body_text)) s
 where m.direction = 'outbound' and coalesce(m.body_text,'') <> '' group by 1
on conflict (hash) do update set first_seen = least(public.sent_sentence_index.first_seen, excluded.first_seen);
insert into public.sent_sentence_index (hash, first_seen)
select public.copy_body_hash(public.copy_body_norm(m.body_text)), min(coalesce(m.sent_at, m.created_at)) from public.email_messages m
 where m.direction = 'outbound' and public.copy_body_norm(m.body_text) <> '' group by 1
on conflict (hash) do update set first_seen = least(public.sent_sentence_index.first_seen, excluded.first_seen);

-- Candidate texts (normalized sentences / normalized follow-up bodies) -> where they were used before.
create or replace function public.copy_uniqueness_hits(p_list_id uuid, p_sentences text[], p_bodies text[])
 returns table(kind text, txt text, src text, first_seen timestamptz, list_name text)
 language sql stable security definer set search_path to 'public' as $$
  with c as (select t, 's'::text k, md5(t) h from unnest(coalesce(p_sentences,'{}')) t
             union select t, 'b', copy_body_hash(t) from unnest(coalesce(p_bodies,'{}')) t)
  select c.k, c.t, 'sent'::text, i.first_seen, null::text
    from c join sent_sentence_index i on i.hash = c.h where i.first_seen > now() - interval '180 days'
  union all
  select * from (
    select distinct on (c.k, c.t) c.k, c.t, 'lead'::text, d.created_at, dl.name
      from c join lead_copy_hashes x on x.hash = c.h
      join dials d on d.id = x.dial_id join dial_lists dl on dl.id = d.list_id
     where x.list_id <> p_list_id and dl.deleted_at is null and d.seq_state in ('awaiting_copy','active') and d.copy_ok
     order by c.k, c.t) l
$$;
create or replace function public.copy_gate_rows2(p_list_id uuid)
 returns table(id uuid, full_name text, company_name text, email_subject text, email_1 text, email_2 text, hash text,
               email_1_sent boolean, followup_sent boolean)
 language sql stable security definer set search_path to 'public' as $$
  select d.id, d.full_name, d.company_name, d.email_subject, d.email_1, d.email_2,
         copy_text_hash(d.email_subject, d.email_1, d.email_2),
         d.email_1_message_id is not null,
         exists (select 1 from sequence_tasks t where t.dial_id = d.id and t.kind = 'followup_email' and t.status in ('queued','done'))
    from dials d where d.list_id = p_list_id and d.sequence = 'email5'
$$;

-- ---------------------------------------------------------------- copy guard: mv fields are system-managed too
create or replace function public.dials_copy_guard() returns trigger
 language plpgsql as $$
declare v_client boolean := current_user in ('authenticated', 'anon');
begin
  if v_client and (new.copy_ok is distinct from old.copy_ok or new.copy_hash is distinct from old.copy_hash
       or new.copy_errors is distinct from old.copy_errors or new.copy_checked_at is distinct from old.copy_checked_at
       or new.sequence is distinct from old.sequence or new.seq_state is distinct from old.seq_state
       or new.seq_day0 is distinct from old.seq_day0 or new.sender_account_id is distinct from old.sender_account_id
       or new.email_1_message_id is distinct from old.email_1_message_id or new.email_1_thread_id is distinct from old.email_1_thread_id
       or new.mv_result is distinct from old.mv_result or new.mv_checked_at is distinct from old.mv_checked_at) then
    raise exception 'Sequence and copy-check fields are managed by the system';
  end if;
  if new.email is distinct from old.email then new.mv_result := null; new.mv_checked_at := null; end if;  -- new address, new check
  if new.email_subject is distinct from old.email_subject or new.email_1 is distinct from old.email_1
     or new.email_2 is distinct from old.email_2 or new.full_name is distinct from old.full_name
     or new.company_name is distinct from old.company_name then
    new.copy_ok := false; new.copy_hash := null;
    if old.email_1_message_id is not null and (new.email_subject is distinct from old.email_subject or new.email_1 is distinct from old.email_1) then
      raise exception 'The first email was already sent; only the follow-up can still be edited';
    end if;
  end if;
  return new;
end $$;
create or replace function public.dials_copy_insert() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') then
    new.copy_ok := false; new.copy_hash := null; new.copy_errors := null; new.copy_checked_at := null;
    new.sequence := null; new.seq_state := null; new.seq_day0 := null; new.sender_account_id := null;
    new.email_1_message_id := null; new.email_1_thread_id := null; new.mv_result := null; new.mv_checked_at := null;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- steps + tasks
create or replace function public.seq_steps(p_sequence text)
 returns table(step int, seq_day int, kind text) language sql immutable as $$
  select v.step, v.seq_day, v.kind from (values
    ('email5',1,1,'email'), ('email5',2,3,'call'), ('email5',3,3,'followup_email'),
    ('email5',4,4,'linkedin'), ('email5',5,5,'call'), ('email5',6,7,'call_company')
  ) v(seq, step, seq_day, kind) where v.seq = p_sequence
$$;

-- Day 1 = the day the first email actually sends: until then only the email step exists.
create or replace function public.seq_build_tasks(p_dial_id uuid) returns void
 language plpgsql security definer set search_path to 'public' as $$
declare d record; s record;
begin
  select id, list_id, created_by, sequence, seq_day0, email_1_message_id into d from dials where id = p_dial_id;
  if d.sequence is null or d.seq_day0 is null then return; end if;
  for s in select * from seq_steps(d.sequence) loop
    continue when d.sequence = 'email5' and d.email_1_message_id is null and s.step > 1;
    insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on)
    values (d.id, d.list_id, d.created_by, s.step, s.seq_day, s.kind, seq_due(d.seq_day0, s.seq_day))
    on conflict (dial_id, step) do update
      set due_on = excluded.due_on, owner_id = excluded.owner_id
      where sequence_tasks.status = 'pending';
  end loop;
end $$;

-- personal email -> email5 (awaiting copy / start); everything else -> backup number (no tasks)
create or replace function public.seq_prepare_list(p_list_id uuid) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid; n_email int := 0; n_backup int := 0; n_nocopy int := 0; r record;
begin
  select created_by into v_owner from dial_lists where id = p_list_id;
  if v_owner is null then raise exception 'List not found'; end if;
  if auth.uid() is not null and not (auth.uid() = v_owner or is_admin() or is_team_lead_of(v_owner)) then
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

-- ---------------------------------------------------------------- mailbox capacity helpers
create or replace function public.mailbox_day_cap(p_account uuid) returns int
 language sql stable security definer set search_path to 'public' as $$
  select least(20, coalesce((select a.daily_send_limit from email_accounts a where a.id = p_account), public.mailbox_daily_limit())) $$;
-- sent + queued for the mailbox's local day (owner's zone)
create or replace function public.mailbox_used_today(p_account uuid, p_now timestamptz default now()) returns int
 language sql stable security definer set search_path to 'public' as $$
  with a as (select owner_id, person_tz(owner_id) tz from email_accounts where id = p_account)
  select ((select count(*) from email_messages m, a where m.account_id = p_account and m.direction = 'outbound'
             and (m.sent_at at time zone a.tz)::date = (p_now at time zone a.tz)::date)
        + (select count(*) from scheduled_emails s, a where s.account_id = p_account and s.status in ('pending','sending')
             and (s.send_at at time zone a.tz)::date = (p_now at time zone a.tz)::date))::int $$;
create or replace function public.mailbox_last_send(p_account uuid) returns timestamptz
 language sql stable security definer set search_path to 'public' as $$
  select greatest((select max(send_at) from scheduled_emails where account_id = p_account and status in ('pending','sending','sent')),
                  (select max(sent_at) from email_messages where account_id = p_account and direction = 'outbound')) $$;

create or replace function public.owner_eligible_mailboxes(p_owner uuid, p_mandate text) returns setof uuid
 language sql stable security definer set search_path to 'public' as $$
  select a.id from email_accounts a
   where a.owner_id = p_owner and not a.needs_assignment and coalesce(a.send_paused_reason,'') = ''
     and (p_mandate is null or a.mandate is null or a.mandate = p_mandate) $$;

-- ---------------------------------------------------------------- start_emails
create or replace function public.start_candidates(p_list_id uuid, p_limit int default null, p_skip uuid[] default '{}')
 returns table(id uuid, email text, mv_result text, mv_checked_at timestamptz)
 language sql stable security definer set search_path to 'public' as $$
  select d.id, d.email, d.mv_result, d.mv_checked_at from dials d
   where d.list_id = p_list_id and d.sequence = 'email5' and d.seq_state = 'awaiting_copy'
     and d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)
     and not (d.id = any (coalesce(p_skip, '{}')))
   order by d.created_at, d.id limit p_limit $$;
revoke execute on function public.start_candidates(uuid, int, uuid[]) from public, anon, authenticated;

create or replace function public.start_emails(p_list_id uuid, p_count int default null, p_dial_ids uuid[] default null) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v_list record; r record; v_day0 date; v_tz text; v_started int := 0; v_backup int := 0; v_unver int := 0;
  v_held int; v_ready int; v_cap int := 0; v_left int := 0; v_firsts int; v_day_cap int := 0; v_now timestamptz := now(); b uuid;
begin
  select * into v_list from dial_lists where id = p_list_id and deleted_at is null;
  if v_list is null then raise exception 'List not found'; end if;
  if auth.uid() is not null and not (auth.uid() = v_list.created_by or is_admin() or is_team_lead_of(v_list.created_by)) then
    raise exception 'Only the list owner, their team lead, or an admin can start this list';
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
    if r.mv_checked_at is null or r.mv_checked_at < v_now - interval '30 days' or r.mv_result is null then
      v_unver := v_unver + 1;                       -- not verified: stays ready (the app verifies before calling us)
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
    v_day_cap := v_day_cap + mailbox_day_cap(b);
    v_cap := v_cap + greatest(0, mailbox_day_cap(b) - mailbox_used_today(b, v_now));
  end loop;
  select count(*) into v_firsts from sequence_tasks where owner_id = v_list.created_by and kind = 'email' and status = 'pending';
  return jsonb_build_object('started', v_started, 'held_for_copy', v_held, 'moved_to_backup', v_backup,
    'needs_verification', v_unver, 'remaining_ready', v_ready, 'today_capacity', v_cap,
    'est_days_to_send_firsts', case when v_day_cap > 0 then ceil(v_firsts::numeric / v_day_cap)::int end,
    'first_send_day', v_day0);
end $$;
create or replace function public.approve_list_copy(p_list_id uuid) returns jsonb
 language sql security definer set search_path to 'public' as $$ select public.start_emails(p_list_id, null, null) $$;

-- ---------------------------------------------------------------- status + views
create or replace function public.email_queue_status(p_owner uuid default auth.uid()) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_now timestamptz := now(); v_tz text; v_boxes jsonb; v_lists jsonb; v_next timestamptz; v_sent int; v_cap int; v_rem int;
begin
  if p_owner is null then raise exception 'Sign in first'; end if;
  if auth.uid() is not null and not (auth.uid() = p_owner or is_admin() or is_team_lead_of(p_owner)) then
    raise exception 'No access to that person';
  end if;
  v_tz := person_tz(p_owner);
  select coalesce(jsonb_agg(jsonb_build_object('address', a.email_address, 'cap', mailbox_day_cap(a.id),
           'used', mailbox_used_today(a.id, v_now)) order by a.email_address), '[]'),
         coalesce(sum(mailbox_day_cap(a.id)), 0), coalesce(sum(greatest(0, mailbox_day_cap(a.id) - mailbox_used_today(a.id, v_now))), 0)
    into v_boxes, v_cap, v_rem
    from email_accounts a where a.owner_id = p_owner and not a.needs_assignment and coalesce(a.send_paused_reason,'') = '';
  select count(*) into v_sent from email_messages m join email_accounts a on a.id = m.account_id
   where a.owner_id = p_owner and m.direction = 'outbound' and (m.sent_at at time zone v_tz)::date = (v_now at time zone v_tz)::date;
  select min(s.send_at) into v_next from scheduled_emails s join email_accounts a on a.id = s.account_id
   where a.owner_id = p_owner and s.status = 'pending' and s.send_at >= v_now;
  select coalesce(jsonb_agg(x order by x->>'name'), '[]') into v_lists from (
    select jsonb_build_object('list_id', l.id, 'name', l.name,
      'ready_not_started', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok
                              and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
      'active', count(*) filter (where d.seq_state = 'active'),
      'replied', count(*) filter (where d.seq_state = 'replied'),
      'bounced', count(*) filter (where d.seq_state = 'bounced'),
      'backup', count(*) filter (where d.sequence = 'backup')) x
      from dial_lists l join dials d on d.list_id = l.id
     where l.created_by = p_owner and l.deleted_at is null group by l.id, l.name) q;
  return jsonb_build_object('timezone', v_tz, 'sent_today', v_sent, 'capacity_today', v_cap, 'remaining_today', v_rem,
                            'next_send_at', v_next, 'mailboxes', v_boxes, 'lists', v_lists);
end $$;

create or replace view public.my_followups with (security_invoker = true) as
  select t.*, case when t.kind = 'reply' then 0 when t.due_on < person_today(t.owner_id) then 1 else 2 end as urgency
    from public.my_tasks t
   where t.kind in ('call','linkedin','call_company','reply') and t.status in ('pending','failed')
     and t.due_on <= person_today(t.owner_id)
   order by (case when t.kind = 'reply' then 0 when t.due_on < person_today(t.owner_id) then 1 else 2 end), t.due_on, t.step;
revoke all on public.my_followups from anon, authenticated;
grant select on public.my_followups to authenticated;

-- ---------------------------------------------------------------- copy gate record (no auto-start; stores uniqueness hashes)
create or replace function public.copy_gate_record(p_list_id uuid, p_results jsonb) returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare r jsonb; n_ok int := 0; n_bad int := 0; v_id uuid;
begin
  for r in select * from jsonb_array_elements(p_results) loop
    v_id := (r->>'id')::uuid;
    update dials set copy_ok = (r->>'ok')::boolean, copy_errors = r->'errors', copy_warnings = r->'warnings',
                     copy_hash = r->>'hash', copy_checked_at = now()
     where id = v_id and list_id = p_list_id and copy_text_hash(email_subject, email_1, email_2) = r->>'hash';
    if found then
      delete from lead_copy_hashes where dial_id = v_id;
      if (r->>'ok')::boolean then
        insert into lead_copy_hashes (dial_id, list_id, hash)
        select v_id, p_list_id, md5(s) from (select distinct jsonb_array_elements_text(coalesce(r->'s1', '[]')) s) q
        on conflict do nothing;
        if coalesce(r->>'fu', '') <> '' then
          insert into lead_copy_hashes (dial_id, list_id, hash) values (v_id, p_list_id, copy_body_hash(r->>'fu')) on conflict do nothing;
        end if;
      end if;
    end if;
    if (r->>'ok')::boolean then n_ok := n_ok + 1; else n_bad := n_bad + 1; end if;
  end loop;
  return jsonb_build_object('passed', n_ok, 'held', n_bad, 'started_now', 0);
end $$;
revoke execute on function public.copy_gate_record(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- dispatcher
drop function if exists public.sequence_dispatch(timestamptz);
-- Per mailbox, per run: queue at most ONE due email step (follow-ups first) if
--   * it is a weekday 8:30-17:00 in the list owner's zone,
--   * the mailbox has sent+queued fewer than min(20, daily_send_limit) today (and room in its rolling 24h limit),
--   * the mailbox has nothing queued more than 15 min ahead,
--   * the new send_at (4-9 min after the mailbox's previous send, or 4-9 min from now when idle) is still before 17:00.
create or replace function public.sequence_dispatch(p_now timestamptz default now()) returns int
 language plpgsql security definer set search_path to 'public' as $$
declare m record; t record; n int := 0; v_tz text; v_local timestamp; v_today date; v_last timestamptz; v_at timestamptz;
  v_r double precision; v_subject text; v_body text; v_sid uuid;
begin
  for m in
    select a.id, a.owner_id, a.mandate, person_tz(a.owner_id) tz, mailbox_day_cap(a.id) cap, c.sent + c.scheduled as used, c.daily_limit,
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
    continue when mailbox_used_today(m.id, p_now) >= m.cap;
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
       and d.copy_ok and d.copy_hash = md5(coalesce(d.email_subject,'') || chr(30) || coalesce(d.email_1,'') || chr(30) || coalesce(d.email_2,''))
       and (l.mandate is null or m.mandate is null or l.mandate = m.mandate)
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

-- ---------------------------------------------------------------- zone-aware triggers
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
  elsif new.status = 'failed' then
    if coalesce(new.error,'') ~* 'daily limit' then
      update sequence_tasks set status = 'pending', scheduled_email_id = null, last_error = new.error where id = t.id;
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

create or replace function public.email_inbound_seq_check() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare d record; v_from text := lower(coalesce(new.from_address,''));
begin
  if new.direction is distinct from 'inbound' then return new; end if;
  if v_from ~ '^(mailer-daemon|postmaster|mail-daemon)@' or coalesce(new.subject,'') ~* '(undeliver|delivery status notification|delivery has failed|returned mail|failure notice)' then
    for d in select id from dials where seq_state = 'active' and email is not null
               and position(lower(email) in lower(coalesce(new.body_text,'') || ' ' || coalesce(new.subject,''))) > 0
               and sender_account_id = new.account_id loop
      perform seq_stop(d.id, 'bounced', 'Email bounced', false);
    end loop;
    return new;
  end if;
  for d in select id, created_by, list_id from dials where lower(email) = v_from and seq_state = 'active' loop
    perform seq_stop(d.id, 'replied', 'Owner replied by email', false);
    insert into sequence_tasks (dial_id, list_id, owner_id, step, seq_day, kind, due_on)
    values (d.id, d.list_id, d.created_by, 100, 0, 'reply', person_today(d.created_by))
    on conflict (dial_id, step) do nothing;
  end loop;
  return new;
end $$;

-- ---------------------------------------------------------------- grants
grant execute on function public.seq_prepare_list(uuid), public.approve_list_copy(uuid),
  public.start_emails(uuid, int, uuid[]), public.email_queue_status(uuid) to authenticated;
revoke execute on function public.copy_uniqueness_hits(uuid, text[], text[]), public.copy_gate_rows2(uuid),
  public.sequence_dispatch(timestamptz), public.mailbox_used_today(uuid, timestamptz), public.mailbox_last_send(uuid),
  public.owner_eligible_mailboxes(uuid, text), public.mailbox_day_cap(uuid), public.person_tz(uuid),
  public.person_today(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.person_today(uuid, timestamptz), public.person_tz(uuid) to authenticated;  -- my_followups needs it
grant select (mv_result, mv_checked_at) on public.dials to authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'sequence-dispatch';
select cron.schedule('sequence-dispatch', '* * * * *', 'select public.sequence_dispatch()');
