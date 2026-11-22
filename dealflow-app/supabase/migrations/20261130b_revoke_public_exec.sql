-- Integration fix (2026-11-30): functions added by the tracking and calling stages kept the default PUBLIC execute grant,
-- so anonymous users could call them (tools/testenv/test_hardening.py caught it). Signed-in users keep access; the trigger fn has none.
revoke execute on function public.set_intro_call_time(uuid, uuid, timestamptz, text, text, text, boolean) from public, anon;
revoke execute on function public.calendly_status() from public, anon;
revoke execute on function public.calendly_connect(text, text) from public, anon;
revoke execute on function public.calendly_disconnect() from public, anon;
grant execute on function public.set_intro_call_time(uuid, uuid, timestamptz, text, text, text, boolean) to authenticated;
grant execute on function public.calendly_status() to authenticated;
grant execute on function public.calendly_connect(text, text) to authenticated;
grant execute on function public.calendly_disconnect() to authenticated;
revoke execute on function public.link_call_outcome() from public, anon, authenticated;
