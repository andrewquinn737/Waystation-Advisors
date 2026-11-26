#!/bin/sh
# Run on the VM after tools/ai_worker/install.sh (it creates the waystation-ai user, Claude Code and /etc/waystation-ai/env).
# From tools/ai_coach/deploy:  sudo ./install.sh
# Copies the coach worker (tools/ai_coach/*.py) to /opt/waystation-ai/coach and enables waystation-ai-coach. Touches nothing else.
set -eu
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
id waystation-ai >/dev/null 2>&1 || { echo "run tools/ai_worker/install.sh first" >&2; exit 1; }
[ -f /etc/waystation-ai/env ] || { echo "/etc/waystation-ai/env missing: run tools/ai_worker/install.sh first" >&2; exit 1; }
src=$(cd "$(dirname "$0")/.." && pwd)
install -d -o waystation-ai -g waystation-ai /opt/waystation-ai/coach /opt/waystation-ai/coach/run
for f in worker.py coachlib.py handlers.py prompts.py retrain.py bank.py; do
  install -m 644 -o waystation-ai -g waystation-ai "$src/$f" "/opt/waystation-ai/coach/$f"
done
install -m 644 "$src/deploy/waystation-ai-coach.service" /etc/systemd/system/waystation-ai-coach.service
systemctl daemon-reload
systemctl enable --now waystation-ai-coach
systemctl restart waystation-ai-coach
systemctl --no-pager status waystation-ai-coach | head -5
