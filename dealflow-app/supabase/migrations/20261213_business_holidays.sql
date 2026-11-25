-- Company holidays (Mason 2026-11-24: Thanksgiving Thu + Fri are treated like a weekend). Business-day math
-- (is_business_day / next_business_day / seq_due) skips them, so no sequence email sends and no step falls on them.
create table if not exists public.business_holidays (day date primary key, name text not null);
alter table public.business_holidays enable row level security;
drop policy if exists business_holidays_read on public.business_holidays;
create policy business_holidays_read on public.business_holidays for select to authenticated using (true);
insert into public.business_holidays (day, name) values ('2026-11-26', 'Thanksgiving'), ('2026-11-27', 'Day after Thanksgiving')
  on conflict (day) do nothing;

create or replace function public.is_business_day(d date) returns boolean
 language sql stable set search_path to 'public' as $$
  select extract(isodow from d) < 6 and not exists (select 1 from business_holidays h where h.day = d) $$;

create or replace function public.next_business_day(d date) returns date
 language plpgsql stable set search_path to 'public' as $$
declare x date := d;
begin
  while not public.is_business_day(x) loop x := x + 1; end loop;
  return x;
end $$;

create or replace function public.seq_due(day0 date, n integer) returns date
 language plpgsql stable set search_path to 'public' as $$
declare d date := public.next_business_day(day0); k int := 1;
begin
  while k < n loop d := d + 1; if public.is_business_day(d) then k := k + 1; end if; end loop;
  return d;
end $$;

-- Re-date pending work that now lands on a holiday.
do $$ declare r record; begin
  for r in select distinct d.id from dials d join sequence_tasks st on st.dial_id = d.id
            where d.sequence = 'email5' and d.seq_day0 is not null and st.status = 'pending' loop
    perform public.seq_build_tasks(r.id);
  end loop;
end $$;
update sequence_tasks st set due_on = public.seq_due(s1.due_on, 3)
  from sequence_tasks s1, dials d
 where d.id = st.dial_id and d.sequence = 'call3' and s1.dial_id = st.dial_id and s1.step = 1
   and st.step in (2, 3) and st.status = 'pending';
update sequence_tasks set due_on = public.next_business_day(due_on)
 where status = 'pending' and not public.is_business_day(due_on);
