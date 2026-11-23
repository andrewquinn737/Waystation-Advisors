-- TEST pilot: named users (app_secrets.TEST_CALL_FREE_USERS, comma-separated user ids) may call real numbers on the
-- TEST project; everyone else stays on the allowlist. Like 20261128_test_call_lock.sql this only acts where
-- app_secrets.IS_TEST_PROJECT = '1', so on live it changes nothing (test_call_policy() still returns null there).
create or replace function public.test_call_free_user() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.uid()::text = any (string_to_array(replace(
    (select value from app_secrets where key = 'TEST_CALL_FREE_USERS'), ' ', ''), ',')), false)
$$;
revoke all on function public.test_call_free_user() from public, anon, authenticated;

create or replace function public.test_call_policy() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if not exists (select 1 from app_secrets where key = 'IS_TEST_PROJECT' and value = '1') then return null; end if;
  select value into v from app_secrets where key = 'TEST_CALL_ALLOWLIST';
  return jsonb_build_object('allow', to_jsonb(coalesce(string_to_array(nullif(v,''), ','), '{}'::text[])),
                            'free', test_call_free_user());
end $$;
revoke all on function public.test_call_policy() from public, anon;
grant execute on function public.test_call_policy() to authenticated;

create or replace function public.calls_test_lock() returns trigger
language plpgsql security definer set search_path = public as $$
declare pol jsonb;
begin
  if coalesce(auth.role(),'') not in ('authenticated','anon') then return new; end if;
  pol := test_call_policy();
  if pol is null or coalesce((pol->>'free')::boolean, false) then return new; end if;
  if not exists (select 1 from jsonb_array_elements_text(pol->'allow') a
                 where test_call_digits(a) = test_call_digits(new.to_number)) then
    raise exception 'Test app: calls limited to the test number' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.calls_test_lock() from public, anon, authenticated;
