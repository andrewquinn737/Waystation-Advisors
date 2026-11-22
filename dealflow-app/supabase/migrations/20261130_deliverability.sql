-- Deliverability (2026-11-30). Diagnosis: docs/DELIVERABILITY.md.
-- Recipient provider cache + pacing for recipients hosted at Microsoft 365 (the only provider that junked our 57-mailbox test:
-- 17 of 17 junk placements, all SCL 5 / SFV SPM at the recipient tenant, SPF + DKIM + DMARC all pass).
create table if not exists public.recipient_domains (
  domain text primary key, provider text not null, mx text, checked_at timestamptz not null default now());
alter table public.recipient_domains enable row level security;     -- service role only (no policies)
revoke all on public.recipient_domains from anon, authenticated;

create or replace function public.recipient_provider(p_email text) returns text
 language sql stable security definer set search_path to 'public' as $$
  select coalesce((select provider from recipient_domains where domain = lower(split_part(btrim(p_email), '@', 2))), 'unknown') $$;

-- Is it OK to send to p_to from p_account right now? Only Microsoft-hosted recipients are paced:
--   per sender mailbox: at most ms_daily_cap (default 8) per rolling 24h;
--   per sender DOMAIN: at least ms_gap_minutes (default 10) between two sends to Microsoft-hosted recipients.
-- Returns {ok:true} or {ok:false, retry_at, why}. Settings in app_secrets (ms_daily_cap, ms_gap_minutes).
create or replace function public.recipient_pacing(p_account uuid, p_to text, p_now timestamptz default now()) returns jsonb
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_prov text := recipient_provider(p_to); v_cap int; v_gap int; v_n int; v_oldest timestamptz; v_last timestamptz; v_dom text;
begin
  if v_prov <> 'microsoft' then return jsonb_build_object('ok', true, 'provider', v_prov); end if;
  v_cap := coalesce((select nullif(btrim(value), '')::int from app_secrets where key = 'ms_daily_cap'), 8);
  v_gap := coalesce((select nullif(btrim(value), '')::int from app_secrets where key = 'ms_gap_minutes'), 10);
  select lower(split_part(email_address, '@', 2)) into v_dom from email_accounts where id = p_account;
  select count(*), min(m.sent_at) into v_n, v_oldest
    from email_messages m join recipient_domains r on r.domain = lower(split_part(m.to_addresses->0->>'address', '@', 2)) and r.provider = 'microsoft'
   where m.account_id = p_account and m.direction = 'outbound' and m.sent_at > p_now - interval '24 hours';
  if v_n >= v_cap then
    return jsonb_build_object('ok', false, 'provider', v_prov, 'why', 'microsoft daily cap', 'retry_at', v_oldest + interval '24 hours' + interval '1 minute');
  end if;
  select max(m.sent_at) into v_last
    from email_messages m join email_accounts a on a.id = m.account_id and lower(split_part(a.email_address, '@', 2)) = v_dom
         join recipient_domains r on r.domain = lower(split_part(m.to_addresses->0->>'address', '@', 2)) and r.provider = 'microsoft'
   where m.direction = 'outbound' and m.sent_at > p_now - make_interval(mins => v_gap);
  if v_last is not null then
    return jsonb_build_object('ok', false, 'provider', v_prov, 'why', 'microsoft gap', 'retry_at', v_last + make_interval(mins => v_gap) + make_interval(secs => (random() * 120)::int));
  end if;
  return jsonb_build_object('ok', true, 'provider', v_prov);
end $$;
revoke all on function public.recipient_provider(text), public.recipient_pacing(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.recipient_provider(text), public.recipient_pacing(uuid, text, timestamptz) to service_role;

-- keep the auto-sender paused on TEST after applying (tools/testenv/apply_migration.py does this)
