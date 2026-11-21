# Claude connector (remote MCP server)

An intern adds the Waystation CRM to their own Claude once, then asks Claude to fix their flagged cold-email drafts.
Claude reads the drafts and the house guidelines, rewrites, and saves through the CRM. The server refuses any save that
breaks the house rules, so a rewrite can never skip the gate.

Code: `dealflow-app/supabase/functions/claude-connector/index.ts` (edge function, hand-rolled MCP over Streamable HTTP,
stateless JSON), SQL in `dealflow-app/supabase/migrations/20261121b_claude_connector.sql` (on top of
`20261121_copy_gate.sql`). Tests: `tools/testenv/test_claude_connector.py` (67 checks, TEST project).

## Connecting (intern)
1. In the CRM open **Profile > Connect Claude** and copy your connector URL
   (`https://<project>.supabase.co/functions/v1/claude-connector/mcp/<token>`). The button calls
   `create_claude_connector_token()`; the token is shown once.
2. In claude.ai: **Settings > Connectors > Add custom connector**, paste the URL, save. (Claude Desktop: same screen.)
3. Start a chat and try one of the prompts below. The connector also offers two ready-made prompts, `rewrite_flagged`
   and `improve_draft`.

Example prompts:
- "Rewrite my held drafts in <list name>."
- "Show me my lists and how many drafts are held."
- "Draft <company> reads too stiff. Make it warmer and keep it under 70 words."
- "What changed on <company>'s email over time?"

## What it can do
| Tool | Purpose |
|---|---|
| `list_my_lists` | Lists you can manage, copy status, counts (total/passed/held/unchecked/sent) |
| `list_drafts` | Drafts with the server's errors and warnings (default: held), 50 per page |
| `get_guidelines` | House guidelines for `ma` or `data` (Claude is told it must call this first) |
| `check_draft` | Dry run in the context of the whole list (catches sentences repeated from other leads). Writes nothing |
| `save_rewrite` | Same check first; any hard error rejects the save. If clean it saves, records history (source `claude_connector`) and re-runs the server gate, so the lead can join an approved list |
| `get_history` | Last 10 revisions of a draft |

Rules enforced server-side: no em/en dashes, Email 1 body at most 85 words, no placeholders, no sentence reused across leads,
and the first email cannot change once it was sent (only the follow-up). Limit: 120 tool calls per token per 10 minutes.

## Security model
- Auth is a bearer secret inside the URL: a 64-hex token (only its sha256 is stored, `claude_connector_tokens`).
  Anyone with the URL can act as that person in this connector, so treat it like a password and do not paste it into chats or tickets.
- **Revoke:** Connect Claude > Regenerate (revokes the old URL at once), or `revoke_claude_connector_tokens()`. One active token per person.
- Scope matches the app: interns reach only their own lists, team leads their interns' lists, admins all
  (`can_manage_list`). A draft you cannot reach gives the same "not found" as one that does not exist.
- The connector reads and edits email copy only. It cannot send, approve lists, or touch mailboxes or passwords.
- Draft and summary text is untrusted data; the server instructions tell Claude not to follow instructions inside it.

## Limitations and next step
The URL-as-secret model is v1: it leaks if the URL is shared or logged, and claude.ai shows it in the connector settings.
Plan: add OAuth 2.1 (the MCP authorization flow, with the CRM login as the identity provider and short-lived tokens),
then drop URL tokens. Until then keep the connector to the test project and a handful of interns.
