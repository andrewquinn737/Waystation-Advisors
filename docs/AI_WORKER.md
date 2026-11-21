# AI worker: "Edit with Claude" in the CRM

An admin opens a campaign's review screen, taps **Edit with Claude** and asks for bulk changes ("Shorten all to under 70
words"). A worker on the Oracle VM runs Claude Code on the **owner's Claude subscription**, with only the CRM connector
tools (`claude-connector`: list_drafts, check_draft, save_rewrite, ...), and streams the answer back into the page.
Every save still passes the server copy gate; Claude cannot launch or send. Admins only, behind a feature flag.

Terms note: the owner accepted the risk of routing his own plan through this worker. Nobody else's login is used.

## Pieces
| Piece | Where |
|---|---|
| Tables `ai_threads`, `ai_messages`, `ai_jobs`, `ai_workers`, RPCs `post_ai_message`, `ai_new_thread`, `ai_chat_status`, `claim_ai_job` (service role only) | `dealflow-app/supabase/migrations/20261125b_ai_chat.sql` |
| Worker (stdlib Python), systemd unit, `install.sh`, `set-token.sh`, fake `claude` for tests | `tools/ai_worker/` |
| Drawer UI, status + setup card | `dealflow-app/js/aiChat.js`, `aiChatSetup.js`, `css/aiChat.css` |
| TEST setup (AI Assistant admin profile + connector token + flag) | `tools/testenv/setup_ai_worker.py` |
| Tests | `tools/ai_worker/test_worker.py` (unit), `tools/testenv/test_ai_chat.py` (end to end); both in `run_all.sh` |

Flow: UI `post_ai_message(list, text)` -> thread + user message + job -> worker `claim_ai_job()` (SKIP LOCKED, 2s poll,
concurrency 2) -> `claude -p` (prompt on stdin, `--output-format stream-json --verbose --include-partial-messages`,
`--tools ""`, `--allowedTools "mcp__crm__*"`, `--strict-mcp-config`, `--permission-mode dontAsk`, `--resume <session>`) -> a partial
assistant row updated every 700 ms -> final row + `meta.saved` -> the review list reloads.
If `--resume` fails the last 20 messages are replayed. Lead text is untrusted: Claude has no shell, file or web tools, runs in an empty
directory, and never sees the Supabase service key (its environment is only HOME, PATH and the OAuth token).

States: **Claude connected** (green), **Claude isn't signed in on the server yet - see Settings** (amber: no or rejected token;
messages are saved as `blocked_auth` and run by themselves once signed in, if under 2 hours old), **Offline** (gray, no heartbeat for 90 s).
Usage-limit replies park the job as `waiting` with `retry_after`.

## Owner setup (once, ~2 minutes)
1. On your Mac, in Terminal: `claude setup-token` (needs a Claude Pro or Max plan). Sign in in the browser; copy the token it prints.
2. Run this one command. Paste the token when nothing seems to happen, then press Return (it is not echoed and not saved in history):
   ```
   read -rs T && printf '%s' "$T" | ssh -i ~/Desktop/ssh-key-2026-11-09.key ubuntu@129.146.6.202 "sudo /opt/waystation-ai/set-token.sh"; unset T
   ```
   `set-token.sh` replaces the `CLAUDE_CODE_OAUTH_TOKEN=` line in `/etc/waystation-ai/env` (no duplicates, file stays 0600) and restarts the worker.
3. After ~15 seconds Admin > Settings > "Claude on the server" (and the chat header) shows green **Claude connected**.

## Switch off / revoke
- Off: `update app_secrets set value='false' where key='ai_chat_enabled'` (the button disappears, posting is refused). On: `'true'`.
- Remove the token: `sudo sed -i 's/^CLAUDE_CODE_OAUTH_TOKEN=.*/CLAUDE_CODE_OAUTH_TOKEN=/' /etc/waystation-ai/env && sudo systemctl restart waystation-ai-worker`, and revoke it in your Claude account.
- Stop the worker: `sudo systemctl disable --now waystation-ai-worker`.

## The VM
Own OS user `waystation-ai` (no sudo), Claude Code installed with the native installer into its home, code in `/opt/waystation-ai`, secrets in
`/etc/waystation-ai/env` (0600): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CONNECTOR_TOKEN` (token of the "AI Assistant" admin profile, label
`ai-worker`, 600 calls per 10 min instead of 120), `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_BIN`, optional `LIST_NAME_NOT_LIKE` (the TEST VM ignores
lists named `TEST-AI %`, which the end-to-end test owns). Logs: `journalctl -u waystation-ai-worker`. The email hub, Caddy and their DB are untouched.
Redeploy: `scp tools/ai_worker/{worker.py,...}` then `sudo ./install.sh` (idempotent; keeps the env file).

## Going live (not done)
Apply the migration to LIVE, create the AI Assistant profile + connector token there (`setup_ai_worker.py` is TEST-only; do the same by hand),
put the LIVE `SUPABASE_URL`/service key/token in the env file, set `ai_chat_enabled`. Known limits: the AI Assistant profile is an admin, so it can reach every
list (the system prompt scopes it to the open one, the server does not); one active conversation per admin per list.
