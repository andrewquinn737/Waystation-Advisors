# AI Call Coach (AI tab)

An "AI" tab in the CRM for interns doing cold calls, built for two tracks:
- **Data sales**, Arieh's Working Signal offer: we pay businesses for old records.
- **M&A**: Waystation outreach to owners for a buyer.

The tab has three steps:

1. **Connect Claude or ChatGPT**: the intern's personal claude-connector link (docs/CLAUDE_CONNECTOR.md). From the link
   they can ask for "coach me" or "run a practice call" by voice in their own assistant.
2. **Your coach**:
   - Every real conversation gets graded automatically a few minutes after hang-up.
   - The advice at the top is rewritten after the first graded call, then after every 10 more.
3. **Practice call**: a role-play with an AI owner built from one of our real calls. It answers the way that owner did.
   Difficulty follows a stage ladder:
   - **opener**: brush-offs until three openers in a row pass.
   - **objections**: the objection types the intern handles worst on real calls.
   - **full**: whole calls from hello to the ask.

Everything runs on TEST (`aglqusdpkwdidoiaavub`) only. Nothing has been applied to LIVE.

## Pieces

| Piece | Where |
|---|---|
| Page | `dealflow-app/ai.html`, `js/aiCoach.js` (coach and guide), `js/aiPractice.js` (practice, mic and speech), `css/aiCoach.css`; nav tab added in `js/auth.js` |
| Schema | `supabase/migrations/20261214_ai_coach.sql` (tables), `20261214b_ai_coach_rpc.sql` (RPCs and cron), `20261214c_ai_persona_unique.sql` |
| Connector tools | `supabase/functions/claude-connector/coach.ts`: `get_my_coaching`, `get_call_feedback`, `start_practice_call`, `practice_say`, `get_practice_reply`, `end_practice_call`, `read_coach_doc`, plus the prompts `coach_me` and `practice_call` |
| Worker | `tools/ai_coach/worker.py` (job loop), `handlers.py` (one handler per job kind), `prompts.py`, `coachlib.py`, `retrain.py` (weekly), `bank.py` (persona bank) |
| Knowledge base | `tools/ai_coach/kb/{shared,data,ma}/*.md` → `ai_kb_docs` via `load_kb.py` |
| Judge | `tools/ai_coach/judge.py` |
| Deploy | `tools/ai_coach/deploy/` (systemd unit and install.sh) |
| Tests | `tools/testenv/test_ai_coach_connector.py` (15 checks, all pass on TEST) |

### Tables

| Table | Holds |
|---|---|
| `ai_kb_docs` | track × slug, versioned; the prompts and playbooks the worker and connector render |
| `ai_personas` | One persona per real conversation: greeting, first reaction, objections in order, signature phrases, outcome, weight |
| `ai_call_feedback` | One row per graded real call |
| `ai_coach_state` | Per user × track: stage, conv_count, advice, objection focus |
| `ai_practice_sessions` | One row per practice call |
| `ai_coach_jobs` | The job queue |
| `ai_training_runs` | Weekly retrain stats |

### Track

`ai_call_track(list_id)` picks the track. It uses `dial_lists.mandate` ('ma' or 'data') and falls back to a name regex.

## Jobs (all LLM work goes through the Claude subscription, `claude -p`, no API key)

| kind | from | does |
|---|---|---|
| `call_feedback` | cron `ai-coach-feedback` (every 5 min) → `ai_coach_enqueue_feedback()` | grades a transcribed call: opener, objections, keeps, fixes, try-line; every quote checked verbatim against the transcript; adds a persona |
| `coach_update` | queued by `_ai_coach_recompute` at the first call, then every 10 conversations | rewrites the advice from the last 10 graded calls against the 10 before them |
| `practice_turn` | `ai_practice_say` | the AI owner's next line (Sonnet), rendered from `prompt_prospect` + persona card + stage rules |
| `practice_score` | `ai_practice_end` | scores the practice call; the stage moves on pass streaks. A failed opener caps the opener score at 6 |
| `weekly_retrain` | cron `ai-coach-weekly` (Mon 09:00 UTC) | re-weights personas and grades any ungraded calls. It rebuilds `calls_playbook` only when at least 8 new conversations came in, and bumps the version |

## Weighting

The playbook and the persona sampling are weighted by outcome and recency:
- intro or callback_interested ×3
- busy-callback ×1.5
- a 45-day recency half-life
- Andrew's calls from the last completed week plus the current week ×4

