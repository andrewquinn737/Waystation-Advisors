# Deliverability: why Microsoft 365 recipients junked our mail, and what to do

Written 2026-11-22 from real headers (not guesses). Data: the 57-mailbox campaign on TEST (every one of our mailboxes sent one
email to another of our mailboxes). 42 messages were readable in the recipient mailboxes: 25 Inbox, 17 Junk. Every Junk was at a
Microsoft 365 recipient. Gmail and the other test inboxes: 0 junk.

## 1. What the headers say

Pulled with the new `email-live` action `headers` (raw header block of any message in a mailbox we can read over IMAP).

| Check | Result on all 17 junked messages |
|---|---|
| SPF (`Authentication-Results`) | pass, sender IP is Microsoft's outbound pool, `smtp.mailfrom` = our own domain |
| DKIM | pass, `DKIM-Signature d=<our own domain> s=selector1` (so DKIM is already enabled per domain, not the `onmicrosoft.com` fallback) |
| DMARC | pass, aligned (`header.from` = DKIM d= = mailfrom) |
| compauth | pass, reason 100 |
| ARC | pass (i=1 sender tenant, i=2 recipient tenant) |
| Message-ID | `<uuid@sender-domain>` (own domain, good) |
| Format | `text/plain; charset=utf-8`, no HTML, no images, no links, no tracking |
| Sender tenant verdict (i=1, `X-Forefront-Antispam-Report-Untrusted`) | `SCL:1 SFV:NSPM` (not spam) |
| Recipient tenant verdict | `SCL:5 SFV:SPM CAT:SPM`, `X-Microsoft-Antispam-Mailbox-Delivery: ... OFR:SpamFilterAuthJ ... RF:JunkEmail` |
| Inboxed messages | `SCL:1 SFV:NSPM CAT:NONE` |

Reading: authentication is perfect and the sender tenant itself scored the message clean. The recipient tenant's content/reputation
filter (SFV:SPM, SCL 5, "SpamFilterAuthJ" = junk by the spam filter, not by a transport rule or an allow/block list) is what moved it.
No BCL, no phishing verdict, no impersonation flag (`CAT:SPM`, not `CAT:PHSH`/`IMPOSTOR`). So this is Microsoft's reputation
model for "new tenants and new domains sending to other tenants", not a DNS or formatting defect.

Patterns in the 42 readable messages:

- It is tenant driven, not message driven. Recipient tenants that took 0 of N into Inbox: wsignalbroker.com (0/3),
  workingsignalai.com (0/3), working-signal.com (0/3), working-signals.com (0/1), working-signal-ai.com (0/1). The two older
  Waystation tenants and 8 other Working Signal tenants took every message into Inbox. Same copy, same format.
- Sender side: working-signal-sale.com (0/3 inboxed), workingsignals.com (0/3), working-signal-sales.com (0/2), workingsignalsale.com
  (1/3), workingsignalsales.com (1/3). Most of these are the tenants that already showed 5.7.708 (high-risk delivery pool)
  rejections in the Nov 13-14 warm-up (see memory note `working_signal_mailboxes_deliverability`).
- All 17 are first emails (step 1), body is ordinary prose. The test copy itself was templated (`Inbox check N from <domain>`,
  "please reply with a single word"), which Microsoft's content model reads as test/bulk traffic. That content is not what
  production sends, so the placement numbers are a pessimistic read of production copy, but they are a fair read of tenant reputation.
- Burst effect: 57 mails from 17 brand-new tenants into the same 17 tenants inside a few minutes, no prior two-way history.

Root cause (ranked):

1. **New GoDaddy M365 tenants and new domains have no sending reputation**, and mail between them is judged by the recipient tenant's
   filter with nothing to vouch for it. This is the dominant cause (tenant-side).
2. **Cold, templated, low-engagement mail into Microsoft** (no replies, no prior thread). Engagement is a ranking input.
3. **App-side fingerprints that make it worse and cost nothing to remove** (fixed, section 2).

## 2. App-side fixes (shipped in this change)

`email-send` (queue path = sequences / scheduled mail):

