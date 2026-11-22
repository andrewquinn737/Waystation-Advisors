"""TEST-only data fixes for the tracking / reporting / intro-call stage (migration 20261129_tracking_reporting.sql).
Idempotent. Never touches live (sb.test_sql only).

WHAT LIVE WOULD NEED (do not run this script there; adapt):
  1. Duplicate call_status_changes rows (same user/dial/method/day): delete the later ones. Safe, 12 on the live copy.
  2. busy_callback / callback_interested dials with no callback_at (349 of 366): give them a default time. On TEST they are
     spread over the next business day in 15-minute slots per owner. On live prefer NOT to stamp 349 reminders at once:
     either spread over a week, or only fix dials worked in the last 14 days and let the Profile "needs a time" list cover the rest.
  3. intro_call_scheduled dials with no client (50): ensure_intro_client_for_dial() creates the client + a "time to be set"
     placeholder event (tomorrow, flagged). Notifications for these are suppressed here (they are old news).
  4. intro_call_log: link each legacy credit to the client whose first intro event it belongs to (nearest in time, same user,
     one-to-one); clients with an intro event and no credit get one. Credits left over are real "booked but never recorded" calls
     and stay as they are (reported by test_tracking_stage.py).
  5. Notifications older than 3 days: mark read (none were ever marked read).
  Not fixable from data: 29 intro events were dated before they were created (logged after the fact) and the Nov 2-16 events are
  unconfirmed. The confirm-prompt job (run_intro_confirm_prompts) now asks for confirmation within 14 days of the call date.
"""
import sb

q = sb.test_sql

def run():
    out = {}
    out["dup_csc_deleted"] = q("""
      with d as (select id, row_number() over (partition by user_id, dial_id, contact_method,
                   (changed_at at time zone coalesce((select nullif(timezone,'') from profiles p where p.id = call_status_changes.user_id),'America/Denver'))::date
                 order by changed_at, id) rn
                 from call_status_changes where dial_id is not null and user_id is not null)
      delete from call_status_changes where id in (select id from d where rn > 1) returning id""")
    out["dup_csc_deleted"] = len(out["dup_csc_deleted"] or [])

    upd = q("""
      with t as (
        select d.id, coalesce((select c.user_id from call_status_changes c where c.dial_id = d.id order by c.changed_at desc limit 1), d.created_by) as uid,
               row_number() over (partition by coalesce((select c.user_id from call_status_changes c where c.dial_id = d.id order by c.changed_at desc limit 1), d.created_by) order by d.id) rn
        from dials d where d.contact_status in ('busy_callback','callback_interested') and d.callback_at is null)
      update dials d set callback_at = public.next_business_morning((select nullif(timezone,'') from profiles p where p.id = t.uid), 9) + make_interval(mins => (15 * ((t.rn - 1) % 24))::int),
                         callback_user_id = t.uid, callback_reminded_at = null
      from t where d.id = t.id returning d.id""") or []
    if upd:
        q("update dials set callback_defaulted = true where id in (%s)" % ",".join("'%s'" % r["id"] for r in upd))   # the trigger marks a hand-picked time; these were defaulted
    out["callbacks_defaulted"] = len(upd)
    out["callbacks_without_time"] = q("select count(*) n from dials where contact_status in ('busy_callback','callback_interested') and callback_at is null")[0]["n"]

    q("alter table public.client_events disable trigger client_event_intro_created")
    try:
        ids = q("""select d.id, coalesce((select c.user_id from call_status_changes c where c.dial_id = d.id order by c.changed_at desc limit 1), d.created_by) uid
                   from dials d where d.contact_status = 'intro_call_scheduled' and not exists (select 1 from clients c where c.source_dial_id = d.id)""")
        for r in ids:
            q(f"select public.ensure_intro_client_for_dial('{r['id']}', '{r['uid']}')")
        out["intro_clients_created"] = len(ids)
        # a client created from a dial that has none of the intro events (1 on the live copy)
        for r in q("""select c.id, c.created_by from clients c where c.source_dial_id is not null and not exists (select 1 from client_events e where e.client_id = c.id and e.event_type = 'intro_call')
                      and exists (select 1 from dials d where d.id = c.source_dial_id and d.contact_status = 'intro_call_scheduled')"""):
            q(f"""insert into client_events (client_id, event_type, event_date, details, created_by) values ('{r['id']}','intro_call', now() + interval '1 day',
                  '{{"time_pending":true,"auto":true,"via":"dial"}}'::jsonb, '{r['created_by']}')""")
        # link legacy intro_call_log credits to clients (one-to-one, nearest in time, same user + side), then add the missing ones
        q("""
          with ev as (select c.id client_id, coalesce(c.created_by, '00000000-0000-0000-0000-000000000000') uid, c.client_type, min(e.created_at) at
                      from clients c join client_events e on e.client_id = c.id and e.event_type = 'intro_call' group by 1,2,3),
          pairs as (select ev.client_id, l.id log_id, abs(extract(epoch from (l.scheduled_at - ev.at))) gap
                    from ev join intro_call_log l on l.client_id is null and l.user_id = ev.uid and l.client_type = ev.client_type
                    and abs(extract(epoch from (l.scheduled_at - ev.at))) < 129600),
          ranked as (select client_id, log_id, gap, row_number() over (partition by client_id order by gap) rc, row_number() over (partition by log_id order by gap) rl from pairs),
          pick as (select client_id, log_id from ranked where rc = 1 and rl = 1)
          update intro_call_log l set client_id = pick.client_id from pick where l.id = pick.log_id and not exists (select 1 from intro_call_log x where x.client_id = pick.client_id)""")
        q("""insert into intro_call_log (user_id, client_type, scheduled_at, client_id)
             select c.created_by, c.client_type, min(e.created_at), c.id from clients c join client_events e on e.client_id = c.id and e.event_type = 'intro_call'
             where not exists (select 1 from intro_call_log l where l.client_id = c.id) group by c.id, c.created_by, c.client_type""")
    finally:
        q("alter table public.client_events enable trigger client_event_intro_created")
    q("update notifications set read = true where read = false and created_at < now() - interval '3 days'")
    out["unread_left"] = q("select count(*) n from notifications where read = false")[0]["n"]
    out["intro_dials_without_client"] = q("select count(*) n from dials d where d.contact_status='intro_call_scheduled' and not exists (select 1 from clients c where c.source_dial_id=d.id)")[0]["n"]
    out["orphan_legacy_logs"] = q("select count(*) n from intro_call_log where client_id is null")[0]["n"]
    return out

if __name__ == "__main__":
    print(run())
