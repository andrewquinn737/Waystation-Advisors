#!/bin/sh
# One command: every test suite against the TEST project. Must be green before anything goes live.
# Usage: tools/testenv/run_all.sh [--load]   (--load adds the 2,700-lead load test, ~3 min)
cd "$(dirname "$0")" || exit 1
fail=0
run() { printf '%-28s' "$1"; out=$(sh -c "$2" 2>&1); last=$(printf '%s\n' "$out" | tail -1); echo "$last";
        case "$last" in *FAIL*|*failed*[1-9]*|*"run aborted"*|*OUT\ OF\ SYNC*|*Traceback*|*Error*) fail=1;; esac
        printf '%s\n' "$out" | grep -E '^FAIL' | head -5; }
run "shared copy rules"   "./check_shared.sh"
run "copy checks (node)"  "node copyLint.test.mjs"
run "sequence engine"     "python3 test_sequences.py"
run "mailbox admin API"   "python3 test_mailbox_admin.py"
run "Claude connector"    "python3 test_claude_connector.py"
[ "$1" = "--load" ] && run "load test" "python3 load_test.py 300 | grep 'over limit'"
[ $fail = 0 ] && echo "ALL GREEN" || { echo "SOMETHING FAILED - do not release"; exit 1; }
