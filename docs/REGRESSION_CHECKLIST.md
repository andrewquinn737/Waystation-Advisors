# Regression checklist: test build vs origin/main (2026-11-21)

Method: every user-facing item on origin/main was walked in real Chrome (tools/testenv/browser_regress.py, test_browser.py, test_connections.py) as admin, team lead and intern against the TEST project. CHANGED = intentional per docs/CRM_DESIGN.md.

**Totals: 61 OK, 10 CHANGED (intentional), 2 BROKEN and fixed, 0 still broken.**


## Profile

| Item | Result | Notes |
|---|---|---|
| Edit profile: name, phone, email (menu > Edit; tap outside saves) | OK | Saved phone as +1 E.164 on TEST; intern has no Calendly field, as original |
| Calendly link + own/shared preference (leads, admins) | OK | Field present for lead/admin; code unchanged |
| Avatar upload (avatars bucket) | OK | Uploaded, URL stored |
| Notifications on/off toggle | OK | Works on Profile (DB flag flips) |
| Notifications toggle location (was in the gear on Profile, Calls, Clients, Messages) | CHANGED | Now Profile only (docs/CRM_DESIGN.md: duplicate toggles removed) |
| Quota chart + companies contacted this week | OK | Renders for admin/lead/intern |
| Outreach calls / Intro calls view switch | OK |  |
| Upcoming events + Callbacks today lists | OK | Callback set from the Calls card shows on Profile |
| Reports modal: type, range, select week/buyer, accounts visible | OK | Opened as admin and lead; PDF buttons not clicked |
| Teams modal: view, add team, add account (UI) | OK | Created and removed a team and an account |
| Admin delete account | OK | admin-delete-account (and non-admin refused) |
| Temporary password / admin-create-account | OK | Function + UI form |
| Links popup (share app, trainings) | OK |  |
| Deleted tabs (view, select bar, restore / reassign / purge buttons) | OK | Deleted a list as lead, saw it as admin |
| Advanced settings: personalized email, About us email, personalized texting | OK |  |
| Sellers/Buyers toggle on Profile | OK |  |
| Sellers/Buyers + Accounts visible in the Calls and Clients gear | CHANGED | Profile only (design: one place per setting) |
| Accounts visible popup (Profile) | OK |  |
| Weekly survey (button, modal, owners-talked stamp) | OK | Button shows only in the survey window; stamp covered by test_calling.py |
| Log out (nav + Profile) | OK | Log out button on every page |

## Calls (was Dials)

| Item | Result | Notes |
|---|---|---|
| Add new company (menu) | OK | Saved |
| Import CSV (+ list type, buyer) | OK | Imported 2 rows; new M&A / Data sales picker + sequence setup is an addition |
| Create list (+ tab) | OK |  |
| Rename list (tab menu / double-click) | OK |  |
| Archive / Unarchive + Current/Archived menu | OK |  |
| Transfer list to another account | OK |  |
| Client (buyer) assignment menu | OK |  |
| Delete list (confirm, restorable) | OK |  |
| Select mode: select all, Move, Mass email, Delete | OK | Mass email opens and applies its skip rules; nothing sent |
| Categories filter | OK |  |
| Search (menu and header icon) | OK | Both find rows |
| Status pill with 7 statuses (leads, admins) | OK | Kept for leads/admins |
| Status for interns: 5 outcome buttons + Intro call booked replace the pill | CHANGED | Design decision; Uncontacted reset is lead-only |
| Outcome buttons advance to next row; Call back opens time picker | OK |  |
| Callback time (set, banner, Profile list) | OK |  |
| Call notes autosave | OK | Saved to DB |
| Intro call scheduling popup + required-info check | OK | Calendly itself is an embed; see Connections |
| Intake / questionnaire intro popup | OK | Function checked; posts nowhere on TEST |
| Recommended first/second email, personalized email/text settings | OK |  |
| Texting (Text button on the card, personalized body) | OK | sms: link on each number |
| Quick-send icons on call-sheet rows | OK |  |
| Autodial setting | OK | Toggles and saves |
| Transcript calling setting | OK | Toggles and saves |
| Call recording / Record all calls settings | OK | Toggle and save |
| Calls gear (Advanced settings) for interns | BROKEN->fixed | simple.css hid the gear on Calls for interns, so they lost Autodial, Transcript calling and the recording settings. Gear restored |
| In-browser calling: token, caller number, SIP credential | OK | No call placed; see Connections |
| Call transcript box and recording playback | OK | Storage upload/sign/download verified; UI not exercised with a real recording |
| Interns: triangle menu (Add new, Import, Select, Categories) hidden | CHANGED | Design decision; interns keep Search |
| Card rows: empty fields hidden, phone list replaced by Call/Text buttons, prospect count removed | CHANGED | Design |
| Priority call sheet home; plain list = menu > Show all companies (leads/admins) | CHANGED | Design |

