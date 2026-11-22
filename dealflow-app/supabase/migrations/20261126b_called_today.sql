-- dials.called_today_date was never written, so the weekly survey's "Owners talked to" (profile.js) always read 0.
-- Stamp it whenever the outcome becomes one that means an owner was reached (same four statuses the survey counts).
-- The date is the caller's local day (profiles.timezone, default America/Denver), like the client's todayDateStr().
create or replace function public.dials_set_called_today() returns trigger
language plpgsql security definer set search_path = public as $$
declare tz text;
begin
  if new.contact_status in ('not_interested','callback_interested','busy_callback','intro_call_scheduled')
     and (tg_op = 'INSERT' or new.contact_status is distinct from old.contact_status) then
    select coalesce(nullif(p.timezone,''), 'America/Denver') into tz from profiles p where p.id = auth.uid();
    begin
      new.called_today_date := (now() at time zone coalesce(tz, 'America/Denver'))::date;
    exception when others then
      new.called_today_date := (now() at time zone 'America/Denver')::date;
    end;
  end if;
  return new;
end $$;
drop trigger if exists dials_called_today on public.dials;
create trigger dials_called_today before insert or update of contact_status on public.dials
  for each row execute function public.dials_set_called_today();
revoke execute on function public.dials_set_called_today() from public, anon, authenticated;   -- trigger-only