| Fix | Why |
|---|---|
| No `List-Unsubscribe` header on 1:1 sequence mail (kept on other bulk/mass sends) | A mailto List-Unsubscribe is a bulk-mail marker for Exchange Online, and our doctrine (cold-email skill) is no unsubscribe fingerprint on cold mail. Opt-outs are handled by reply detection + the suppression list (`reply_wants_stop`, `is_suppressed`). |
| `Content-Transfer-Encoding` always declared (7bit for ASCII, base64 for anything else) | The body was sent with no encoding declared even when it held non-ASCII characters (smart quotes, accents). Undeclared 8-bit text is a classic filter signal and can garble. |
| `To:` carries the recipient's name (`Dana Tester <dana@...>`) | A bare `<addr>` To header reads like a bulk list. Real 1:1 mail has the name. |
| Per-recipient-provider pacing for Microsoft-hosted recipients | New `recipient_domains` cache (MX lookup, 30 days) + `recipient_pacing()`: a sender mailbox sends at most `ms_daily_cap` (default 8) per 24 h to Microsoft-hosted recipients, and a sending domain waits at least `ms_gap_minutes` (default 10) between two such sends. A deferred row goes back to `pending` with a later `send_at` (nothing lost, no failure). Tune in `app_secrets`. |
| New-mailbox ramp (already present, kept) | `email_accounts.ramp_start`: cap = 2 + 1 per day since the ramp start, hard max 20/day, 4-9 min spacing, per-sending-domain cap 60/day. Set `ramp_start` to today on every mailbox that has not sent real mail before. |
| Already good, unchanged | Plain text only, own-domain Message-ID, no tracking pixel or links, SPF/DKIM/DMARC pass, threaded follow-ups (verified, see test result), CRLF header-injection guard, suppression list, bounce auto-pause, 20/day cap. |

Not done on purpose: RFC 8058 one-click unsubscribe (no https endpoint exists; sending the Post header without one is worse).

## 3. Tenant-side actions for Mason (the app cannot do these)

Do these in each of the 17 Working Signal tenants (one GoDaddy M365 tenant per domain).

1. **DKIM** is already signing with each domain's own selector (`selector1` seen in every header), so nothing to do. If a new domain is
   added: Microsoft 365 Defender > Email & collaboration > Policies & rules > Threat policies > Email authentication settings > DKIM >
   select the domain > **Sign messages for this domain with DKIM signatures: On**; publish the two CNAMEs `selector1._domainkey` and
   `selector2._domainkey` it shows.
2. **Warm-up, two-way, for at least 14 days** before real volume (memory note: Instantly warm-up stays on for the mailboxes, 1 more per
   day, at most 15). The app does not warm mailboxes. Replies are what move Microsoft's model: aim for 40-80 percent reply rate in warm-up.
   Include warm-up pairs that cross tenants and also go to a few older Waystation and Gmail addresses.
3. **Seed the recipient side**: from each Microsoft test recipient, mark one message "Not junk" (OWA: Junk Email > select > Not junk
   untick "Safe senders" if you want an unbiased test), or better for production just reply to it. Do not add our domains to
   Safe Senders in the tenants we use to measure placement, it hides the real result.
4. **Check the high-risk delivery pool**: the 7 tenants with 5.7.708 (working-signal-sale, workingsignalsale, working-signal-ai,
   workingsignalbroker, workingsignalsales, wsignalsales, working-signal-data). In each: Microsoft 365 Defender > Email & collaboration >
   Review > Restricted entities (a mailbox sitting there is blocked from sending), and the Exchange admin center > Mail flow > Message
   trace for 5.7.708 bounces. Keep these at the lower warm-up limit (8) and use them last. If a tenant keeps 5.7.708 after 30 days,
   retire the domain.
5. **Do not let M365 outbound spam policy auto-forward / external recipient limit trip**: Defender > Policies > Anti-spam > Outbound
   spam filter policy: leave the default 500 recipients/day limits; do not set "Automatic forwarding" to On.
6. **DMARC**: the Working Signal domains publish p=quarantine (matches the cold-email doctrine); keep it. Waystation's own domains are
   p=reject, fine for mail from real humans, do not use them for cold sends.
7. **Weekly seed test** (the app-side placement check): run `tools/testenv/mailbox_campaign.py setup`, wait for the sends, then read the
   result with `email-live` (`list` for `inbox` and `spam`, then `headers`). Read it per provider, not in aggregate: 0 percent junk
   at Gmail and 30-40 percent at Microsoft tells you the fix is warm-up, not copy.
