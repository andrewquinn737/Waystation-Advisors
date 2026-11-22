-- Result of the last real login check per mailbox (what Admin > Email accounts shows). Idempotent.
-- sending_ok = SMTP login worked (password, or XOAUTH2 for Microsoft); reading_ok = IMAP login worked (XOAUTH2 for ms_oauth).
alter table public.email_accounts
  add column if not exists sending_ok boolean,
  add column if not exists reading_ok boolean,
  add column if not exists checked_at timestamptz,
  add column if not exists check_error text;
