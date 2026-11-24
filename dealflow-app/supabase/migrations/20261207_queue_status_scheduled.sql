-- Calls email bar: also report how many sends are queued (scheduled_count), so the bar can say "13 scheduled".
CREATE OR REPLACE FUNCTION public.email_queue_status(p_owner uuid DEFAULT auth.uid(), p_mandate text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_now timestamptz := now(); v_tz text; v_lists jsonb; v_next timestamptz; v_sent int; v_sched int; v_cap jsonb;
begin
  if auth.uid() is null or p_owner is null then raise exception 'Sign in first'; end if;
  if not coalesce(auth.uid() = p_owner or is_admin() or is_team_lead_of(p_owner), false) then raise exception 'No access to that person'; end if;
  v_tz := person_tz(p_owner);
  v_cap := owner_send_capacity(p_owner, p_mandate, v_now);
  select count(*) into v_sent from email_messages m join email_accounts a on a.id = m.account_id
   where a.owner_id = p_owner and m.direction = 'outbound' and (m.sent_at at time zone v_tz)::date = (v_now at time zone v_tz)::date
     and (p_mandate is null or a.mandate is null or a.mandate = p_mandate);
  select min(s.send_at), count(*) into v_next, v_sched from scheduled_emails s join email_accounts a on a.id = s.account_id
   where a.owner_id = p_owner and s.status = 'pending' and s.send_at >= v_now and (p_mandate is null or a.mandate is null or a.mandate = p_mandate);
  select coalesce(jsonb_agg(x order by x->>'name'), '[]') into v_lists from (
    select jsonb_build_object('list_id', l.id, 'name', l.name, 'paused', l.send_paused_reason,
      'ready_not_started', count(*) filter (where d.sequence = 'email5' and d.seq_state = 'awaiting_copy' and d.copy_ok
                              and d.copy_hash = copy_text_hash(d.email_subject, d.email_1, d.email_2)),
      'active', count(*) filter (where d.seq_state = 'active'), 'replied', count(*) filter (where d.seq_state = 'replied'),
      'bounced', count(*) filter (where d.seq_state = 'bounced'), 'backup', count(*) filter (where d.sequence = 'backup')) x
      from dial_lists l join dials d on d.list_id = l.id
     where l.created_by = p_owner and l.deleted_at is null group by l.id, l.name, l.send_paused_reason) q;
  return jsonb_build_object('timezone', v_tz, 'sent_today', v_sent, 'capacity_today', (v_cap->>'mailbox_capacity')::int,
                            'remaining_today', (v_cap->>'mailbox_remaining')::int, 'day_capacity', (v_cap->>'day_capacity')::int,
                            'left_today', (v_cap->>'left_today')::int, 'next_send_at', v_next, 'scheduled_count', v_sched,
                            'mailboxes', v_cap->'mailboxes', 'domains', v_cap->'domains', 'lists', v_lists);
end $function$;
