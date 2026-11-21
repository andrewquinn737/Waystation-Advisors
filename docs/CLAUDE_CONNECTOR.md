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
| `list_campaigns` | Campaigns (one per email list) you can manage, by status draft/ready/live/paused/done |
| `get_campaign` | Guidelines for the mandate, buyer brief, 12 sample leads, copy counts and saved pools |
| `save_campaign_spintax` | Saves `{a\|b\|c}` pools + `{{first_name}}` `{{company}}` `{{city}}` tags, expands them per lead, runs the copy gate, returns pass/held counts and reasons |

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

## Campaigns and spintax (Admin > Campaigns)
Prompt `design_campaign` (arg `list_id`): Claude reads `get_campaign`, asks who is sending, proposes subject/email 1/follow-up pools,
calls `save_campaign_spintax`, fixes held leads from the returned reasons, then shows three rendered examples. Claude never launches;
the admin presses Launch (Admin > Campaigns). The page's "Design in Claude" button opens claude.ai with that request prefilled.

Server-side (code, not Claude): `supabase/functions/_shared/spintax.js` parses templates (rejects unbalanced braces, unknown tags, dashes,
empty options, single-option groups; nothing is written on a template error), picks options per lead deterministically WITHOUT replacement
(least-used option first, candidates that would repeat a sentence another lead already has are skipped), fills merge tags from the lead
(a lead missing a used tag is skipped and reported), writes subject/email_1/email_2 and `dials.copy_variant` (A/B ids), stores the pools and a
version on `campaigns.spintax`, then runs the copy gate (`checkList`). Leads whose first email already went out are never rewritten.

Live campaigns: a connector save (single draft or spintax) that changes an ACTIVE lead sends that lead back to `awaiting_copy` and un-queues
its pending send; the campaign shows `ready` until an admin presses Launch again. Pause = `dial_lists.copy_status` back to `pending_review`
(the dispatcher only sends for approved lists) plus un-queueing pending sends; Resume restores it.

Hardening: JSON-RPC batches are capped at 10, the rate limiter fails closed, tokens expire (90 days by default, `create_claude_connector_token(label, days)`,
1 to 365) and the CRM shows last used / expires.

Tests: `tools/testenv/test_campaigns.py`, `tools/testenv/spintax.test.mjs`.
