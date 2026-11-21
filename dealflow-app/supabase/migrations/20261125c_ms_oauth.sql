-- Microsoft 365 OAuth (XOAUTH2, app-only) for the Working Signal mailboxes. Idempotent.
-- auth_method: 'password' (default, LOGIN) or 'ms_oauth' (IMAP AUTHENTICATE XOAUTH2 with a client-credentials token;
-- tenant = mailbox domain; MS_OAUTH_CLIENT_ID / MS_OAUTH_CLIENT_SECRET are Edge Function secrets).
alter table public.email_accounts
  add column if not exists auth_method text not null default 'password';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'email_accounts_auth_method_chk') then
    alter table public.email_accounts add constraint email_accounts_auth_method_chk check (auth_method in ('password','ms_oauth'));
  end if;
end $$;

update public.email_accounts set auth_method = 'ms_oauth'
 where lower(imap_host) = 'outlook.office365.com' and auth_method <> 'ms_oauth';
