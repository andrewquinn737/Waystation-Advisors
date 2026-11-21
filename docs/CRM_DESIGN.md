# Waystation CRM: simple + effective design (from 4 audits, 2026-11-20)

Audits run: UX simplicity (every page, every role, 375px), campaigns vs Instantly + deliverability
(incl. live DNS checks of all 19 sending domains), security + reliability (DB, functions, repo history),
Claude-pairing architecture (VM inspection + Anthropic docs/terms).

## 1. The shape of the product

| Role | Tabs | What it's for |
|---|---|---|
| Intern | **Calls** · **Inbox** · **Me** | Calls = the priority call sheet. Inbox = replies only. Me = name, today's count, log out. |
| Team lead | Calls · Inbox · **Team** · Me | Team = reports + their interns (moved out of Profile). |
| Admin | Calls · Inbox · Team · **Admin** · Me | Admin = Campaigns, Email accounts, Clients, advanced settings, behind one page. |

Intern day in 5 steps: open Calls → tap the row's one button → come back to a 5-button outcome sheet
(Talked – interested · Call back · No answer · Not interested · Wrong/dead number) → optional note/callback
→ auto-advance to the next row. Replies: Read reply → reply → Done on the same screen.

Cuts (from the UX audit): 7-option status pill → 5 outcome buttons; triangle + gear menus hidden for interns;
company card shows only filled fields with big call buttons; orphan pages (buyers, sellers, deals, finance,
today, index) and duplicate toggles (Notifications ×3, Accounts visible ×3, Sellers/Buyers ×3) removed;
Messages hides mailbox picker/banners for interns; JS bundled/minified (Dials loads 66 requests, ~946 KB).

## 2. Campaigns = "maximized Instantly", minimal

Campaign states: **Draft → Ready to review → Live → Paused / Done**. One campaign per uploaded list.
Admin flow (Admin › Campaigns): new list appears automatically → **Design** (AI builds spintax pools from
the house guidelines + the list, expands to unique per-lead copy) → **Review** (all copy; chat to refine)
→ **Launch** (mailbox pool, today's capacity, finish date, bounce guard on) → **Live** (sent, replied,
bounced, held, per mailbox; Pause button).

Spintax: generated as `{a|b|c}` pools, expanded by code, never shipped; every sentence unique across the
list and 180 days of sent mail; reviewer sees final text. Variant ids stored for A/B by reply rate.

Deliverability fixes to add: bounce auto-pause (>3% rolling per mailbox and per campaign; resume = admin),
global suppression list (unsubscribe/"stop"/"remove me" replies, bounces, manual) checked before every send,
one active sequence per address and per company domain across all lists/interns, recipient-time-zone window
(9:00-16:00 in the lead's state zone), per-domain daily cap, new-mailbox ramp (2/day +1/day), List-Unsubscribe
one-click header, weekly seed placement test. Already good: plain text, no tracking pixel, own-domain Message-ID,
threaded follow-ups, MillionVerifier before first send, 4-9 min gaps, 20/mailbox/day.
DNS: all 19 domains pass SPF + DMARC + DKIM CNAME (Waystation domains use DMARC p=reject).
Warm-up: nothing in the CRM warms mailboxes once Instantly is off (decision below).

## 3. Email accounts in Settings (admin) + API port

Admin › Email accounts: list grouped by person; add one (email + password; provider auto-detected; verify
button), assign by full name automatically, pause/limit per mailbox. The API port = `mailbox-admin`
(bulk add/assign/update/remove by API key) with fixes: hashed key + rotate + audit log + rate limit, no
host change without a password, private IPs blocked. Docs: docs/MAILBOX_ADMIN_API.md.

## 4. Claude pairing (admin onboarding)

Anthropic's terms (verified on code.claude.com legal page): a product should use API keys; it may not store
users' Claude credentials or route requests through Free/Pro/Max plans on behalf of users. So:
- **Stage 1 (now, terms-safe):** onboarding wizard for every new admin: "Connect your Claude" → personal
  connector link → Claude Settings › Connectors › Add → Test connection. Campaign design + review chat happen in
  the admin's own Claude app with the CRM's tools; the CRM shows the campaign and the Launch button. No tokens stored.
- **Stage 2 (in-page chat, optional):** a worker on the Oracle VM running Claude Code under the OWNER's token only
  (env file on the VM, never in the database), chat streamed into the CRM. Only after confirming with Anthropic
  that this use is allowed. VM: 1 vCPU / 6 GB, no Claude CLI yet; concurrency 2.

## 5. Security fixes required before anything goes live (from the audit)

High: (1) sequence RPCs callable by anonymous users and guards that pass on a NULL user → revoke from anon +
null-safe guards; (2) mailbox-admin can send a stored password to a new host → require password on host change,
allowlist hosts; (3) API key hardening; (4) possible duplicate send after a timeout → mark "unknown", never
auto-retry, check Message-ID; (5) no suppression/dedup → as in §2.
Medium: connector-saved copy auto-joins an approved list without re-approval; plaintext mailbox passwords
(move to Supabase Vault); header injection (CR/LF) in email-send; pause a mailbox on SMTP auth failure; deleting a
list must cancel queued sends; block private hosts. Live-only: hardcoded secrets in DB functions/cron, anon
access to wp_* tables and some utility functions.