The research files (`kb/*/research_*.md`) are a base only. The prompts reach them only through the router, while the
calls-derived `calls_playbook` goes into every prompt. The M&A track uses the same machinery with its own playbook,
guide, track context and openers (Jesse's calls weighted).

## Expert system (v2): real owner lines, outcome-first grading

Data and M&A are built separately end to end: `taxonomy.py` holds each track's caller moves, owner objections and
call sections, and every prompt is a per-track copy (`kb/<track>/prompt_*.md`).

**Track per call.** A list mixes pitches, so the list's track is only a fallback. `taxonomy.pitch_track()` reads what
the caller actually said, and the grader reports `pitched`; if it differs, the call is re-graded on the pitched track.

**Clean input.** `clean.py` runs on every transcript, offline and live: IVR lines dropped, echo lines (the caller's
voice on the owner channel) dropped, fragments merged into turns, speaker swaps fixed.

**Practice owner replies (`engine.plan_reply`).**
1. The intern's line is classified into a move: TF-IDF nearest neighbours over 3,388 labeled real caller turns (2,172 data, 1,216 M&A) plus regex
   rules, so no exact phrasing is needed.
2. PATH: if that move is what the real caller did next on the persona's source call (skip of up to 2 allowed,
   confidence ≥ .45), the real owner's own reply is returned word for word. No model call.
3. BANK: otherwise the closest real caller turns with that move, from any call on the track, supply up to 4 real owner
   replies (weighted by outcome, and ×1.5 when the owner reacted to the pitch the same way). Sonnet picks one,
   adapts one, or, only for an intern line unlike anything on file, writes a new one.
4. Code tags the source: a reply counts as real only if it overlaps a real candidate (≥ .5). Each turn stores
   `source` (path/bank/new), `move`, `path_pos`.

**Grading (`handlers.grade_call`).** Outcome first (`taxonomy.OUTCOMES`, 0 to 10), then opener / explain /
objections / close each scored on the owner's reaction right after it, with the reaction quote and the intern line
checked verbatim. `overall = 0.5 × outcome + 0.5 × weighted section mean`. Section weights come from the data
(`calibrate.py`: how strongly each section's owner reaction predicts the outcome). The grader reads a data-based
answer key (`grade_key`): per move, how owners reacted and how often the call ended well, plus the real lines that
drew the best and worst reactions. Feedback adds "Worked for another caller here": real lines from other callers in
the intern's weakest section that drew a good reaction.

**Where it lives.** `turn_bank`, `grade_key`, `grade_weights` are `ai_kb_docs` rows of kind `prompt` (admin-only under
the existing read policy, since they hold real transcript lines). Local copies go in `tools/ai_coach/bank/`
(gitignored). Each persona carries its call path in `ai_personas.persona.path`.

**Build (staging/ai_call_coach):** `clean.py` → `label_turns.py` (Haiku labels every turn) → `build_paths.py --test`
→ `calibrate.py --test` → `validate_grading.py` → `tools/ai_coach/judge_paths.py`.

## Judge: is the AI owner acting like the real owner?

`judge.py` replays a real call's caller lines into the simulator turn by turn and compares the AI's reply with what
the real owner said:
- stance class
- first reaction
- objection type
- reply length
- ending
- a Sonnet similarity score from 1 to 5
- a "too helpful" flag

It has two modes:
- `full`: the persona card comes from that call.
- `blind`: the card comes from the owner's prior information only.

Results on 20 calls, Sonnet:

| round | track/mode | stance | first reaction | objection type | similarity | too helpful | ending |
|---|---|---|---|---|---|---|---|
| r6 | data full | .70 | .80 | .70 | 3.41 | .32 | .85 |
| r7 | data full | .71 | .75 | .88 | 3.58 | .29 | .75 |
| r6 | ma full | .58 | .70 | .58 | 3.25 | .30 | .70 |
| r7 | ma full | .63 | .80 | .58 | 3.32 | .31 | .80 |
| r7 | data blind | .53 | .65 | .33 | 3.01 | .24 | .80 |

- Noise between runs at the same seed is about ±.08.
- Many "too helpful" flags are judge noise: the AI was as guarded as the real owner, or more.
- The main fix in r7: busy or hostile owners answer "how are you?" with "Who's this?" or "I'm busy", not "Good, you?".

Re-run:

```
python3 judge.py <records.jsonl> --track data --n 20 --mode full --model sonnet --seed 11 --out r8.json
```

## Deploy (Oracle VM, next to tools/ai_worker)

1. Run `tools/ai_worker/install.sh` first. It creates the user, the token env and claude.
2. Run `sudo tools/ai_coach/deploy/install.sh`. It copies the worker to `/opt/waystation-ai/coach` and enables
   `waystation-ai-coach.service`.
3. `set-token.sh` now restarts both services.
4. Load the knowledge base: `python3 tools/ai_coach/load_kb.py --test`, or without `--test` for LIVE once approved.
5. For LIVE, apply the three migrations, deploy the claude-connector function, and deploy `ai.html` with the nav change.
   None of this has been done.

## TEST state to know about

- **The `ai-coach-feedback` cron is paused on TEST.** `update cron.job set active=false where jobname='ai-coach-feedback'`
  keeps the local worker from grading real pilot calls. Re-enable it with `active=true`. `ai-coach-weekly` is still active.
- **Test data:**
  - 11 seeded calls on "Caleb Hong (test)" (`summary='[ai-coach-test]'`) with their feedback, coach state and practice
    sessions.
  - Remove them with `delete from calls where summary='[ai-coach-test]'`; feedback and sessions cascade or are keyed by user.
- Run the worker locally against TEST with `dev_sb.py` (see the header of `tools/ai_coach/worker.py`).
