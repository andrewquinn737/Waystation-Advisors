# mailbox-admin API

One endpoint for adding, assigning and managing sending mailboxes (`email_accounts`). Used by the
Mailboxes admin page (`dealflow-app/mailboxes.html`) and meant for scripts and AI tools.

```
POST {SUPABASE_URL}/functions/v1/mailbox-admin
Content-Type: application/json
```

Test project: `https://aglqusdpkwdidoiaavub.supabase.co`. Every call is a JSON body with an `action`.

## Auth (either one)
- `Authorization: Bearer <Supabase user JWT>` for a user whose `profiles.role = 'admin'`.
- `x-admin-api-key: <key>`. Only the SHA-256 of the key is stored (`app_secrets.mailbox_admin_api_key_hash`), so it can
  never be shown again; an admin mints a new one with `rotate_api_key` (admin session only; the old key stops working at
  once). Never commit it. With the key, "the calling admin" (owner fallback) is the first admin profile.

Every call is written to `mailbox_admin_audit` (actor, action, target, time, ip). Limit: 60 calls per 10 minutes per key
or user (HTTP 429 after that). Mail hosts must be on the allowlist (outlook.office365.com, smtp.office365.com,
imap.gmail.com, smtp.gmail.com, inbound.winnr-app.com, inbound.gowinnr.com, plus `app_secrets.mailbox_host_allowlist`,
comma separated) and must not resolve to a private address. Changing a host or port on an existing mailbox needs the
`password` in the same request. Passwords are stored in Supabase Vault.

No credentials: 401. Signed-in non-admin: 403. Passwords are write-only: no action ever returns one, and error
text is scrubbed of the submitted password.

## Actions

### `bulk_upsert`
```json
{"action":"bulk_upsert","dry_run":true,"verify":false,"mailboxes":[
  {"email":"sam@sales-example.com","password":"...","display_name":"Sam Lee",
   "owner_email":"sam@waystation-advisors.com","daily_send_limit":25,"mandate":"ma"}]}
```
Row fields: `email` (required), `password` (required for new, blank on update keeps the old one), `display_name`,
`provider` (`microsoft`|`google`), `imap_host`, `imap_port`, `smtp_host`, `smtp_port`, `username` (default: the email),
`daily_send_limit` (0-200; omit for the global default), `mandate` (`ma`|`data`), `sync_enabled` (default false for new rows),
`owner_email` | `owner_name`, `verify` (bool).

- Hosts omitted: Microsoft 365 (`outlook.office365.com:993`, `smtp.office365.com:587` STARTTLS) or Google
  (`imap.gmail.com:993`, `smtp.gmail.com:465`), chosen from `provider`, the domain (gmail/outlook), or the domain's MX
  records. If none match, give `provider` or the hosts.
- Owner: `owner_email` / `owner_name` if given (error if no unique person), else on update the current owner is kept,
  else SQL `match_mailbox_owner(display_name, email)` (first AND last name must match exactly one person), else the
  calling admin with `needs_assignment = true`.
- Upsert key: `lower(email)`. New rows get `source = 'api'` (so the 3-mailbox self-connect cap does not apply).
- `verify: true` logs in to IMAP and SMTP (nothing is sent). A failed check means the row is not saved. Max 25 rows per
  request when verifying. `credentials_verified` is set to true on success; a new password without `verify` resets it to null.
- `dry_run: true` writes nothing and returns `would_create` / `would_update`.
- Limits: 500 rows per request; more returns 400 and nothing is written.

Response (HTTP 200 even when rows fail):
```json
{"ok":true,"dry_run":false,"summary":{"total":3,"created":2,"updated":0,"would_create":0,"would_update":0,"errors":1,"needs_assignment":1},
 "results":[{"email":"sam@sales-example.com","status":"created","owner":"Sam Lee","owner_id":"...","needs_assignment":false,"verified":null},
            {"email":"bad","status":"error","owner":null,"error":"Invalid email address."}]}
```
`status`: `created` | `updated` | `would_create` | `would_update` | `error`.

### `assign`
`{"action":"assign","account_ids":["<id>",...],"owner_id":"<profile id>"}`: sets the owner, clears `needs_assignment`.

### `update`
`{"action":"update","account_id":"<id>","daily_send_limit":30,"mandate":"data","send_paused_reason":"warming","sync_enabled":true}`
All fields optional, at least one required. `send_paused_reason: null` resumes sending; `daily_send_limit: null` restores the default;
`mandate: null` clears it.

### `remove`
`{"action":"remove","account_ids":["<id>",...],"force":false}`: refuses a mailbox with pending/sending `scheduled_emails`
(status `refused`, with the count) unless `force: true`, which cancels them. Deleting a mailbox also deletes its synced messages.

### `list`
`{"action":"list"}` returns `mailboxes` (id, owner_id, owner_name, label, email_address, username, hosts/ports, sync_enabled,
daily_send_limit, effective_daily_limit, sent_24h, scheduled, mandate, send_route, source, needs_assignment,
credentials_verified, send_paused_reason, last_synced_at, last_sync_error, created_at) and `people` (id, full_name, role). No passwords.

### `rotate_api_key`
Admin session only. Returns `{api_key}` once (`wsk_...`); only its hash is kept. `get_api_key` now returns `api_key: null`.

### `check_login`
`{"action":"check_login","account_id":"<id>"}`: logs in to IMAP and SMTP with the STORED password (nothing is sent) and
returns `{imap:{ok,error?}, smtp:{ok,error?}}`; sets `credentials_verified`.

`update` also accepts `ramp_start` (`YYYY-MM-DD` or null): new-mailbox ramp, daily cap = 2 + days since that date.

## Errors
Bad input returns 400 `{"error": "..."}` (invalid JSON, unknown action, bad ids, too many rows) or per-row errors inside a 200 for
`bulk_upsert`. Unexpected failures return 500 `{"error":"Unexpected server error."}`.

## Example
```bash
curl -X POST "$SUPABASE_URL/functions/v1/mailbox-admin" \
  -H "x-admin-api-key: $MAILBOX_ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"action":"list"}'
```
Tests: `tools/testenv/test_mailbox_admin.py` (test project only).
