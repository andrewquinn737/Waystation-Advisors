# Copy guidelines (single source of truth)

These two files are THE copywriting rules every AI inside the Waystation CRM follows when it rewrites a cold email. Nothing else (skills, scripts, memory notes, chat prompts) overrides them inside the CRM.

| File | Mandate |
|---|---|
| `ma_seller.md` | M&A seller outreach: emails to business owners on behalf of a buyer we represent |
| `data_sales.md` | Data sales: Arieh / Working Signal outreach to companies about licensing non-confidential operating data |

Each mandate file is written to be used directly as the system prompt for one rewrite: an AI reads the whole file, then rewrites one email (subject, email 1, follow-up).

## How they are used

1. The files are loaded into the CRM database table `copy_guidelines` (one row per mandate).
2. The Claude connector serves the rows from that table to the AI doing the rewrite.
3. The app's hard checks live in `dealflow-app/js/copyLint.js`. The "HARD RULES" section of each file mirrors that linter; if the two ever differ, fix whichever is wrong so they agree. Section "Open conflicts" in each file lists places where the upstream sources disagree and Mason has not yet decided.

## How to update

1. Edit the markdown file here. Do not edit the database row directly, because the next load overwrites it.
2. Run the loader (to be built by the lead; not yet available) to push the files into `copy_guidelines`.
3. If a rule is mechanical, update `copyLint.js` and its tests in the same change.
4. When Mason resolves an item under "Open conflicts", move the decision into the rules and delete the item.

## Where the rules came from

- M&A: `First Project/.claude/skills/waystation-seller-outreach/` (SKILL.md, references, `scripts/flow_lint.py`, `scripts/batch.py`), `cold-email` and `direct-response-copy` skills (anti-AI-voice only), `playbook_ref/10_5_outreach.md` (10.5.3, 10.5.6, 10.5.8; the newest rules win).
- Data sales: `First Project/outreach/data_rich_ai/` (`FIVE_STEP_FLOW.md`, `STEP_1_2_SCRIPTS.md`, `STEP_3_EMAIL.md`, `STEP_5_CALL.md`, `DRAFTING_PROCESS.md`, `buyer-brief.md`) plus the same playbook rules.
- Hard checks: `dealflow-app/js/copyLint.js`.

Files contain no secrets and must stay that way.
