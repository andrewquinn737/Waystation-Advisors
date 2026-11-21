#!/bin/sh
# The server must run the exact same copy rules as the review screen.
cd "$(dirname "$0")/../../dealflow-app" || exit 1
if cmp -s js/copyLint.js supabase/functions/_shared/copyLint.js; then echo "copyLint in sync"; else
  echo "OUT OF SYNC: copy js/copyLint.js to supabase/functions/_shared/copyLint.js and redeploy copy-gate + claude-connector"; exit 1; fi
