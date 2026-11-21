# Hardening (migration 20261124_hardening.sql + edge functions), build A

Applies to the TEST project first. Tests: `tools/testenv/test_hardening.py` (in `run_all.sh`).

## What changed
- **Anonymous access.** `execute` revoked from `public` and `anon` on every SECURITY DEFINER function in `public`
  (authenticated keeps what it had; `service_role` always). Kept for anon: the boolean RLS predicates (`is_admin`,
  `is_team_lead`, `is_team_lead_of`, `my_team_ids`, `has_sourcing_access`) and `wp_key_ok` (policy helper of the wp_* tables,
  a live-only item). Default privileges no longer grant `anon` execute on new functions. Guards in the sequence RPCs and
  `trash_dial_list` are `auth.uid() is null or not coalesce(check, false) -> raise`.
  Other definer functions that still use the old `not (auth.uid() = x or is_admin())` pattern are unreachable by anon now;
  rewrite them when next touched.
- **mailbox-admin.** API key stored as SHA-256 (`app_secrets.mailbox_admin_api_key_hash`; plaintext row deleted); `rotate_api_key`
  (admin JWT only) returns the new key once; `get_api_key` can no longer show a key. Host/port change needs the password in the
  same request. Hosts must be on the allowlist (built-in: outlook.office365.com, smtp.office365.com, imap.gmail.com, smtp.gmail.com,
  inbound.winnr-app.com, inbound.gowinnr.com; more via `app_secrets.mailbox_host_allowlist`, comma separated) and never resolve to a
  private address (also checked again at connect time in email-send / email-sync / email-live). Audit table `mailbox_admin_audit`
  (actor, action, target, at, ip). 60 calls / 10 min per key or user (429). New actions: `check_login` (IMAP+SMTP login with the
  stored password, nothing sent), `rotate_api_key`, `update` accepts `ramp_start`.
  **The Mailboxes page "Show API key" button (js/mailboxAdmin.js) now gets `api_key: null` — change it to a Rotate button.**
- **No duplicate sends.** `dispatch_scheduled_emails()` turns a row stuck in `sending` for 15 min into `unknown` (never retried);
  the task becomes `failed` with "Send result unknown — check Sent folder". `email_messages.scheduled_id` is unique; email-send
  refuses to send a queue row that already has a stored message. SMTP has a 60 s overall timeout; a failure after the body was
  written is `unknown`, before it a plain failure. There is no UI action yet to clear an unknown task (stop_sequence works).
  Settings the dispatcher used to hardcode (function URL, bearer, cron secret) now come from `app_secrets`
  (`dispatch_fn_url`, `dispatch_bearer`, `dispatch_cron_secret`); the migration copies them out of the old function body.
- **Suppression + dedup.** `suppressed_emails`, `suppressed_domains`; admin RPCs `suppress_email`, `unsuppress_email`, `suppress_domain`.
  Inbound replies that say stop / unsubscribe / remove me / not interested (first 600 chars of the reply, quoted text ignored, only
  from people we emailed) and hard bounces (5.1.x, 5.2.1, 5.4.1, "user unknown"...) add the sender. `start_emails` and the
  dispatcher move suppressed leads to backup. Global dedup: a lead is a `duplicate` (backup, with reason) when another active
  sequence has the same normalised address (gmail dots, `+tags`) or, for personal-looking addresses, the same company domain
  (free-mail and example.* domains exempt; extend with `app_secrets.dedup_exempt_domains`).
- **Time zones + caps.** `dials.tz` follows the state (`state_tz`). Sends need the owner's 8:30-17:00 window AND the recipient's
  9:00-16:00 local weekday (unknown state: the owner's zone). Per-domain cap across mailboxes: `app_secrets.domain_daily_cap`
  (default 60). `email_accounts.ramp_start`: cap = least(normal cap, 2 + days since ramp start).
- **Bounce guard.** Cron `bounce-guard` every 15 min: bounced / first emails sent in 7 days, at least 20 sends, over 3% pauses the
  mailbox and/or list ("Auto-paused: bounce rate X%"). Only an admin resumes (`resume_sending('mailbox'|'list', id)`), and
  counting restarts from the resume time.
- **Misc.** CR/LF and odd characters rejected in recipients, In-Reply-To, attachment names/types. SMTP login failure pauses the mailbox
  ("Login failed — update the password") without using up the lead's attempt. Trashing a list / deleting a lead cancels queued sends
  and tasks. **List-Unsubscribe-Post is not sent**: RFC 8058 one-click needs an https endpoint that suppresses the address; until
  one exists the header stays a `mailto:` link.
- **Vault.** `email_accounts.password_secret_id`; `get_mailbox_password(id)` / `set_mailbox_password(id, pw)` are service_role only.
  email-send, email-sync, email-live, email-account-manage and mailbox-admin use them and fall back to the legacy column if the
  functions don't exist yet. The plaintext column is nulled only where `app_secrets.null_plaintext_passwords = 'true'` (set on TEST).

## Live rollout order
1. Set `CRON_SHARED_SECRET` on live. 2. Run the migration (leave `null_plaintext_passwords` unset at first). 3. Deploy the functions.
4. Verify a send + a sync, then set `null_plaintext_passwords = 'true'` and null the column (`update email_accounts set password = null
where password_secret_id is not null`). 5. Add any extra mail hosts to `mailbox_host_allowlist` BEFORE editing mailboxes.
