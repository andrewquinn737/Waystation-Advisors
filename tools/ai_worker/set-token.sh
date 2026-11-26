#!/bin/sh
# Owner-run, on the VM: reads the Claude token from stdin (never from argv, never echoed), writes it into
# /etc/waystation-ai/env (replacing the existing CLAUDE_CODE_OAUTH_TOKEN line, no duplicates) and restarts the worker.
# Usage:  printf '%s' "$TOKEN" | sudo /opt/waystation-ai/set-token.sh
set -eu
ENVF=/etc/waystation-ai/env
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
tok=$(head -c 4096 | tr -d '\r\n' | sed -e 's/^CLAUDE_CODE_OAUTH_TOKEN=//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
[ -n "$tok" ] || { echo "no token received on stdin; nothing changed" >&2; exit 1; }
case "$tok" in *[!A-Za-z0-9._~+/=-]*) echo "that does not look like a token (unexpected characters); nothing changed" >&2; exit 1;; esac
tmp=$(mktemp /etc/waystation-ai/.env.XXXXXX)
chmod 600 "$tmp"
grep -v '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENVF" > "$tmp" || true
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$tok" >> "$tmp"
chown waystation-ai:waystation-ai "$tmp"
mv "$tmp" "$ENVF"
systemctl restart waystation-ai-worker
systemctl restart waystation-ai-coach 2>/dev/null || true   # the coach shares this token
echo "Token saved ($(printf '%s' "$tok" | wc -c | tr -d ' ') characters). Worker restarted. Check the status line in Admin > Settings in about 15 seconds."
