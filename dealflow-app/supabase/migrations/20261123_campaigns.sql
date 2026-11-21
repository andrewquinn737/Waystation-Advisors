-- Admin campaigns overview: one row per dial list with email-sequence leads, for the Campaigns page.
-- Lists created in the last p_days days (with email-sequence rows), plus older lists still not launched or still sending.
create or replace function public.campaign_overview(p_days int default 7)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not coalesce(is_admin(), false) then raise exception 'Admins only'; end if;
  with agg as (
    select l.id, l.name, l.mandate, l.created_at, l.created_by,
      count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok
                         and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)) as ready,
      count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy'
                         and not (d.copy_ok and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2))) as need_fix,
      count(*) filter (where d.seq_state = 'active') as active,
      count(*) filter (where d.seq_state = 'active' and d.email_1_message_id is null) as sending,
      count(*) filter (where d.email_1_message_id is not null) as sent_first,
      count(*) filter (where d.seq_state = 'replied') as replied,
      count(*) filter (where d.seq_state = 'bounced') as bounced,
      count(*) filter (where d.sequence = 'backup') as backup,
      count(*) filter (where d.sequence = 'email5') as email_rows
    from dial_lists l join dials d on d.list_id = l.id
    where l.deleted_at is null group by l.id
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]') into v_out from (
    select a.id as list_id, a.name, a.mandate, a.created_at, p.full_name as owner,
           a.ready, a.need_fix, a.active, a.sent_first, a.replied, a.bounced, a.backup,
           case when a.sending > 0 then 'sending' when a.ready + a.need_fix > 0 then 'not_launched' else 'done' end as status
      from agg a left join profiles p on p.id = a.created_by
     where a.email_rows > 0
       and (a.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 7), 1))
            or a.sending > 0 or a.ready + a.need_fix > 0)
  ) x;
  return v_out;
end $$;
revoke all on function public.campaign_overview(int) from public, anon;
grant execute on function public.campaign_overview(int) to authenticated;
