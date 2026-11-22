# LIVE USAGE MAP (read-only analysis, 2026-11-21)

Source: live Supabase via `tools/testenv/sb.py live_sql` (read-only) + `origin/main` code. Aggregates only.
Window: `calls`/`call_lines` start 2026-10-19 (in-app telephony launch); `call_status_changes` (CSC), `dials`,
`dial_lists`, `clients` go back to Jun-Jul. Times ET. 30 profiles: 18 intern, 7 independent_lead (IL), 3 team_lead (TL), 2 admin.
Caller base: 23 users made in-app calls (15 interns, 6 IL, 2 TL); 15 active in the last week. Admins made 0 in-app calls.

**Key caveat:** `calls.call_outcome`, `contact_status_after`, `callback_at`, `call_notes`, `owner_verified`, `success_type`
are 100% NULL on all 4,836 calls. The outcome lives only on `dials.contact_status` and CSC (`contact_status_at_call`, rewritten
same-day by `syncTodaysCallLogSnapshot`). CSC `changed_at` = call START (row inserted by `autoMarkContacted`), NOT outcome time.
`dials.updated_at` is not bumped by status edits (97% show created_at date = updated_at date). So call-to-outcome latency is unknowable.

## 1. Role workflows (ordered, with observed frequency)

### Intern (15 callers; 125 caller-days)
1. Open Dials, pick a tab (list) that a lead transferred (`dial_transfer` notification; 56 to interns) - `loadLists`, `renderTabs`.
2. Click a row, dial modal opens - `openDialModal`, `renderDialModal`. Next/prev with `goToDial`.
3. Tap mobile or company call icon - `.contact-action-call` -> `placeCall` -> `startCall` (callSession.js:44) -> `calls` insert + `autoMarkContacted` (CSC row).
4. Talk; live transcript lines stream (`callTranscript.js`); type call notes (`wireCallNotesAutosave`/`flushCallNotes`).
5. Hang up, pick a category (`updateDialStatus`, dials.js:3222). Intern mix: no_response 60%, not_interested 12%, unable 10%, busy_callback 7%, callback_interested 2%, intro_call_scheduled 1.3%.
6. On a yes: "Schedule intro call" -> Calendly / `openIntroCallTimeConfirmModal` -> client + `client_events` + `intro_call_log`.
7. Repeat. Rate: 19.8 calls per caller-day (median 20, p90 51); sessions (30-min gap rule) median 15 calls / 19 min, about 51 calls/hr; about 1 session/day.
Frequency: median caller active 7 of ~25 weekdays; 1,490 of 2,240 called dials got 2+ attempts, 224 got 4+.

### Independent lead (6 callers, 38 caller-days)
Same as intern but owns 15 lists, cannot import (gated `isAdmin||isTeamLead`, dials.js:338). 29.1 calls/day, session median 22 calls / 26 min. Also logs intro calls directly (2) and "Intro completed during outreach".

### Team lead (2 callers + 1 non-caller, 28 caller-days)
1. Import CSV(s) into a new tab: `menuImportBtn` -> `openImportDialsModal` -> dropzone -> `parseCSV`/`buildHeaderFieldMap`/`rowsToDials` -> `dial_lists` + `dials` insert (dials.js:~1990-2030).
2. Attach buyer (`populateBuyerSelect`), then Transfer tab to an intern (`openTransferMenu`/`completeTransfer`, RPC `transfer_dial_list`) - 118 transfer notifications total (27 to TLs, 19 to admins).
3. Dial heavily themselves: 44.8 calls/caller-day, session median 19 calls / 37 min (p90 122 min), 5,343 of 10,446 dials live in TL-owned tabs.
4. Watch Profile calls-view/graph, Reports popup (`wireReportsPopup`), client Timeline; confirm intro calls; team accounts (profile.js team cards).

### Admin (2 users)
No in-app calls. Creates tabs (34 lists, 11 deleted/trashed), imports, transfers (19 received), manages accounts (`admin-create-account`, profile.js:1730), reads Reports. Largest import day: 09-14 2,232 rows.

## 2. Pipeline volumes (live totals)
10,446 dials in 151 tabs (118 current, 33 archived, 21 trashed). 4,738 dials worked (45%), 5,708 never touched. Funnel on worked dials: no_response 2,699 / not_interested 1,069 / unable 497 / busy_callback 242 / callback_interested 124 / intro_call_scheduled 107 (2.3%). 111 clients (56 from a dial), 98 intro_call_log, 90 intro_call events, 39 confirmed, 7 contracts.

