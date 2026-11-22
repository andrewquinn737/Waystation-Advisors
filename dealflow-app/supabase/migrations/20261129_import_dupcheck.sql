-- Import preview: which of these emails / phone numbers are already on a lead in the system (any owner, any live list)?
-- Staff only (admin / team lead). Returns one row per key (the most recently added match), with the list and owner names
-- so the import screen can say "already in <list> (<person>)". Read-only.
create or replace function public.import_dup_check(p_emails text[], p_phones text[])
returns table(kind text, key text, list_id uuid, list_name text, owner_name text, contact_status text)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists (select 1 from profiles where id = auth.uid() and role in ('admin', 'team_lead')) then
    raise exception 'Only admins and team leads can check imports';
  end if;
  return query
  select distinct on (m.kind, m.key) m.kind, m.key, m.list_id, m.list_name, m.owner_name, m.contact_status
  from (
    select 'email'::text as kind, norm_email(d.email) as key, d.list_id, l.name as list_name, p.full_name as owner_name,
           d.contact_status, d.created_at
      from dials d join dial_lists l on l.id = d.list_id and l.deleted_at is null
      left join profiles p on p.id = l.created_by
     where d.email is not null and norm_email(d.email) in (select norm_email(e) from unnest(coalesce(p_emails, '{}')) e)
    union all
    select 'phone', ph.k, d.list_id, l.name, p.full_name, d.contact_status, d.created_at
      from dials d join dial_lists l on l.id = d.list_id and l.deleted_at is null
      left join profiles p on p.id = l.created_by
      cross join lateral (select right(regexp_replace(x, '\D', '', 'g'), 10) as k
                            from unnest(array[d.mobile_phone, d.company_phone]) x where x is not null) ph
     where length(ph.k) = 10 and ph.k = any (coalesce(p_phones, '{}'))
  ) m
  order by m.kind, m.key, m.created_at desc;
end $$;
revoke all on function public.import_dup_check(text[], text[]) from public, anon;
grant execute on function public.import_dup_check(text[], text[]) to authenticated;
