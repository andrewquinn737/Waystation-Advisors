-- Campaign stats (Admin > Campaigns): emails sent, companies contacted, replied, interested, intro calls booked, bounced.
-- Adds emails_sent / contacted / interested / intro_calls to admin_campaigns().counts. Interested = callback_interested or a
-- booked intro call (no reply classifier exists yet; add "reply classified positive" here when it does).
-- Idempotent (create or replace).
set check_function_bodies = off;

create or replace function public.admin_campaigns() returns jsonb
 language plpgsql security definer set search_path to 'public' as $$
declare v jsonb;
begin
  if not coalesce(is_admin(), false) then raise exception 'Admins only'; end if;
  perform campaign_refresh(null);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.rank, x.created_at desc), '[]') into v from (
    select c.id, c.list_id, c.name, c.mandate, c.status, c.paused_reason, c.launched_at, c.created_at, p.full_name as owner, l.created_by as owner_id,
           (c.spintax is not null) as has_spintax, coalesce((c.spintax->>'version')::int, 0) as spintax_version, c.variant_stats,
           case c.status when 'ready' then 0 when 'live' then 1 when 'paused' then 2 when 'draft' then 3 else 4 end as rank,
           (select count(*) from owner_eligible_mailboxes(l.created_by, l.mandate)) as mailboxes,
           jsonb_build_object(
             'leads', count(d.id) filter (where d.sequence = 'email5'),
             'ready', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
             'need_fix', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and not (d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2))),
             'active', count(*) filter (where d.seq_state = 'active'),
             'sent_first', count(*) filter (where d.email_1_message_id is not null),
             'replied', count(*) filter (where d.seq_state = 'replied'),
             'bounced', count(*) filter (where d.seq_state = 'bounced'),
             'backup', count(*) filter (where d.sequence = 'backup'),
             'emails_sent', (select count(*) from scheduled_emails s join dials sd on sd.id = s.dial_id where sd.list_id = c.list_id and s.status = 'sent'),
             'contacted', count(*) filter (where d.email_1_message_id is not null or d.seq_state in ('replied','completed')),
             'interested', count(*) filter (where d.sequence = 'email5' and d.contact_status in ('callback_interested','intro_call_scheduled')),
             'intro_calls', count(*) filter (where d.sequence = 'email5' and d.contact_status = 'intro_call_scheduled')) as counts
      from campaigns c join dial_lists l on l.id = c.list_id and l.deleted_at is null
      left join profiles p on p.id = l.created_by left join dials d on d.list_id = l.id
     group by c.id, p.full_name, l.created_by, l.mandate
     limit 200) x;
  return v;
end $$;
revoke all on function public.admin_campaigns() from public, anon;
grant execute on function public.admin_campaigns() to authenticated;
