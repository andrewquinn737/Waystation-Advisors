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

## 2026-11-22 status
Done: fixes 1-6 (06580ba), call lock + live data copy (c943ea3; test logins in First Project/TEST_LOGINS_LIVE_COPY.md),
real-data regression 100/100, run_all ALL GREEN. 57-mailbox campaign: 47 sent, 24 inbox, 17 JUNK (all Microsoft recipients),
6 unseen, 0 bounces; reply-stop + threading NOT yet confirmed.
Wave 1 stage agents running: Importing (TEST-IMPORT), Calling+Transcripts (TEST-CALL, ≤2 calls to Mason's cell),
Tracking+Reporting+Intro calls (TEST-TRACK, migration 20261129). Each runs only its own tests.
Wave 2 (after): Email sending/deliverability stage (fix Microsoft junk placement; seed-test Gmail/Outlook/Yahoo; confirm threading
+ reply-stop with real replies), then integrator run_all.sh, then page-by-page design/function/bug review loops until clean.

## 2026-11-22 deliverability + threading/reply-stop (stage agent)
- Microsoft junk root cause and fixes: docs/DELIVERABILITY.md (auth all pass; recipient-tenant spam filter on new tenants; app-side fixes shipped; tenant steps for Mason).
- `20261130_deliverability.sql` (recipient_domains, recipient_provider, recipient_pacing) + email-send (no List-Unsubscribe on sequence mail, CTE, named To, Microsoft pacing, `deferred` outcome) + email-live `headers` action. Deployed to TEST.
- `20261130b_revoke_public_exec.sql`: calendly_* / set_intro_call_time / link_call_outcome were executable by anon (found by test_hardening). Ships to live with the stage migrations.
- Real-mail test `tools/testenv/test_thread_reply_stop.py` (not in run_all): follow-up threads correctly, reply stops the sequence and creates the reply task.

## 2026-11-22 round 1 of the page-by-page review (Calls, Inbox, Clients, Admin, Profile)
Migration `20261201_round1_review.sql` (TEST only so far; ships to live with the stage migrations). Findings files were in the review scratchpad; all blocker/major/medium/minor items fixed unless listed below.
- **Callbacks:** one compact dismissible line ("2 overdue callbacks - 1 today - View", <= 44px) that expands to the list; same on every page (`js/callbackBanners.js`).
- **Calls look:** calm slate tokens (`--tone*`) for the active tab, Call mobile/office, and a selected outcome (check mark + tint); outcome buttons are neutral at rest; `.btn.secondary:hover` / outcome hover no longer dark-on-navy. Search results use the card list on narrow windows; sheet-shaped loading skeleton; row meta no longer repeats the group label; 44px touch areas; callback/intro popups dim the card harder. Outcome save: if the status update fails after the call task was closed, `reopen_sequence_task` puts the task back.
- **Speed (the 500s/timeouts):** cause = RLS policies calling `auth.uid()` / `is_admin()` once per ROW on `dials` / `dial_lists` / `call_status_changes`, no indexes on `dials(email|list_id|created_by)` or `call_status_changes(user_id,dial_type,changed_at)`, and `profile_companies_contacted` re-scanning the log per bucket. Fixed with initplan policies, indexes, one-join RPC. EXPLAIN as admin: email-IN query 1127 ms -> 4 ms; companies-contacted 411 ms/bucket -> 42 ms for 7 buckets. UI: seq badges retry once; Profile shows "Couldn't load this week's count. Retry"; nav lookups are capped at 4 s.
- **Inbox:** old inbound bounces backfilled (`is_system`); Mailboxes picker can be emptied (Done stays blocked until one is ticked); failed `?from=` keeps the list and escapes `_ %`; Inbox tab works from a thread; unsent compose text survives Cancel/X (per conversation, this tab session); thread opens paint from stored snippets then fill in the live message (spinner copy); compose button z-index below popups; keyboard-reachable rows; unread count in the tab title; preconnect now follows `config.js` (the static LIVE host link is gone from every page).
- **Clients:** the original gear is back (Accounts visible, Sellers/Buyers/Brokers popup for admin, Notifications, Advanced); header line "N sellers - my account"; "No clients match"; skeleton cleared on error; tasks skip the meeting report; Categories submenu no longer covers labels on phones. Timeline intro call: if a pending intro call exists it asks "Move the existing one, or add a new one?" (`set_intro_call_time` vs new `add_intro_call`); success text only after the RPC works, errors appear inside the popup; moving with no time keeps the "time to be set" flags.
- **Admin:** Campaigns read cached stats (`admin_campaigns(p_fresh := false)`) and refresh in the background; names wrap to 2 lines; one left edge; Launch disabled without a sending mailbox and not repeated in the "..." menu; totals = rows shown; "Backup (calls only)"; solo "..." sits in the card corner; Settings copy updated, setup command no longer shown or shipped in JS (`ai_setup_command()` reads `app_secrets.ai_worker_setup_command`, admin only; set on TEST, **set it on live by hand**); wizard closes on Esc, one button name; accounts: readable group summary, no "AI Assistant" owner, wrapping names. Import: invalid emails saved blank and counted, one chip story, duplicate rows marked in the preview, duplicate warning names the EXISTING lead + tab (`import_dup_check` now returns `lead_name`), result line without the timing phrase.
- **Data:** the Curtis Ford intro event details restored to the auto "time to be set" shape (LIVE has no client for that dial, so there was nothing to copy; the TEST row came from a test booking).
- Tests added: test_browser.py `round1()` (35 checks), test_tracking_stage.py (add_intro_call, flag-preserving move, reopen task), test_campaigns.py (cached vs fresh, ai_setup_command), test_import.py + import_unit (invalid email, existing-lead naming, preview marks); `import_unit` is now in run_all.sh.
- Needs Mason: items in the final report (live rollout steps, ai_worker_setup_command on live, reply tasks have no manual Done by design).

## 2026-11-22 round 2 of the page-by-page review
Migration `20261202_round2_review.sql` (TEST only so far; ships to live with the stage migrations, after `20261201_round1_review.sql`). Fixed all HIGH/MAJOR/MED/minor/LOW items from the three finding files; not-done items are listed at the end.
- **CSV import:** the parser opens a quote only at the start of a field (`Joe's 5" Pipe Co`, `ABC "The Best" Plumbing` are plain text). An unclosed quote, or a file that comes out ragged, is re-read with every quote literal and the preview shows a warning; the row count now matches the line count. A binary file says "This isn't a CSV file". The preview shows the email subject / Email 1 / Email 2 columns, and the result line says WHY rows are held ("Missing Email 1 (12)").
- **10k import:** `seq_prepare_list(list, limit)` is set-based (one UPDATE ... RETURNING) and the client calls it in 2,500-row chunks that resume (only leads with no sequence yet are touched). 8,000 rows measured at 1.5 s including the network round trip. `msg()` in `js/copyCommon.js` turns timeouts / SQL / network text into plain sentences; the import result shows a Retry button when setup stops.
- **Import screen:** Assign-to never lists the AI Assistant (`withoutAi()` in `teamScope.js`, also used by Accounts visible, Transfer and Restore); a warning (not a block) when the person getting an M&A / Data list has no mailbox for it (`owner_mailbox_count` RPC, admins and team leads only); Esc closes the modal.
- **Transfer menu:** searchable list with role labels, a Cancel / Send confirmation, and a "Sent to X" toast (`showToast` in `notice.js`).
- **Calls:** a failed outcome save leaves a visible message (the re-render used to clear it); a failed list load shows "Couldn't load this list" with Retry instead of "You're all caught up"; Past due / Due today are scoped to the current tab with a "N follow-ups due in other lists / Show all lists" switch; the sheet shows the skeleton until the follow-ups are in (no groups 6-8 flash); "Confirm the scheduled time" has Cancel / Esc / tap-outside, which puts the dial back to its earlier status (the existing `dials_intro_booked` trigger removes the placeholder client); failed `complete_sequence_task` / `sync_latest_call_status` calls show a toast; one clear button and a match count in search; callback / intro popups use the slate tone, not saturated blue / yellow; phone numbers are formatted on display only.
- **Clients:** intro Move / Add prompt names the dates ("Move the Nov 24 call to ..."), targets the nearest upcoming pending call (`set_intro_call_time` picks it the same way), keeps the choice after an RPC error, and "Skip Calendly" saves `via = manual`; timeline confirm / pencil have 44px touch areas; Categories opens under its own row at phone width; load failure has Retry.
- **Admin:** "Contacted" is now "Companies emailed" = dials with `email_1_message_id`; a sent first email whose message row is not linked now fills it from `email_messages.scheduled_id` (so follow-ups thread) and old gaps were backfilled; Settings no longer mentions app_secrets / docs.
- **Inbox:** Sent / Spam / Trash paint each batch of mailboxes as it arrives ("Still loading N of M"); Scheduled reads `scheduled_emails` directly (no IMAP); `?from=` prefers a thread in a mailbox the person can answer from; unread count in the tab title counts only the person's own mailboxes and the Inbox tab has the same badge; 44px tabs / back / reply / gear; reply drafts save as you type; auto-sync aborts on navigation are not logged.
- **Profile / Reports:** Log out is wired before the page finishes loading; no callback banner on Profile (its own box is right there; overdue rows are amber, not grey); a report week is Monday to Sunday (rollup `+ 7`, label "Mon - Sun", recomputed) so Profile and Reports agree; "No accounts selected" message; edge shadows on the wide table; no `clients?id=eq.null` for "Not attached to buyer".
- **Offline / PWA:** `sw.js` v122 precaches every page / script / stylesheet one by one, only caches `ok` responses, matches ignoring `?v=`; `pwa.js` shows "You're offline" instead of a skeleton for good.
- **Login:** a logged-out deep link (`messages.html?from=...`, `dials.html?dial=...`) returns to that page after sign-in.
- **Tests:** `test_browser.py round2()` (20 checks, TEST-R2 data removed afterwards), `test_import.py` (binary, stray quotes, Esc, AI Assistant, mailbox warning, injected timeout + Retry, 10,000-row setup) is now in `run_all.sh`, `import_unit` has the quote / binary cases. The suites that book intro calls delete the "Pat" client with their list; the 8 leftovers on TEST were deleted.
- **Not done / needs Mason:** date inputs in the confirm-time popup were not changed (could not reproduce the 22px difference with `appearance: none`); the AI Assistant is hidden by name (`full_name = 'AI Assistant'`); the survey period stays Mon - Fri (it is submitted on Friday).

## 2026-11-22 round 3 of the page-by-page review
Migration `20261203_round3_review.sql` (TEST only so far; ships to live after `20261202_round2_review.sql`). Fixed the findings from the three round-3 reviews (email flow, calling flow, tracking/admin); what was not done is listed at the end.
- **LIVE HAS THE SAME SECURITY GAPS and needs this migration (sections 1-3 first if the rest has to wait):**
  1. `call_status_changes`: any signed-in user could INSERT a row for any user_id (padding or forging another person's call counts that feed Profile / Reports / rollups) and read every team's rows. Now insert = yourself (or an admin); read = your own rows, your team's (team lead), everyone's (admin), and rows on dials you own. Helper `csc_team_user_ids()`.
  2. `profiles`: `profiles_select_all` was `using (true)` for role public, so the anon key alone read every name, email, phone, calendly link and email template. Now `to authenticated`. Checked first: `login.html`, `index.html`, `auth.js`, `intakeForm.js` and the edge functions never read `profiles` before sign-in (edge functions use the service role), and every role still logs in (test_browser logs in as admin, team lead, intern).
  3. `create_notification` had no caller check: any intern could push any message/type to anyone. It now allows only the target, the target's team lead, an admin, or the service role. The old body is `create_notification_internal` (not executable by clients); the migration rewrites every existing server-side caller (cron `run_daily_event_notifications`, `callback_tasks_escalate`, the new-email trigger, plus any extra on live: the DO block finds them by name) to call it. The edge function `telnyx-webhook` keeps calling `create_notification` with the service role. The "X sent you a list" notice moved into trigger `dial_lists_notify_transfer` (fires when `created_by` changes, so Transfer and import-assign still notify, once); the two client `createNotification` calls were removed.
  4. `compute_report_rollups`, `prune_report_data`, `run_daily_event_notifications`, `callback_tasks_escalate` are no longer executable by signed-in users (cron runs as owner).
- **Email**
  - Launch: the result sentence accounts for every lead ("2 emails started. 4 moved to backup (calls only): 1 with a bad address, 1 on the do-not-email list, 2 already in another campaign."); `start_emails` returns `bad_address / suppressed / duplicate / considered / backup_total / backup_no_email`. The launch sheet now shows, BEFORE the click (`campaign_launch_preview`): ready / skipped counts, the mailboxes that can send this mandate with real per-mailbox caps and why (new-mailbox ramp, daily limit, 60/day per sending domain), the day the first emails start and about when they finish, and the first email itself. List details uses `email_queue_status(p_owner, p_mandate)`, so an M&A campaign lists only M&A-eligible mailboxes (it matches the row hint), plus per-step stats (first email vs follow-up: sent / replied / bounced, `campaign_step_stats`) and labels "On email track / Backup (calls only) / Total leads".
  - Admin > Do not email: view, search, add (paste many emails or domains with a reason) and remove, with source, who added it and the date (`suppression_list`, `suppress_many`, `unsuppress_domain`; `js/adminSuppression.js`).
  - Bounce guard: hard bounces count fully; soft ones (mailbox full) only when repeated (`dials.bounce_kind`, `soft_bounces`). A mailbox/list pauses at >= 3 counted bounces in under 20 sends, or > 10% from 10 sends; the >3% rolling rule from 20 sends stays.
  - Reply stop also fires on the same thread (`thread_id` / In-Reply-To = the lead's first email) or from anyone at the lead's company domain that wrote to the same mailbox (never a free-mail domain). A stop reply from an alias also suppresses the lead's own address.
  - Out-of-office / auto-replies (`email_messages.is_auto_reply`: Auto-Submitted / X-Autoreply / Precedence headers set by `email-sync`, plus common subjects and snippets in `email_is_auto_reply`): not a reply, do not stop the sequence, no push, "Auto-reply" badge in the Inbox. `email-sync` redeployed to TEST.
  - A bounce push now reads "An email could not be delivered. See Inbox > Bounces." (and noise notices push nothing). Admin "Sent" counts outbound `email_messages` linked to the list's emails, not `scheduled_emails` rows.
  - Review screen: 50 cards at a time ("Showing 50 of 2,100. N need edits"), problem rows first. Import: "Biz Name"-style headers map to Company, a file with no Company column says so and opens the mapping, emails are lower-cased, a second address in one cell is reported, reasons in the result read as real sentences (no `#`), generic info@ leads are named, the campaign row no longer says "Design them in Claude" when the CSV already has copy. Muted slate buttons on Admin. Inbox thread at 375: date wraps, sticky Reply bar, no "+" over messages; campaign status pill gets its own row.
  - **No open/click tracking, on purpose**: it needs a tracking pixel and rewritten links, which hurt deliverability (spam placement) for cold mail. Reply and bounce are the signals we use. Revisit only with Mason's go-ahead.
- **Calls**: the load-failure Retry now survives the follow-ups re-render (the sheet renders it itself); a callback missed earlier today is in Past due ("Missed callback", oldest first) and one due later today in Due today, and the banner counts it as overdue; a failed note save says "Note not saved (...). Tap outside the box to try again." under the box (never "Saved"); the in-call bar uses the card's outcome set (including Intro call booked) and opens the callback-time picker / intro flow, the Keypad goes away after hangup and Close is neutral; "Next company" takes a due callback first; the last call's summary shows above "More", recording errors read "no longer available"; the client Timeline shows the call(s) that led to the client (summary, transcript, recording); the "Did it happen?" notification opens the Timeline tab and an unconfirmed past event says "Did it happen?" (note is optional); the missing-information check for "Intro call booked" runs BEFORE the status flips (with a "Fill in now" button); closing the first intro chooser reverts the dial and the placeholder client like Cancel on the time step; the time step is prefilled from the callback time; the Move/Add prompt hides the Calendly buttons and the footer Close; Timeline "Intro call" with a time already entered skips the Calendly chooser; stale follow-up rows stay when the companies behind them cannot be read.
- **Tracking / admin**: Reports opens on the whole team (team lead) or everyone (admin) instead of "only me", sorted by activity, with the week named, a visible Accounts button, Download CSV, and the options menu closes after Done; Clients list uses cards in a narrow window (no sideways scroll); Esc closes the Deleted-tabs reassign / purge popups; Email accounts keeps owner groups open, toasts owner changes and pause/resume, and labels roles; timeline label "time to be set" matches Profile.
- **Not done** (and why): client stage history (`clients.pipeline_status` is still a bare update; needs an event type and a place in Reports, a product call); Reports week boundary is America/Chicago in `compute_report_rollups` but the browser's zone on Profile (needs one agreed zone); two people on one dial soft lock; the 8s skeleton before "Couldn't load follow-ups" (browser fetch timeout, not our timer); row call icons size at 375; per-campaign mailbox choice, sending window and custom merge fields from extra CSV columns (product choices). Reply tasks stay due in 2 business days on purpose.
- **Live rollout notes**: live rollups are Mon-Fri while the raw log has weekend calls; after the round-2 migration the last 4 weeks recompute upward (tell the team). `email-sync` must be redeployed on live for header-based auto-reply detection (the subject/snippet detection works without it).
- **Tests (round 3)**: `test_hardening.py` sections 10-12 (security majors, bounce guard, reply-stop thread/domain, auto-replies, suppression RPCs), `test_campaigns.py` (launch preview + accounting, mandate-aware queue status, per-step stats), `test_browser.py round3()` (Retry survives, missed callbacks + banner, failed note save, intro prompts/chooser revert, in-call chips, Reports default + CSV, Do-not-email screen, 120-row review paging, launch preview, client Timeline calls), `import_unit` (+2). Intentionally changed assertions: "19 sends, 5 bounced -> no pause" (a new mailbox now pauses early), and `test_live_copy2.py` (Reports storage key `..._v2`, table text parsed from the table only, no "Select all" click because Reports opens on the whole team). `run_all.sh` ALL GREEN on 2026-11-22. The 10k-row review list was NOT built (TEST CPU); paging is verified with a 120-row fixture plus the code path (50 cards per page).

## 2026-11-22 round 4 of the page-by-page review
Migration `20261204_round4_review.sql` (TEST only so far). Its header marks **sections 1, 2, 3 and 3b as LIVE security hotfixes**: they use nothing from the later sections, so they can be run on live on their own, first. Everything else follows on the normal rollout. Edge function `schedule-intro-call` redeployed to TEST (repo copy updated). `sw.js` v125.

- **Security (hotfixes, all proven on TEST with anon / intern exploits that now fail and legit roles that still work, `test_hardening.py` sections 13-14):**
  1. `is_team_lead()` was `select true`. It now checks the caller's profile role (team_lead or admin). The five legacy tables (buyers, sellers, deals, commissions, subscription_payments) are `to authenticated` and anon has no grants. The anon key alone could read, write and delete them before.
  2. `profiles` self-update: a trigger now lets a non-admin change only an allow-list of personal fields (name, phone, emails, avatar, calendly, timezone, templates, notification flag, Calls > Advanced switches, onboarding stamp). Role, team, `sourcing_access`, `sourcing_send_access` and any column added later are admin-only (service role / SQL console unrestricted). **Decision:** the recording switches (`record_accepted_calls`, `record_all_calls`), `autodial_enabled` and `transcript_calling_enabled` stay self-service because Calls > Advanced writes them for your own calls; moving them out of `v_self` in the trigger makes them admin-only (and that screen would then need an admin path).
  3. Caller checks: `log_shared_client_event` (counterpart must be in your team scope, created_by is always you), `get_client_full_name` and all five `get_buyer_*` (buyer must be in your scope, via `client_in_my_scope` / `buyer_in_my_scope`; the `get_buyer_*` bodies are patched by a DO block that raises if the text on live differs), `seq_maybe_complete` (owner / lead / admin / internal), `seq_pick_sender` (service role only), `get_questionnaire_buyer_ids`, `match_mailbox_owner`, `person_tz`, `my_team_ids` (not anon). 3b pins `search_path` on the 19 listed definer functions.
  4. `schedule-intro-call` needs a signed-in user, a `client_id` or `dial_id` the caller owns / leads / (admin), ignores any client-supplied intern email (uses the caller's), and rate limits per user. Nothing in the app calls it today.
  5. Minors: dials INSERT only into a list you can see; attachment storage policy gets the team-lead branch and `to authenticated`; avatars bucket images only, 2 MB, own-folder writes, signed-in only; Reports CSV prefixes `'` on cells starting `= + - @ tab CR` (plain negative numbers untouched); Esc closes the Deleted-tabs list when no popup is open; admin tab strip scrolls with gaps at 375px.
  6. Public sign-up is off on TEST (`disable_signup=true`, set through the management API). `admin-create-account` / `admin-delete-account`, role changes by an admin and every role's login were re-tested with it off.
- **Email:** list pause by the bounce guard shows on Campaigns ("Paused: bounce rate 33.3% (3 of 9 sends bounced)") and Resume calls `resume_sending('list')` through `campaign_resume`; clearing any mailbox / list pause (trigger `reset_bounce_window`) restarts its bounce window; a partly launched campaign shows Running with "x of y started", can be paused, and says "N more ready" (the "copy changed" text only when copy was edited after launch). Auto-reply = headers or a strict subject pattern only; any interest or stop wording is a person (`email_human_language`), also over an auto-reply header; stop wording always suppresses. Delay notices are ignored; a first soft bounce is retried once and the second stops the lead (so soft bounces now reach the guard); system mail (`no-reply@` ...) from the lead's domain is not a reply; auto-replies arrive read. Do not email: bare free-mail domains and made-up domains are refused, company domains ask first with the lead count (`suppress_preview`), search ignores `%` `_` wildcards, newest search wins. `start_emails` takes a per-list advisory lock. Offline Campaigns keeps its rows, launch sheet text/spacing, first send day in the result sentence, double-click on Launch, "(you)" only on your own mailbox, "Reply as <mailbox>" for an admin, "Only X can reply" for a lead.
- **Calls:** the in-call bar gives popups bottom padding (`--call-bar-h`) so More, Prev/Next and Save scroll clear of it (375 and desktop tested), and the bar's duplicate outcome set hides while the card is open; the state select maps `UT` to Utah and keeps an unmatched value as its own option (never writes null; `state_select.test.mjs` + browser test); leaving mid-call asks first (`beforeunload`), an in-app link asks "End the call?", and a page that goes anyway closes the call row (`ended_at`, `end_reason = 'left_page'`, dial stays in the queue with no outcome); `close_my_stale_calls()` closes rows left open 2h+; notification clicks navigate an open window (`sw.js` + `pwa.js` message); intro revert restores the callback time and the intro time is prefilled from the callback captured before the flip; Timeline shows calls with a summary / recording first plus "Show all N calls"; row icons get a 40 x 44 touch area; "No phone number" hint and tag; follow-ups show "Loading follow-ups..." after 3 s instead of a blank skeleton; note-save error no longer says "press Retry".
- **Not done (and why):** `profiles_select_all` still lets every signed-in user read the directory (the app lists teammates on many screens; a narrow view is a product call); `profile_temp_passwords` still holds plaintext temporary passwords (admin-only by RLS; replacing it with a "must change" flag changes the account-creation flow); saturated-blue leftovers (View Reports, avatar circle, Inbox badges); admin banner label for whose callbacks; soft lock for two people on one dial; password length 6 / leaked-password protection (Supabase Pro setting); pg_net in `public`. Intentionally changed test assertions: the round-3 "soft bounce stops at once" checks (a "(Delay)" notice is now ignored and the second soft bounce stops the lead), the sections 10-12 duplicate call in `test_hardening.py`.

### LIVE rollout (Mason approves each step; nothing here has been run on live)
1. **URGENT, before anything else: state hotfix in `js/dials.js`.** LIVE's `origin/main` has the Calls edit form (around lines 2976 / 3005) whose state `<select>` only has full names: any dial stored as `UT` / `TX` that is opened and saved loses its state (`state = null`; it feeds the call consent decision). LIVE holds 1,972 such dials. Ship `clientForm.js` (`stateToName`, `stateOptionsHTML`) + the two-line change in `buildDialEditHTML`. No data repair was done on live.
2. **Security hotfix SQL (sections 1, 2, 3, 3b of `20261204_round4_review.sql`)** run on live alone, as soon as approved. Check afterwards: anon `GET /rest/v1/buyers` is 401; an intern cannot PATCH `sourcing_access`; log in once as admin, team lead and intern; open Profile and Calls > Advanced and save.
3. **Disable public sign-up on live:** Supabase dashboard (live project) > Authentication > Providers > Email > turn off "Allow new users to sign up" (or `PATCH /v1/projects/<live-ref>/config/auth {"disable_signup": true}`). Then create a test account from Profile > Add account to prove `admin-create-account` still works. Optional: raise minimum password length, enable leaked-password protection (Pro).
4. **Migrations in order:** `20261201_round1_review.sql`, `20261202_round2_review.sql`, `20261202b_intro_confirm_lock.sql`, `20261203_round3_review.sql`, `20261204_round4_review.sql` (rest of it, after step 2; step 2 is idempotent). Set `ai_worker_setup_command` and `CRON_SHARED_SECRET` per the earlier rounds' notes.
5. **Edge functions to redeploy to live:** `schedule-intro-call` (this round), `email-sync` (round 3, header-based auto-reply detection), and the earlier-round functions listed in rounds 1-3 that are not live yet. Redeploy `mailbox-admin` only if it changed since live.
6. **Web app:** deploy the dealflow-app files from this commit (service worker v125). After deploy, existing installs pick up the new shell on the next open.
7. Tell the team: live report rollups recompute upward after the round-2 migration (see round 3 notes).

## 2026-11-23 round 5 of the review: design and UI (all pages, three reviewers)
No migration and no edge function this round: web app only (service worker **v126**). Fixed in shared code, not page by page:

- **One dialog helper, `js/layers.js`** (loaded by `js/auth.js`, so every signed-in page has it). It watches the page for any `.modal-backdrop`, `.fullscreen-modal`, `.ad-sheet-bd`, `.cr-panel`, `.page-header-menu`, `.cp-menu` or `.timeline-add-menu` that opens, and gives it: Esc closes the topmost one (by clicking its own Close/Cancel button, so page logic such as saving notes and the disabled-Done rule still apply; a disabled close control means "not now"), Tab stays inside the topmost dialog (menus are not trapped), focus moves in on open and returns to the opener on close (it re-finds a row the page re-drew), `role=dialog aria-modal` and an `aria-label` from the heading. A new popup only has to use one of those classes. Opt out of the Esc part with `data-esc="own"` (used for the intro-call time popup, the import wizard and Deleted tabs, which have their own Esc rules) or `data-esc="none"`. The old per-dialog Esc handlers in `adminLaunch.js` and `copyReviewScreen.js` were removed; the AI drawer now calls `preventDefault` on its own Esc so it closes alone.
- **Network failure, `js/netError.js` + `js/auth.js` + `js/supabaseClient.js`.** A failed fetch no longer sends anyone to login: `requireSession` redirects only for no session or a real auth rejection (401/403, JWT errors). A dropped connection or a busy server (5xx, PGRST002) uses the cached profile, or shows a full-page "Can't load right now" with Retry. The sign-in check has one shared ~8 s budget; the optional lookups (mailbox icon, team lead) are skipped while offline. **The supabase client now has its own short retry** (`appFetch`: reads get one quick second try after a dropped connection, up to 3 spaced tries on 503; writes never repeat) and the library's 1/2/4 s retry is off (`db.retry:false`), which is what kept skeletons up for 19-33 s. `showError(el, err, onRetry)` maps network errors to "Couldn't reach the server. Check your connection and try again." (or "You're offline" only when the browser is offline) and can add a Retry button; the offline banner says "Couldn't reach the server" unless the browser is actually offline, and has Retry. Timeline load failure is an error with Retry (never "No events yet"), Inbox list error has the same message + Retry, Profile's weekly count says "Couldn't load" instead of staying "-", and Admin's Do not email / Calendly / Email accounts errors use the same wording with Retry. Login errors use the same mapping.
- **Colour tokens (`css/style.css`).** The old saturated blue is gone: `--accent` is now the brand slate-navy (same as `--tone`). In dark mode text and fills are separate tokens so both clear 4.5:1: `--accent`/`--tone` are fills (white text 6.3:1), `--accent-text`/`--tone-text` are the light text/link colours (10.9:1), `--danger-fill` (5.4:1), `--success-fill` (5.0:1). Light-mode text tokens were darkened to AA: muted `#5b6270`, success `#167a42`, warn `#8a5a00`, danger `#c23a31`. Role badge, error boxes (`--danger-soft`), the login error box (no more inline pink), input borders in dark (`--input-border`) and the overdue callback line follow the theme.
- **`css/a11y.css`** (loaded after `style.css` on every page): one focus ring (`:focus-visible`, 2px, offset 2px, `--focus`, same in both themes and every width), 44px minimum for every button, link row, select and input at phone width or on touch (the list text/call/email icons are real 44px boxes with the 28px circle drawn inside), inline value links in cards, nav, Log out, admin controls; inputs 16px on touch; the Calls row meta wraps instead of cutting the callback time; Inbox gets bottom padding so the compose button never sits on a date; Retry and full-page error styles.
- **Layout and copy.** Campaigns: the action column is wider and the label shows the count ("Launch again 1,240", "Review 12"), stat labels wrap/shorten at tablet ("Emailed"), the action button is capped at tablet, the "Review" link is underlined, "Paused: Paused by admin" reads once, the admin tab bar fades at the edge and highlights the section being read on phones, the denied page links to Profile, the skeleton nav no longer overflows. Calls card: "Not contacted today" / "2 contacts today" instead of "x0", the status chip reads "Status: Busy, call back". Clients: rows are keyboard-reachable (Enter/Space opens), the search placeholder is "Search clients", "New seller/buyer/broker" instead of "New client", the gear item reads "Viewing: Sellers", clearer empty-state text, timeline "+" and "Did it happen?" have aria-labels, and the missing-info dialog opens the collapsed sections with missing fields and focuses the first one. **One location format**: the state is saved as the 2-letter code ("Provo, UT") by the client and Calls forms (`stateToCode` / `stateOptionsHTML`) and shown that way everywhere; old full names ("Utah") become the code the next time a form is saved. Mailbox picker badges say "unread" on hover/for screen readers and group labels are larger.
- **Resume asks first.** Resuming a campaign or a mailbox that was paused for bounces shows a confirm that states the bounce rate ("Auto-paused: bounce rate 7.2% (9 of 125 sends bounced)") with "Resume anyway" (`js/resumeConfirm.js`). A manual pause still resumes in one tap.
- **Not done (and why):** status menu order on a client (Sold first is the pipeline's own order, a product call); a timeline entry when a client's status changes (needs an event type, same as the round-3 note); making the progress stepper clickable; "Continue" label on the schedule dialog; the profile page's wide empty right half and the thread-column width (design calls); accordion chevron size, the "REQUIRED" tag baseline and Delete spacing in the phone edit form (cosmetic); stub pages' titles; owner select truncation on the Email accounts list; "Claude connected" green dot while offline (status is read from a cache; needs a staleness marker); Esc on the Add-account form (not modal); today.html fallback link (only visible if JS and the meta refresh both fail).
- **Tests (round 5):** `test_round5.py` (Esc closes every dialog type: Calls gear menu, dial card, "Connect an email first", Mailboxes popup, Clients gear, side picker, Accounts visible, client modal, timeline Meeting/Task dialogs and "+" menu, launch sheet, list details, Pause confirm, "..." menu; Tab stays inside the dial card, notice, Mailboxes popup, side picker, client modal (40 Tabs), launch sheet, details and confirm; focus returns to the opener; keyboard row open; Resume confirm states the bounce rate and resumes nothing; blocked supabase.co shows Retry and no login redirect, within 10 s, with and without a cached profile; Inbox and Timeline errors) and `test_round5_ui.py` (computed contrast in light and dark for Log in / Log out / role badge / Add account / Call buttons / avatar / text tokens, no old blue, focus ring 2px+ with offset, 375px tap targets on login, Calls list and card, Profile, Clients list/detail/edit, Inbox, Admin, launch label not clipped, tablet stat labels, phone Calls meta not cut, compose button clear of the last row, search placeholder fits, one location format, missing-info sections open). Both are in `run_all.sh`. The Campaigns checks run on mocked data and abort every send/pause/resume/launch call (zero attempts are asserted). `state_select.test.mjs` now expects the 2-letter code.
- **LIVE rollout:** nothing to run in the database. Deploy the web app from this commit (it replaces `supabaseClient.js`, `auth.js`, the CSS tokens and adds `layers.js`, `netError.js`, `resumeConfirm.js`, `css/a11y.css`); existing installs pick up service worker v126 on the next open. The round-4 "state hotfix" for LIVE's Calls edit form still applies: the new `stateOptionsHTML` keeps a stored "UT" as "UT" and saves new picks as codes.
- **TEST-only auth setting (not for LIVE):** the TEST project's auth rate limits `rate_limit_verify`, `token_refresh`, `otp` and `anonymous_users` were raised to 1000 per 5 minutes, because the browser suites do dozens of logins per run and were hitting the old 30-150 limits (logins stalled for 60 s). LIVE's limits are unchanged and must stay as they are. Other test-only changes: `test_browser.py` / `test_round5.py` now wait for the condition instead of a fixed pause, `browser_regress.login` tolerates a stalled page `load` once the address has changed, and the intro-call prefill check uses a fixed midday callback time (the app only prefills 07:00-19:00 local, so the old "current hour + 3 days 15:30" made the test depend on the time of day it ran: it was a test bug, not an app regression).