## 3. Top 20 actions ranked (count since Oct 19 unless noted) and UI path
| # | Action | Count | Code path |
|---|---|---|---|
| 1 | Place in-app/native call | 4,836 (~1,000/wk) | callSession.js `startCall`; dials.js `placeCall` |
| 2 | Contact marker (CSC row) | 4,401 | dials.js `autoMarkContacted` :908 |
| 3 | Live transcript lines | 24,901 lines / 2,107 calls | callTranscript.js `startTranscript`, deepgram-token fn |
| 4 | Pick call category | ~4,700 worked dials | dials.js `updateDialStatus` :3222 |
| 5 | Call notes autosave | 3,561 dials w/ notes | `flushCallNotes` :1079 |
| 6 | Call summary (AI) | 1,261 | call-summary fn via callSession.js:209 |
| 7 | Native-dialer fallback | 885 (18%) | callSession.js:245 `mic_denied` -> `dialViaPhone` |
| 8 | Next/prev dial | not logged | `goToDial` :3396 |
| 9 | Transfer tab | 118 | `completeTransfer` :1375 |
| 10 | Create tab + CSV import | 151 tabs; 88 import minutes | `createNewList`:1785, import :1905-2030 |
| 11 | Intro call booking | 98 log / 90 events | `handleScheduleIntroCallFromDial`:3544, introCall.js |
| 12 | Create client from dial | 56 | `createClientRecordFromDial`:3605 |
| 13 | Upcoming-event notification | 94 | pg_cron `run_daily_event_notifications` |
| 14 | Inbound call to owner number | 60 (25 answered) | telnyx-webhook; `callback_tasks` |
| 15 | Set callback time | 32 dials | `openCallbackModal`:2920 |
| 16 | Inbound email synced | 73 | email-sync; messages.js |
| 17 | Send email (compose/quick send) | 33 out | messages.js:1039 `email-send`; quickSend.js |
| 18 | Archive / trash tab | 33 / 21 | `setListArchived`:1685, `trash_dial_list` |
| 19 | Confirm intro completed | 39 | `set_client_event_confirmed` (clients.js:2189, dials.js:3958) |
| 20 | Mass-schedule email | 12 (one 3-day window, Sep 25-28) | dials.js `planMassEmail`:2372, `scheduled_emails` |

Peak: Fri 28%, Thu 24%, Wed 20%; hours 11:00-14:59 ET = 67% of calls; Sat 2%.

## 4. Rarely / never used (candidates to hide)
- Never: `deals`, `buyers`, `sellers`, `commissions`, `subscription_payments` (0 rows) -> deals/finance/buyers/sellers pages. `autodial_enabled` 0/30. `linkedin_touches` 2 pending rows (Oct 19 only), `linkedin_template` 0/30. `about_us_email` 0/30. `survey_responses` 2.
- Rare: scheduled mass email 12 rows ever (none since Sep 28); `dials.email_1/email_2` 146 dials; `contacted_email_date` 7; personalized email 1 intern, texting 2; `intake_form` 15; callback_at 32 dials; callback_tasks 10; recordings 28 (policy keeps only intro-booked); waproject (wp_dials 500, wp_lists 3) and sourcing tabs (2 tabs/80 rows) are side apps.
- Dead columns on `calls` (outcome, notes, callback, owner_verified, success_type, number_type, list_source, email_seq_step): all NULL.
- Notifications: 0 of 284 ever marked read (only `read=false` exists), so read-state UI cannot be judged.

## 5. Pain points with evidence
1. Mic permission denied: 885 calls (18%; 15 of 23 callers) fall to native dialer = no transcript/recording; worsened to 30% in week of 11-09.
2. Recording consent skips: all_party_state 950 + area_code_all_party 99 = 22% of calls get no transcript by design.
3. STT failure: 269 answered calls with zero lines (stt_failed); week of 11-09 = 71.
4. Summaries missing: 846 of 2,107 transcribed calls (40%) have none; 25 are >=30 s.
5. "Answered" overstated: 47% of answered mobile calls <10 s (voicemail/carrier pickup); avg mobile 29 s vs company 71 s.
6. Calls without outcome: 143 of 3,275 answered calls (4%) left the dial `uncontacted`, 13 of them >=30 s.
7. Callbacks: 349 of 366 busy_callback/callback_interested dials (95%) have no `callback_at`; of 25 past-due callbacks, 11 still sit in callback status and 6 saw no call after due date. callback_tasks: 4 still open at escalation 2; done ones took median 7.6 days.
8. Inbound: 60 calls, only 7 answered by a person (12 rejected, 4 abandoned, 2 voicemail), 26 unmatched to any outbound. 14+2 escalation/missed notifications.
9. Intro calls: 34 of 90 backdated (logged after the fact); 49 past-due unconfirmed; 0 of 21 intro events dated Nov 2-16 confirmed (vs 8 of 19 in Oct 19-Nov 1). 107 dials marked intro_call_scheduled but only 58 have a client record.
10. Imports idle: of 54 seller tabs created since Oct 19, 14 never called, 11 totally untouched, 5 empty; median 45 h (p90 170 h) from tab creation to first call. 39 of 143 lists with rows never worked; 43 under 10% worked.
11. Email: only 6 mailboxes (all TL), 0 sync errors; sending in CRM is marginal, outbound prospecting is elsewhere.
12. No-answer share is huge: no_response is 57% of worked dials; 568 called dials never answered.

