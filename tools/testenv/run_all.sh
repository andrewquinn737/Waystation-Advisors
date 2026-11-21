#!/bin/sh
# One command: every test suite against the TEST project. Must be green before anything goes live.
# Usage: tools/testenv/run_all.sh [--load]   (--load adds the 2,700-lead load test, ~3 min)
cd "$(dirname "$0")" || exit 1
fail=0
# A suite fails if it exits non-zero, OR any line anywhere says FAIL / Traceback / OUT OF SYNC / aborted,
# OR its "N/M passed" summary has N != M.
run() { printf '%-28s' "$1"; out=$(sh -c "$2" 2>&1); rc=$?; last=$(printf '%s\n' "$out" | tail -1); echo "$last"
        bad=0; [ $rc -ne 0 ] && bad=1
        printf '%s\n' "$out" | grep -qE '^FAIL|Traceback|OUT OF SYNC|run aborted|[1-9][0-9]* failed' && bad=1
        printf '%s\n' "$out" | grep -oE '[0-9]+/[0-9]+ passed' | while read r; do a=${r%%/*}; b=${r#*/}; b=${b%% *}; [ "$a" = "$b" ] || echo MISMATCH; done | grep -q MISMATCH && bad=1
        [ $bad = 1 ] && { fail=1; printf '%s\n' "$out" | grep -E '^FAIL|Traceback' | head -5; echo "   -> FAILED"; }; }
run "shared copy rules"   "./check_shared.sh"
run "copy checks (node)"  "node copyLint.test.mjs"
run "SQL/JS sentence parity" "python3 test_sentence_parity.py"
run "sequence engine"     "python3 test_sequences.py"
run "mailbox admin API"   "python3 test_mailbox_admin.py"
run "Claude connector"    "python3 test_claude_connector.py"
run "spintax expander"    "node spintax.test.mjs"
run "campaigns + spintax" "python3 test_campaigns.py"
run "hardening"           "python3 test_hardening.py"
run "AI worker (unit)"    "python3 ../ai_worker/test_worker.py"
run "AI chat (end to end)" "python3 test_ai_chat.py"
[ "$1" = "--load" ] && run "load test" "python3 load_test.py 300 | grep 'over limit'"
[ $fail = 0 ] && echo "ALL GREEN" || { echo "SOMETHING FAILED - do not release"; exit 1; }
