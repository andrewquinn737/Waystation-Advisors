#!/bin/sh
# Run on the VM as a sudo-capable user (ubuntu), from the directory holding worker.py:  sudo ./install.sh
# Creates the waystation-ai user (no sudo), installs Claude Code for it, copies the worker, installs + enables the systemd unit.
# Does NOT touch any other service, Caddy or database. Creates /etc/waystation-ai/env from a template if it does not exist
# (fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CONNECTOR_TOKEN; leave CLAUDE_CODE_OAUTH_TOKEN empty: the owner sets it).
set -eu
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
id waystation-ai >/dev/null 2>&1 || useradd -m -s /bin/bash waystation-ai
install -d -o waystation-ai -g waystation-ai /opt/waystation-ai /opt/waystation-ai/run /opt/waystation-ai/run/work
install -d -m 750 -o root -g waystation-ai /etc/waystation-ai
[ -x /home/waystation-ai/.local/bin/claude ] || sudo -u waystation-ai sh -c 'cd ~ && curl -fsSL https://claude.ai/install.sh | bash'
install -m 644 -o waystation-ai -g waystation-ai "$here/worker.py" /opt/waystation-ai/worker.py
install -m 750 -o root -g root "$here/set-token.sh" /opt/waystation-ai/set-token.sh
install -m 644 "$here/waystation-ai-worker.service" /etc/systemd/system/waystation-ai-worker.service
if [ ! -f /etc/waystation-ai/env ]; then
  umask 077
  cat > /etc/waystation-ai/env <<'EOF'
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CONNECTOR_TOKEN=
CLAUDE_CODE_OAUTH_TOKEN=
CLAUDE_BIN=/home/waystation-ai/.local/bin/claude
EOF
  chown waystation-ai:waystation-ai /etc/waystation-ai/env; chmod 600 /etc/waystation-ai/env
  echo "Created /etc/waystation-ai/env: fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and CONNECTOR_TOKEN, then: sudo systemctl restart waystation-ai-worker"
fi
systemctl daemon-reload
systemctl enable --now waystation-ai-worker
systemctl --no-pager status waystation-ai-worker | head -5
