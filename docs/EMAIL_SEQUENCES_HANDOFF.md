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

10. UI built (all on test branch, verified on localhost against TEST): Today page (tasks + approve-copy prompt),
    copy review/approval in Dials (copyLint.js, 46 unit tests), per-person Messages inbox (leads view interns
    read-only), admin Mailboxes page + `mailbox-admin` edge function / API key (41 tests, docs/MAILBOX_ADMIN_API.md).
11. Load test `tools/testenv/load_test.py` (2,700 leads, 9 interns): prepare/approve < 0.5s per list; dispatcher
    < 1.3s/run; 223/225 daily capacity used, no mailbox over its limit; Today query 0.4s. Fixed: single-mailbox
    pinning at approval + dispatcher starvation (mailbox now chosen at send time, then pinned).
12. Microsoft 365 (Working Signal): sending fixed (STARTTLS on 587). Reading their inboxes is BLOCKED: IMAP basic
    auth is disabled and the Nov 13 app-permission grants failed in all 17 tenants (ManagementObjectNotFound).
    Safety: follow-up emails are held unless the sender's inbox synced in the last 2h, so no follow-up goes to
    someone whose reply we couldn't see.
13. TEST cron `sequence-dispatch` is PAUSED (it would really send to the test inboxes). Use
    `tools/testenv/apply_migration.py` to re-apply the migration (keeps it paused).

## Open / next
- Mason: redo Microsoft admin consent + mailbox grants in the 17 tenants (email_hub_oauth/SETUP.md), then add
  XOAUTH2 IMAP to email-sync (or the Oracle test hub) so Working Signal inboxes sync.
- Mason: check inbox placement of the 4 delivery-test emails.
- Assign the 4 first-name-only mailboxes (austin@, jonah@ x2, andrew@) on mailboxes.html.
- Holidays are not skipped (weekends only). Oracle test hub not built (not needed for sending now).
- Offline copy generator: outreach/sequence_copygen (in progress).
- Live rollout (needs Mason's go-ahead): set CRON_SHARED_SECRET on live, run migration, deploy functions,
  merge test -> main.

## 2026-11-21 session state (compact hand-off)
Goal (Mason): imported drafts can be (a) rewritten via the person's own Claude account, (b) edited by hand,
or (c) bulk sent. Any in-app AI MUST follow our copy guidelines. Decisions: Claude CONNECTOR (remote MCP,
personal URL token), bulk send = send the clean ones, hold the rest. Copy writer default model = Sonnet
(outreach/sequence_copygen in First Project; batch 3, 600s timeout; 4/7 passed on fake list).
Done:
- `20261121_copy_gate.sql` + edge fn `copy-gate` (runs `_shared/copyLint.js`, byte-identical to
  `js/copyLint.js`, checked by `tools/testenv/check_shared.sh`). Nothing sends unless the server passed the
  exact current text (copy_hash). Clients can't set copy/sequence columns (guard trigger). approve_list_copy
  starts clean leads, holds the rest; fixed leads auto-join via copy_gate_record. copy_revisions history,
  copy_guidelines table, claude_connector_tokens (hash only). Applied + deployed on TEST.
- `docs/copy_guidelines/{ma_seller,data_sales,README}.md` loaded via `tools/testenv/load_guidelines.py`.
  They list OPEN CONFLICTS for Mason (close rule, 75 vs 85 words, $ in copy, data 50+ vs 30+ employees, etc.).
In progress (background agents): `claude-connector` edge fn + `20261121b_claude_connector.sql` +
`tools/testenv/test_claude_connector.py` + docs/CLAUDE_CONNECTOR.md; review-screen/Profile UI for server
statuses, "Send the N ready", Rewrite-with-Claude panel, Connect Claude card.
Next: review both agents' work, run all suites (test_sequences.py needs copy-gate before approve now;
load_test.py too), commit; one-command test runner + release checklist.
Flagged to Mason: `.mcp.json` live `supabase` entry lost `--read-only` (not by me; not reverted).

## 2026-11-22 send rules v2 (migration `20261122_send_rules.sql`, applied to TEST)
- Window 8:30-17:00 weekdays in the LIST OWNER's zone (`profiles.timezone`, invalid/null -> America/Denver); business-day math in that zone.
- Cap: min(20, `daily_send_limit`) per MAILBOX per local day (first emails + follow-ups, follow-ups first). Spacing 4-9 min between
  consecutive sends of one mailbox (`send_at`), one queued send per mailbox per run, nothing queued after 17:00 (a run in the last
  4-9 minutes of the day queues nothing). Cron should run every minute (test cron stays paused).
- No auto call sequence: no personal email -> `dials.sequence='backup'` (no tasks). `call3` rows converted. Email steps after the first
  are created only once email 1 really sends.
