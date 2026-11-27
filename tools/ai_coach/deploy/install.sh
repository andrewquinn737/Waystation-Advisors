#!/bin/sh
# Run on the VM after tools/ai_worker/install.sh (it creates the waystation-ai user, Claude Code and /etc/waystation-ai/env).
# From tools/ai_coach/deploy:  sudo ./install.sh
# Copies the coach worker (tools/ai_coach/*.py) to /opt/waystation-ai/coach and enables waystation-ai-coach. Touches nothing else.
set -eu
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
id waystation-ai >/dev/null 2>&1 || { echo "run tools/ai_worker/install.sh first" >&2; exit 1; }
[ -f /etc/waystation-ai/env ] || { echo "/etc/waystation-ai/env missing: run tools/ai_worker/install.sh first" >&2; exit 1; }
src=$(cd "$(dirname "$0")/.." && pwd)
d=/opt/waystation-ai/coach
install -d -o waystation-ai -g waystation-ai $d $d/run $d/bank $d/models
for f in worker.py coachlib.py handlers.py prompts.py retrain.py refresh.py bank.py clean.py engine.py paths.py \
         realism.py embed.py taxonomy.py; do
  install -m 644 -o waystation-ai -g waystation-ai "$src/$f" "$d/$f"
done
# meaning-based matching: a local embedding model (fastembed, CPU). If the install fails the coach still runs on
# word matching (embed.available() is False), so a failed pip is a warning, not a stop.
[ -x $d/.venv/bin/python ] || sudo -u waystation-ai python3 -m venv --system-site-packages $d/.venv
sudo -u waystation-ai $d/.venv/bin/pip install -q fastembed==0.9.1 || echo "WARN: fastembed not installed, word matching only" >&2
install -m 644 "$src/deploy/waystation-ai-coach.service" /etc/systemd/system/waystation-ai-coach.service
systemctl daemon-reload
systemctl enable --now waystation-ai-coach
systemctl restart waystation-ai-coach
systemctl --no-pager status waystation-ai-coach | head -5