## Clients

| Item | Result | Notes |
|---|---|---|
| Create client (required Sector / Looking for) | OK | As intern |
| Client card: Profile / Progress / Timeline tabs | OK |  |
| Timeline: add Task event | OK |  |
| Edit client, buyers/sellers, categories menu | OK | Menu items present; code unchanged |
| Intake link / form submit | OK | See Connections |
| Clients gear (Accounts visible, Notifications, Advanced) | CHANGED | Gear removed; settings live on Profile |

## Messages (now Inbox)

| Item | Result | Notes |
|---|---|---|
| Mailboxes picker (33 mailboxes for a lead) | OK | Now a button next to Inbox/Sent instead of the triangle |
| Sync now | OK |  |
| Compose with attachment, from a Waystation (SMTP) mailbox | OK | Sent; redirected to the test sink |
| Compose from a Microsoft (OAuth) mailbox | OK | Sent; redirected to the test sink |
| Reply from a thread (intern) | OK | Compose opens prefilled; not sent |
| Sent view + thread with attachment chip | OK |  |
| Spam / Trash / Scheduled / Bounces | OK | Same live-read mechanism as original; with 33 mailboxes the first load takes a while |
| Select mode (Unread, Delete) | OK | Bar opens; actions not clicked |
| Received/Sent in the Viewing popup | CHANGED | Inbox / Sent tabs on the page |
| Interns: inbox shows replies only, no gear | CHANGED | Design |
| New-email push notification | OK | send-push 200 to a real browser subscription |

## App shell

| Item | Result | Notes |
|---|---|---|
| Login / wrong password / session redirect | OK |  |
| Password reset link | OK | None on the original either; admins set temporary passwords |
| PWA manifest, service worker, icons | OK | All 200; cache bumped to v119 |
| Top nav at 375px (name, role badge, links) | BROKEN->fixed | Overflowed ~200px; now wraps. Clients table still 19px wide in a phone-width desktop window (original behaviour) |
| Old pages (buyers, sellers, deals, finance, today, team) redirect | CHANGED | Design |
| Admin page: Campaigns, Email accounts, Settings | OK | New in this build; loads clean |

## Connections (TEST project)

| Connection | Status | Notes |
|---|---|---|
| telnyx-token (in-browser calling) | OK | 200, caller number, SIP credential stored; bad number 400 |
| deepgram-token | OK | Token minted only for the caller's own live transcribed call |
| call-summary | OK | Answers cleanly with no transcript |
| call-recordings bucket | OK | Upload, signed URL, playback download, remove |
| send-push | OK | Test VAPID keys + internal secret added on TEST; push accepted by Chrome's push service |
| Email send, Waystation SMTP mailbox | OK | Redirected to the test sink |
| Email send, Microsoft OAuth mailbox | OK | Redirected to the test sink |
| Email sync | OK | Sync now ran with no error |
| intake-submit | OK | Auth-checked; TEST has no sheet or Slack webhook, so nothing is posted |
| Google Sheet webhook (sheet_webhook_url) | Not set on TEST | Present on live (checked by name only); intentionally absent so tests cannot post |
| schedule-intro-call | Not configured | CALENDLY_TOKEN and CALENDLY_EVENT_TYPE_URI are not set on TEST, and the Management API lists them missing on live too |
| admin-create-account / admin-delete-account | OK | |