- `start_emails(p_list_id, p_count, p_dial_ids)`; UI calls edge fn `start-emails` (verifies with MillionVerifier via `verify-email`,
  30-day cache `email_verifications`, TEST shortcut: @example.com = ok when not on the live project). SQL refuses unverified leads.
- Copy gate now also checks cross-batch uniqueness (`sent_sentence_index` from outbound mail, 180 days; `lead_copy_hashes` of other
  active/ready leads). SQL normalizer parity with copyLint.js: `tools/testenv/test_sentence_parity.py`.
- `email_queue_status(p_owner)`, view `my_followups`.
- Live deploy: migration, then functions copy-gate, claude-connector, verify-email, start-emails; set `MILLIONVERIFIER_API_KEY` secret.

## 2026-11-20 evening: audits + decisions (see docs/CRM_DESIGN.md)
Mason's decisions: (1) Claude: Stage 1 = each admin connects their own Claude app via the connector during
onboarding; campaign design + review chat happen in Claude; CRM shows campaign + Launch. In-page chat on the owner's
token later, only after Anthropic confirms terms. (2) Warm-up stays in Instantly (mailboxes stay connected there,
warm-up only); CRM does the sending. (3) Simplify nav: intern Calls/Inbox/Me; lead +Team; admin +Admin (Campaigns,
Email accounts, Clients, settings); 5 outcome buttons; slim company card; remove orphan pages + duplicate toggles.
Build split: A = security + deliverability backend (migration 20261124_hardening.sql), B = campaigns + Admin page +
admin onboarding/Claude pairing + connector campaign tools, C = intern simplification + nav. Live-only fixes
(hardcoded secrets in DB, anon access to wp_* tables) are listed in CRM_DESIGN.md §5 for the live rollout.

## 2026-11-21: Mason's review of the walkthrough -> next build
- Admin: remove the Clients tab. Remove team.html entirely; restore the ORIGINAL Profile page (as on origin/main / before commit 9be6979) and
  put "Profile" first in the nav. Pages without a clear purpose go.
- Visual: the all-white + blocky blue buttons look is "horrible"; match the app's existing style, refined.
- Campaign stats like Instantly: Emails sent, Companies contacted, Replied, Interested, Intro calls booked, Bounced. Drop "Need a fix /
  Sending / Sent first" jargon.
- Mailbox check: show Sending vs Reading separately (Microsoft blocks IMAP password login; SMTP works) instead of "login failed".
- Drafting: drafts arrive in the CSV (Email Subject / Email 1 / Email 2 columns, made by outreach/sequence_copygen with the .md
  guidelines). Mason wants an IN-APP Claude bot to bulk-edit a campaign's drafts, routed through the Oracle VM on HIS Claude account
  (he accepted the terms risk). Worker: separate OS user, own systemd unit, never touch the live email hub; token set by Mason himself.

## 2026-11-22: call tracking, survey stamp, phone keys on TEST
- Call sheet "Call <name>" / "Call office" now use the company card's call path (`.contact-action-call`, in-app call or the phone's
  dialer; `autoMarkContacted` writes today's `contacted_*_date` + a `call_status_changes` row, per method per day, as live does).
  Saving an outcome records a contact when the company has no history (live behavior) OR, for the dial's owner, no row from them today
  (a later-day call). First-contact semantics are unchanged. Files: `js/dialsHome.js`, `js/dials.js`.
- Login/index/sw land on Profile again. Messages: no "Microsoft sign-in pending" banner; only "Couldn't sync <address>: <error>" for a
  mailbox with `last_sync_error`. Interns get Search (header icon on Calls) and Text buttons on the company card.
