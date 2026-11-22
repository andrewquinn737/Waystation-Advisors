-- Inbox noise: delivery-failure messages and automated system notices are flagged server-side (email_messages.is_system)
-- and hidden from the normal Inbox + unread counts. They stay in the table (bounce detection still runs on them) and are
-- shown under the gear menu as "Bounces". Warm-up mail (subject token BPMPVM7) is already dropped on insert by
-- email_messages_block_warmup_spam, so it never reaches the table.
-- Also: an admin with an active (non-revoked) Claude connector token counts as onboarded.

alter table public.email_messages add column if not exists is_system boolean not null default false;
alter table public.email_messages add column if not exists system_kind text;   -- 'bounce' | 'notice'

create or replace function public.email_system_kind(p_from text, p_subject text) returns text
 language sql immutable set search_path to 'public' as $$
  select case
    when lower(coalesce(p_from,'')) ~ '^(mailer-daemon|postmaster|mail-daemon|microsoftexchange[0-9a-f]*)@' then 'bounce'
    when coalesce(p_subject,'') ~* '(^|\W)(undeliverable|undelivered)(\W|$)|delivery status notification|mail delivery (failed|subsystem)|delivery has failed|returned mail|failure notice|delivery failure|message not delivered|couldn''t be delivered|could not be delivered' then 'bounce'
    when lower(coalesce(p_from,'')) ~ '@([a-z0-9-]+\.)*(microsoft|microsoftonline|office365|office|godaddy|secureserver)\.com$' and lower(coalesce(p_from,'')) ~ '^(o365mc|no-?reply|do-?not-?reply|noreply|donotreply|account-security-noreply|msonlineservicesteam|microsoft-noreply)@' then 'notice'
    else null end $$;

create or replace function public.email_messages_flag_system() returns trigger
 language plpgsql set search_path to 'public' as $$
begin
  if new.direction = 'inbound' then
    new.system_kind := public.email_system_kind(new.from_address, new.subject);
    new.is_system := new.system_kind is not null;
  end if;
  return new;
end $$;
drop trigger if exists email_messages_flag_system on public.email_messages;
create trigger email_messages_flag_system before insert on public.email_messages
  for each row execute function public.email_messages_flag_system();

-- Backfill (inbound only). Other update triggers on this table are insert-only, so this is side-effect free.
update public.email_messages set system_kind = public.email_system_kind(from_address, subject),
       is_system = public.email_system_kind(from_address, subject) is not null
 where direction = 'inbound' and is_system = false and public.email_system_kind(from_address, subject) is not null;

create index if not exists email_messages_visible_idx on public.email_messages (account_id, sent_at desc) where is_system = false;

-- Onboarding: an existing non-revoked connector token = already connected, so the wizard never reappears.
create or replace function public.onboarding_status() returns timestamptz
 language plpgsql volatile security definer set search_path to 'public' as $$
declare v timestamptz;
begin
  select onboarding_done_at into v from profiles where id = auth.uid();
  if v is null and exists (select 1 from claude_connector_tokens where profile_id = auth.uid() and revoked_at is null) then
    update profiles set onboarding_done_at = now() where id = auth.uid() returning onboarding_done_at into v;
  end if;
  return v;
end $$;
grant execute on function public.onboarding_status() to authenticated;
revoke execute on function public.onboarding_status() from anon, public;
