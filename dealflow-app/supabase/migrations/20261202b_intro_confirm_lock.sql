-- Round 2 follow-up: serialize run_intro_confirm_prompts so overlapping runs never send the same confirm prompt twice.
CREATE OR REPLACE FUNCTION public.run_intro_confirm_prompts()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  -- one run at a time: the 15-min cron and a manual call could both prompt the same event (double notification)
  if not pg_try_advisory_xact_lock(hashtext('run_intro_confirm_prompts')) then return; end if;
  for r in
    select e.id, e.details, c.id as client_id, c.full_name, c.created_by
    from client_events e join clients c on c.id = e.client_id
    where e.event_type = 'intro_call' and e.confirmed = false
      and not coalesce((e.details->>'time_pending')::boolean, false)
      and e.event_date < now() - interval '30 minutes' and e.event_date > now() - interval '14 days'
      and coalesce((e.details->>'confirm_prompts')::int, 0) < 3
      and (e.details->>'confirm_prompted_at' is null or (e.details->>'confirm_prompted_at')::timestamptz < now() - interval '23 hours')
  loop
    perform public.notify_user(r.created_by, 'Did your intro call with ' || coalesce(r.full_name, 'your client') || ' happen? Open the client and confirm it.',
                               'intro_confirm', '/clients.html?client=' || r.client_id);
    update client_events set details = coalesce(details, '{}'::jsonb) || jsonb_build_object('confirm_prompts', coalesce((r.details->>'confirm_prompts')::int, 0) + 1, 'confirm_prompted_at', now())
    where id = r.id;
  end loop;
end $function$;