8. **Distribution rule while placement is poor**: route first emails to Microsoft-hosted recipients through the tenants that inboxed
   best (older tenants and the ones with 0 junk above), and keep the rest of the pool for Google-hosted recipients until the junk rate
   at Microsoft is under 20 percent in a clean seed test.

## 4. How to diagnose a junked message yourself

`email-live` (admin or the mailbox owner), body `{ "action": "headers", "account_id": "<recipient mailbox id>", "kind": "spam" | "inbox", "uid": <uid from action list> }`.
Look at: `Authentication-Results` (spf/dkim/dmarc/compauth), `X-Forefront-Antispam-Report` (SCL, SFV: NSPM clean, SPM spam, HSPM high
confidence spam; CAT: SPM/PHSH/IMPOSTOR/BULK), `X-Microsoft-Antispam-Mailbox-Delivery` (`dest:J` + `OFR:SpamFilterAuthJ` = junked by
the spam filter, `OFR:CustomRules` = a transport/inbox rule), and the first-hop `X-Forefront-Antispam-Report-Untrusted` for the
sender tenant's own verdict.

## 5. Threading + stop-on-reply: controlled test result (2026-11-22, TEST project, real mail)

Script: `tools/testenv/test_thread_reply_stop.py` (about 30 minutes, sends real mail between our own mailboxes only; not part of
`run_all.sh`). 3 sender mailboxes (analyst@working-signal.com, associate@working-signal-ai.com, analyst@wsignalsales.com) to 3 distinct
recipient mailboxes that are not senders in the test (analyst@working-signal-broker.com, director@working-signal-sale.com,
associate@wsignalsales.com) plus the Gmail sink masonquinn10@gmail.com. `test_send_now` on, `TEST_REDIRECT_TO` widened to the 6 mailboxes
for the run, other approved lists paused, other owner mailboxes paused; all restored at the end (redirect back to Mason's 5 inboxes,
flag back to false, sequence cron off, 0 pending sends).

| Check | Result |
|---|---|
| Email 1 sent from each pinned mailbox through the real queue (spacing 4-9 min) | 4 of 4 sent, all in Inbox at the Microsoft recipients |
| Follow-up due date set to today, dispatcher ran, follow-up sent from the same mailbox | 3 of 3 sent (the 4th lead had replied) |
| Follow-up is in the same thread: `In-Reply-To` = email 1 `Message-ID`, `References` = same, subject `Re: <subject>` | Confirmed from the raw headers in both recipient mailboxes (director@working-signal-sale.com, associate@wsignalsales.com); stored `thread_id` is the same for email 1 and email 2 on all three |
| Gmail conversation view for the sink | Not verified: the Gmail connector available in this session could not see that inbox. The headers above are what Gmail uses to thread (RFC 5322 In-Reply-To/References plus matching subject), so it should thread; look at the two "Gmail... Sink Co" messages in masonquinn10@gmail.com once to close this |
| Real reply from recipient 1 (sent from its own mailbox via email-send with `in_reply_to`), picked up by email-sync in the sender's inbox | Inbound row landed in email 1's thread, `seq_state` became `replied` |
| Lead 1 follow-up | Task `cancelled`, no follow-up email was ever queued or sent (0 outbound rows) |
| Reply task | Created (`kind=reply`, pending, due in 2 business days) |
| New headers on the wire | No `List-Unsubscribe` on sequence mail, `Content-Transfer-Encoding: 7bit`, `To: Morgan Tester <addr>` |

Setup note found by the test: a lead whose address or company is already in another active sequence is moved to backup
("another active sequence already covers this address or company"). Earlier test campaigns left active leads on the same domains;
the test completes those first.

## 6. Open items

- A/B of the app-side changes against the Microsoft Junk rate needs a fresh 57-mailbox run once the tenants are warmed; with 17 junk
  placements out of 42 the numbers from one burst are not enough to attribute a change to header tweaks. The tenant-side items in
  section 3 are what move placement.
- `ramp_start` is only set when somebody sets it. Make setting it part of adding a mailbox (mailbox-admin / Admin > Email accounts).
- Live rollout: migrations 20261130 (deliverability) and 20261130b (revoke public execute), functions email-send and email-live.
