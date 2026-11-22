-- TEST CALL LOCK (database half). Only active where app_secrets has IS_TEST_PROJECT=1 (set by hand on TEST,
-- never on live, so on live this migration changes nothing). On such a project clients cannot create a
-- calls row for any number except those in app_secrets.TEST_CALL_ALLOWLIST (comma-separated). Fail-closed:
-- test project with an empty allowlist = no number allowed. Service-role code is gated in the edge functions.
create or replace function public.test_call_digits(p text) returns text language sql immutable as
$$ select regexp_replace(regexp_replace(coalesce(p,''), '\D', '', 'g'), '^1(?=\d{10}$)', '') $$;

create or replace function public.test_call_policy() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if not exists (select 1 from app_secrets where key = 'IS_TEST_PROJECT' and value = '1') then return null; end if;
  select value into v from app_secrets where key = 'TEST_CALL_ALLOWLIST';
  return jsonb_build_object('allow', to_jsonb(coalesce(string_to_array(nullif(v,''), ','), '{}'::text[])));
end $$;
revoke all on function public.test_call_policy() from public, anon;
grant execute on function public.test_call_policy() to authenticated;

create or replace function public.calls_test_lock() returns trigger
language plpgsql security definer set search_path = public as $$
declare pol jsonb;
begin
  if coalesce(auth.role(),'') not in ('authenticated','anon') then return new; end if;
  pol := test_call_policy();
  if pol is null then return new; end if;
  if not exists (select 1 from jsonb_array_elements_text(pol->'allow') a
                 where test_call_digits(a) = test_call_digits(new.to_number)) then
    raise exception 'Test app: calls limited to the test number' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.calls_test_lock() from public, anon, authenticated;
drop trigger if exists calls_test_lock on public.calls;
create trigger calls_test_lock before insert on public.calls for each row execute function public.calls_test_lock();
