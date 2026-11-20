# Email inbox + sequences: build handoff (test branch)

Status as of 2026-11-20. Everything runs on the TEST Supabase project (`aglqusdpkwdidoiaavub`, Mason's
personal free account). The live project (`jabjrhkhnbabfihodqie`) is never written: `tools/testenv/sb.py`
`live_sql()` is server-side read-only plus a keyword guard; there is no live write helper.

## Decisions (Mason, 2026-11-20)
- Move the Oracle hub's 57 mailboxes into the app; use the Oracle server for sending if SMTP from Supabase
  has delivery problems (Gmail/Microsoft/Yahoo). Oracle work happens in a SEPARATE test copy of the hub
  (different port/DB); the live hub is never edited or restarted.
- Mailbox -> person: match on the person's FIRST AND LAST name (display name or first.last@ local part).
  No full-name match -> owned by admin, `needs_assignment = true`, admin assigns by hand.
- Copy is written OFFLINE with Mason's Claude subscription (no API) and uploaded with the list
  (`dials.email_subject`, `email_1`, `email_2`). The intern (list owner) approves each list's copy once;
  then every step sends on schedule. Approval must be simple.
- Buyer brief comes from the Buyers tab (dial_lists.buyer_id -> clients). Mandate: M&A (seller outreach
  doctrine) or data sales (Arieh / Working Signal mailboxes).
- Test sends are redirected (email-send, `TEST_REDIRECT_TO` secret on test only) to:
  masonquinn10@gmail.com, mason.alex.quinn@gmail.com, mason@waystationadvisors.com,
  mason@waystation-advisors.com, mason.quinn@waystation-advisors.com.
  On any non-live project with that secret missing, email-send refuses to send.

## Sequences (business days, America/Denver; day 1 = day the first email actually sends)
- email5: d1 email, d3 call, d3 follow-up email (threaded reply), d4 LinkedIn, d5 call, d7 company-line call
- call3 (no personal email): d1 call, d3 call, d5 company-line call. Starts immediately on upload.
- Generic inboxes (info@, sales@, ...) go to call3 (DATA_PLAYBOOK 10.5.2).
- Stops: owner email reply -> emails cancelled, calls kept, a "reply" task added; bounce -> emails stopped;
  call outcome not_interested / callback_interested / intro_call_scheduled -> whole sequence stopped.

## Done
1. Test project = exact copy of live schema (38 tables, 78 functions, 93 policies, 22 triggers, 71 indexes),
   storage buckets/policies, realtime, 9 cron jobs, 13 edge functions. Live URLs/keys/cron secret inside
   copied DB functions were repointed to test. Scripts: `tools/testenv/{export_schema,apply_schema}.py`.
2. `dealflow-app/js/config.js`: default LIVE; only Vercel preview hosts
   (`waystation-advisors-*-waystation-advisors.vercel.app`) and localhost use TEST.
3. Edge function source now in repo; cron secret read from `CRON_SHARED_SECRET` env (no hardcoded secret).
   **Before deploying these to live: set `CRON_SHARED_SECRET` on live to the current value.**
4. Migration `dealflow-app/supabase/migrations/20261120_email_sequences.sql` applied to test. Key objects:
   `sequence_tasks`, `my_tasks` view, `seq_prepare_list(list)`, `approve_list_copy(list)`,
   `complete_sequence_task(task, outcome, note, skip)`, `stop_sequence(dial)`, `sequence_dispatch()` (cron 5 min,
   weekdays 8-17 Denver, 1 send per mailbox per run), `scheduled_emails_seq_sync` trigger,
   `email_inbound_seq_check` trigger, `match_mailbox_owner(display, email)`, per-mailbox `daily_send_limit`.
   **Live deploy order: migration first, then email-send** (email-send writes scheduled_emails.sent_message_id).
5. Test users (fake @example.com logins; passwords in `~/Projects/First Project/.waystation_test_secrets.json`,
   git-ignored, chmod 600): Test Admin, Taylor Lead, 3 generic interns, plus the 13 real names behind the
   hub mailboxes. `tools/testenv/seed_users.py`.
6. 57 hub mailboxes imported to test (`tools/testenv/import_hub_mailboxes.py`, passwords streamed over SSH,
   never on disk): 53 auto-assigned, 4 need assignment (austin@, jonah@ x2, andrew@). Sync OFF for all.
   Working Signal M365 boxes: 5/day, credentials never verified (likely why SMTP had issues).
7. Local test server: `.claude/launch.json` -> `waystation-crm-test` (port 5173). Login verified.

8. `tools/testenv/test_sequences.py`: 45/45 scenario tests pass (classification, approval rights, business-day
   dates, send window/weekend, 1-per-mailbox-per-run, cap rollover, re-base on real send, threaded follow-up,
   reply/bounce/outcome stops, double-clicks, RLS for intern/lead/other team, deleted list, name matching).
9. `tools/testenv/sync_grants.py`: test privileges mirror live exactly (live uses column-level grants on
   email_accounts so `password` is never readable). FOUND+FIXED in test: my first copy had looser grants.

## Next
- Admin: mailbox management page (assign/unassign, limits, pause) + bulk import endpoint
  (edge function `mailbox-admin`, admin JWT; JSON body so AI tools can call it).
- Upload: on CSV import call `seq_prepare_list`; show split (email vs call); copy review + one-click approve
  with JS lint (<=85 words, no em/en dashes, no {placeholders}, unique sentences across the list,
  greeting first name present, subject present, follow-up present).
- Messages: interns get their own mailboxes (owner path already works); leads pick which interns' inboxes
  to view (accountsVisible picker; RLS already allows leads to read).
- Today page: per-person task list (overdue + today), call/LinkedIn/company-line actions, email status.
- Delivery test: real sends from each provider to the 5 sink inboxes; if Supabase SMTP fails for M365,
  build the Oracle test hub relay (XOAUTH2 via the hub's Entra app) and set `send_route = 'oracle'`.
- Offline copy generator: script using waystation-seller-outreach / data_rich_ai docs via `claude --print`
  + llm_pool, outputs the upload CSV.
- Edge-case + load tests (1k-5k rows, concurrent approvals, cap exhaustion, weekend/holiday, DST).