- LIVE BUG: `dials.called_today_date` was never written, so the weekly survey's "Owners talked to" was always 0.
  Fix = client (`js/dials.js` updateDialStatus stamps it) + DB trigger `dials_called_today` (`20261126b_called_today.sql`: stamps it when
  `contact_status` becomes not_interested / callback_interested / busy_callback / intro_call_scheduled, in the caller's `profiles.timezone`).
  **Ships to live: the migration (the trigger fixes every client incl. old cached ones) and the js/dials.js change.**
- Phone on TEST: app_secrets copied from live (TELNYX_API_KEY / PUBLIC_KEY / SIP_CONNECTION_ID / CALLBACK_APP_ID, DEEPGRAM_API_KEY /
  PROJECT_ID, CALL_SUMMARY_INTERNAL_KEY), one `caller_numbers` row (+1 801 251 7644, no fallback user), and the reference tables
  `area_codes` + `state_centroids` (were empty on TEST, so every call came back "native"). `internal_call_secret` is empty on live: not copied.
  Calendly (CALENDLY_TOKEN / CALENDLY_EVENT_TYPE_URI) are edge-function env secrets: values are not readable, set them on TEST by hand.
- Telnyx webhook still points at the LIVE function. Outbound test calls: live's handler only updates `calls` rows matched on
  `telnyx_call_id`, which live does not have, so it writes nothing. Inbound: someone calling a pool number back is screened by LIVE's data
  (rejected, or rung to a live rep if that number was dialed on live today). Test numbers should be Mason's own cell; don't call back the pool number.

## 2026-11-21 late: Mason's issue list -> fixes (in progress)
1 reply task auto-completes on a recorded outbound reply (no check mark); "Waiting for your reply", overdue after 2 biz days.
2 badge text: "They replied – emails stopped" / "You replied". 3 Launch spacing in campaign table. 4 "…" menu works + List details.
5 list transfer re-pins unsent leads to the new owner's mailboxes. 6 upload-to-admin-then-transfer flow tested = original.
7 follow-up threading verified in the 57-mailbox campaign test. 8 every report/PDF/survey verified against DB.
9 copy ALL live data into TEST (live read-only), test logins per real user. 10 BEFORE import: call lock on TEST (only +15024196436),
email redirect stays, auto-send paused. 11 full regression with real data, every role, incl. previously untested items.
Mason: "Do NOT send out any live emails/calls."

## NEXT (queued by Mason, after items 1-11 land)
Step 1 (running): docs/LIVE_USAGE_MAP.md from read-only live data (who does what, order, frequency, pain points, per-stage replay scripts).
Step 2: one agent per stage replays real behavior on TEST with real data and fixes until right: Importing (any CSV headers,
preview, mapping, duplicates, copy check, assign), Email sending (launch->schedule->thread->reply stop->per-mailbox report),
Calling (one tap->call->outcome->next), Transcripts (every recorded call -> transcript + summary on card), Tracking (each
call/email/reply counted once), Reporting (Profile/team/PDF numbers == DB), Intro call scheduling (event + client + notify +
Upcoming; Calendly API needs Mason's token).
Step 3: page-by-page review loops (design / function / bugs agents) until a pass finds nothing; tests green each pass.
Optional: privacy-safe click tracker on live (needs Mason's go-ahead).

### 2026-11-28 issue list items 1-6 (done on TEST)
- `20261128_reply_autocomplete.sql`: no manual Done on reply tasks; trigger `email_outbound_reply_done` finishes the task when an outbound
  email_messages row goes to the lead's address (or into a thread they wrote in) after the task existed; due = +2 business days (owner tz,
  `add_business_days`); a later message from the lead re-opens it; `my_followups` lists reply tasks from day 0. Row text "Waiting for your reply".
- Badges: "They replied - emails stopped" -> "You replied" (js/mailboxScope.js).
- `20261128b_transfer_repin.sql`: transfer_dial_list / dials_follow_list_owner un-pin leads whose first email is not queued/sent and move their
  pending tasks (+ calls of emailed leads) to the new owner; emailed leads keep mailbox + follow-up owner; campaigns.sender_account_ids reset.
- Admin > Campaigns: fixed-width action column, floating "..." menu (List details / Review / Pause-Resume / Launch more / Design), details sheet,
  `dials.html?list=<id>` deep link. Upload-then-transfer flow checked in browser: same import/transfer code as origin/main, plus mandate + sequence prep.
- Tests: test_campaigns.py `_transfer_and_reply` (17 checks). Ships to live: both migrations + the JS.


## 2026-11-22: TEST call lock + live data copied into TEST (items 8-11)
- **Call lock (TEST only):** env secret `TEST_CALL_ALLOWLIST=+15024196436` (Mason's cell). `telnyx-token` and `telnyx-webhook` (`_shared/testCallLock.ts`)
  refuse any other number when `SUPABASE_URL` is not live (fail closed if unset); migration `20261128_test_call_lock.sql` rejects client `calls` inserts for other
  numbers where `app_secrets.IS_TEST_PROJECT=1` (set by hand on TEST only, so it is inert on live); `js/testCallGuard.js` blocks tel: dialing with
  "Test app: calls limited to the test number". Telnyx webhook on TEST still points at the live function (unchanged).
- **Live data copy:** `tools/testenv/copy_live_to_test.py [--dry-run] [--tables a,b]` (idempotent). 30 auth users with the live uuids as `live.<name>@example.com`; logins in
  `~/Projects/First Project/TEST_LOGINS_LIVE_COPY.md` (outside the repo, chmod 600). Not copied: app_secrets, temp passwords, push subscriptions, Telnyx credentials,
  caller_numbers (unique e164 already on TEST). Live mailboxes arrive without credentials, sync off, scheduled mail cancelled, as `<local>+livecopy@<domain>`, `source='live_copy'`.
  Live people who share a name with a TEST fixture account get " (live copy)" on their name (name matching is ambiguity-safe by design).
- **Regression with real data:** `test_live_copy.py` + `test_live_copy2.py` (in run_all.sh). Live rollout needs only: migration 20261128 is inert on live (no IS_TEST_PROJECT row);
  the two edge functions and `testCallGuard.js` are harmless on live (guard returns null policy). Don't deploy them unless you want the shared helper.
