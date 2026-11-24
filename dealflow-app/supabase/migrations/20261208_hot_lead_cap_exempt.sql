-- Emails to a lead who is already warm (callback_interested or intro_call_scheduled)
-- don't count against a mailbox's daily limit, and the limit never blocks them.
-- Mason, 2026-11-23: "sending an email to someone who is callback-interested or intro call
-- should NOT count against the daily limit."

create index if not exists dials_hot_email_idx on public.dials (lower(trim(email)))
  where contact_status in ('callback_interested', 'intro_call_scheduled');

create or replace function public.is_hot_recipient(p_addr text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(trim(p_addr), '') <> '' and exists (
    select 1 from dials d
     where d.contact_status in ('callback_interested', 'intro_call_scheduled')
       and lower(trim(d.email)) = lower(trim(p_addr)))
$$;
revoke all on function public.is_hot_recipient(text) from public, anon, authenticated;
grant execute on function public.is_hot_recipient(text) to service_role;

-- address of the first recipient of a stored message (to_addresses is [{address: ...}])
create or replace function public.msg_first_to(p jsonb) returns text
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p) = 'array' then coalesce(p->0->>'address', p->>0) end
$$;

create or replace function public.mailbox_send_counts(p_account_id uuid)
 returns table(sent integer, scheduled integer, daily_limit integer)
 language sql security definer set search_path to 'public'
as $$
  select
    (select count(*)::int from email_messages m
      where m.account_id = p_account_id and m.direction = 'outbound' and m.sent_at > now() - interval '24 hours'
        and not public.is_hot_recipient(public.msg_first_to(m.to_addresses))),
    (select count(*)::int from scheduled_emails s
      where s.account_id = p_account_id and s.status in ('pending','sending')
        and not public.is_hot_recipient(s.to_address)),
    least(20, coalesce((select a.daily_send_limit from email_accounts a where a.id = p_account_id), public.mailbox_daily_limit()));
$$;

create or replace function public.mailbox_used_today(p_account uuid, p_now timestamp with time zone default now())
 returns integer language sql stable security definer set search_path to 'public'
as $$
  with a as (select owner_id, person_tz(owner_id) tz from email_accounts where id = p_account)
  select ((select count(*) from email_messages m, a where m.account_id = p_account and m.direction = 'outbound'
             and (m.sent_at at time zone a.tz)::date = (p_now at time zone a.tz)::date
             and not public.is_hot_recipient(public.msg_first_to(m.to_addresses)))
        + (select count(*) from scheduled_emails s, a where s.account_id = p_account and s.status in ('pending','sending')
             and (s.send_at at time zone a.tz)::date = (p_now at time zone a.tz)::date
             and not public.is_hot_recipient(s.to_address)))::int
$$;

create or replace function public.enforce_scheduled_email_cap()
 returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare
  c record;
  label text;
begin
  if public.is_hot_recipient(new.to_address) then return new; end if;  -- warm leads never hit the cap
  select * into c from public.mailbox_send_counts(new.account_id);
  if c.sent + c.scheduled + 1 > c.daily_limit then
    select coalesce(email_address, 'this mailbox') into label from email_accounts where id = new.account_id;
    raise exception 'Daily limit reached: % can send at most % emails per 24 hours (% sent, % already scheduled).',
      label, c.daily_limit, c.sent, c.scheduled using errcode = 'P0001';
  end if;
  return new;
end;
$$;