## 6. Test script per stage (replay on test build with real data; check against the live baseline)
**Importing** (TL/admin): import a real 2,000+ row CSV with odd headers (Status, Phone, LinkedIn, State full names); expect `buildHeaderFieldMap` + `normalizeStateValue`, buyer select, 1 `dial_lists` + N `dials`, count matches. Import 3 CSVs at once (tab per file name). Then Transfer to an intern (notification `dial_transfer` arrives, tab appears, owner changes, `created_by` follow), archive, trash, restore from deletedTabs. Intern must NOT see Import. Reproduce: empty file, duplicate tab name, 10k rows (live max 2,007).
**Email sending**: connect a mailbox, Messages sync (inbound threads appear, unread count), reply from a thread, quick send from a dial email icon, mass email via `planMassEmail` to 20 dials (quota, staggered times, cancel pending, `scheduled_emails` -> sent), follow-up detection (`followUp.js`). Verify no send occurs on test with real recipients (test mailbox only).
**Calling**: 3 intern sessions of 15+ calls each (company and mobile), 10 answered, 5 voicemail, 3 hang-ups before ring; deny mic once (expect native fallback + `skip_reason=mic_denied` + contact still logged on return); run a call in an all-party state (expect no transcript); hang up and set each of 7 categories; back-to-back next dial; autodial off. Verify one `calls` row, one CSC row/dial/day, status mirrored by `sync_latest_call_status`, recording kept only for intro_call_scheduled (or record_all rules).
**Transcripts**: answered call >=60 s: lines appear live, speakers owner/intern, summary within ~53 s (live median, p90 85 s), shows under dial Transcript; call with STT failure shows reason; recording signed URL plays/downloads/share link; delete via status change (`discardRecordingsForDial`).
**Tracking** (status, notes, callbacks): edit notes then immediately click category (race fixed in :3225); set callback_at on busy_callback, check banner (`callbackBanners.js`), reminder notification at due time, call-back by inbound match; callback_tasks escalation and claim; hide-status filter; search by phone.
**Reporting**: Profile calls-view (outreach/graph quota), Reports popup per buyer/week/month vs `report_dial_rollups` (374 rows, nightly), PDF export; counts must equal CSC distinct contacts; compare a known user-week (e.g. intern 20 calls/day x 5) between live and test.
**Intro call scheduling**: dial -> Accepted intro call; missing-fields popup; Calendly widget (own link vs team link); time-confirm modal with timezone; same-day booking (live median lead 0.8 day, 34 backdated); "Intro completed during outreach" (TL/IL/admin only); questionnaire flow (`isQuestionnaireDial`); creates client + `client_events` intro_call + `intro_call_log`; recording saved; upcoming_event notification; Timeline confirm (`set_client_event_confirmed`); contract_signed flow.

## 7. What cannot be known without click tracking
Page views/time on page (Reports, Messages, Clients, Profile), whether a dial modal was opened without a call, next/prev usage, search/filter/sort use, status-edit time and who changed it after the fact, abandoned modals (import dialog opened and cancelled, intro form dismissed), failed CSV parses client-side, tab switches, errors shown (`showError`/`showNotice`), feature discovery (hidden menus), time between hang-up and category, login frequency (`auth.users.last_sign_in_at` only reflects token refresh, so 0 interns show in last 7 days despite 15 callers), device/PWA vs desktop, notification opens (`read` never set), report/CSV export clicks.

## 8. Proposal (not implemented): minimal privacy-safe event tracker for live
- Table `ui_events(id, user_id uuid, role text, page text, event text, props jsonb, at timestamptz default now(), session_id text)`, RLS: insert own rows, select admin only. 90-day retention via pg_cron.
- Client helper `track(event, props)` (about 30 lines, `supabaseClient.js`): batches in memory, flushes every 20 s or on `pagehide` via one insert; `session_id` = random per tab, rotates after 30 min idle; try/catch, never blocks UI, no-op if offline.
- Allowlisted events only: `page_view`, `dial_open`, `dial_nav`, `call_click`, `status_set`(status value), `import_open/import_submit/import_cancel`(row count, error code), `transfer`, `intro_open/intro_submit/intro_cancel`, `report_open`(type), `email_compose/send`, `error_shown`(code). No names, phones, emails, company, notes, transcript text, URLs with ids; props limited to counts, enum values, durations in ms, ids hashed server-side.
- Dashboard: SQL view of users x day x event, funnel (call -> status delay, import open -> submit), mic-denied rate by device. Add an in-app Settings note and a per-user opt-out flag in `profiles`.
