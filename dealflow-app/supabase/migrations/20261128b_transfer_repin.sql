-- List transfer re-pins unsent leads. When a list changes owner (transfer_dial_list, or a dial moving into another owner's list),
-- every lead whose FIRST email has not been queued or sent is un-pinned (sender_account_id -> null) and its pending tasks go to the
-- new owner, so the first email leaves from the NEW owner's mailboxes. Leads already emailed keep their mailbox (threading) and their
-- follow-up emails keep sending from it; their call / LinkedIn / reply tasks move to the new owner.

create or replace function public.dial_unsent(p_dial uuid) returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from dials d where d.id = p_dial and d.email_1_message_id is null)
     and not exists (select 1 from scheduled_emails s where s.dial_id = p_dial and s.status in ('pending','sending','sent','unknown'))
$$;
revoke all on function public.dial_unsent(uuid) from public, anon, authenticated;

create or replace function public.repin_unsent_dials(p_dial_ids uuid[], p_new_owner uuid) returns int
 language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  update dials d set sender_account_id = null
   where d.id = any(p_dial_ids) and d.sender_account_id is not null and dial_unsent(d.id);
  get diagnostics n = row_count;
  update sequence_tasks st set owner_id = p_new_owner
   where st.dial_id = any(p_dial_ids) and st.owner_id is distinct from p_new_owner and st.status in ('pending','failed')
     and (st.kind not in ('email','followup_email') or dial_unsent(st.dial_id));
  return n;
end $$;
revoke all on function public.repin_unsent_dials(uuid[], uuid) from public, anon, authenticated;

create or replace function public.transfer_dial_list(p_list_id uuid, p_new_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid; v_caller_role text; v_caller_team_id uuid; v_new_owner_role text; v_new_owner_team_id uuid; v_ids uuid[];
begin
  select created_by into v_owner from dial_lists where id = p_list_id;
  if v_owner is null then raise exception 'Tab not found.'; end if;
  select role, team_id into v_caller_role, v_caller_team_id from profiles where id = auth.uid();
  if v_caller_role = 'admin' then
    null;
  elsif v_caller_role = 'team_lead' then
    if not (v_owner = auth.uid() or is_team_lead_of(v_owner)) then
      raise exception 'You can only transfer your own tabs or your team''s.';
    end if;
    if p_new_owner <> auth.uid() then
      select role, team_id into v_new_owner_role, v_new_owner_team_id from profiles where id = p_new_owner;
      if not (
        v_new_owner_role = 'admin'
        or (v_new_owner_role in ('intern', 'independent_lead') and v_caller_team_id is not null and v_new_owner_team_id is not null
            and v_new_owner_team_id = any(public.my_team_ids(auth.uid())))
      ) then
        raise exception 'You can only transfer to yourself, someone on your team, or an admin.';
      end if;
    end if;
  else
    raise exception 'Only admins and team leads can transfer a tab.';
  end if;

  update dial_lists set created_by = p_new_owner where id = p_list_id;
  update dials set created_by = p_new_owner where list_id = p_list_id;
  if v_owner is distinct from p_new_owner then
    select coalesce(array_agg(id), '{}') into v_ids from dials where list_id = p_list_id;
    perform repin_unsent_dials(v_ids, p_new_owner);
    update campaigns set sender_account_ids = null, updated_at = now() where list_id = p_list_id and sender_account_ids is not null;
  end if;
end;
$$;
grant execute on function public.transfer_dial_list(uuid, uuid) to authenticated;

create or replace function public.dials_follow_list_owner() returns trigger
 language plpgsql security definer set search_path to 'public' as $$
declare v_owner uuid;
begin
  if new.list_id is distinct from old.list_id then
    select created_by into v_owner from dial_lists where id = new.list_id;
    if v_owner is not null then
      if v_owner is distinct from old.created_by then
        if new.sender_account_id is not null and dial_unsent(old.id) then new.sender_account_id := null; end if;
        update sequence_tasks st set owner_id = v_owner
         where st.dial_id = old.id and st.owner_id is distinct from v_owner and st.status in ('pending','failed')
           and (st.kind not in ('email','followup_email') or dial_unsent(old.id));
      end if;
      new.created_by := v_owner;
    end if;
  end if;
  return new;
end $$;
