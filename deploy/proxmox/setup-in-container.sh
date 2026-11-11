#!/usr/bin/env bash
# Installs Node.js, builds Expense Hub and starts it as a service. Runs inside the
# container (install.sh calls it). Safe to run again.
set -euo pipefail

APP_DIR=/opt/expense-hub
DATA_DIR=/var/lib/expense-hub
ENV_DIR=/etc/expense-hub
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg sqlite3 >/dev/null

# Node.js 22 or newer, from NodeSource.
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

id expense-hub >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin expense-hub
install -d -m 700 -o expense-hub -g expense-hub "$DATA_DIR"
install -d -m 755 "$ENV_DIR"
if [ ! -f "$ENV_DIR/env" ]; then
  cat >"$ENV_DIR/env" <<EOF
# Expense Hub settings. Restart after changing: systemctl restart expense-hub
OHE_DATA_DIR=$DATA_DIR
OHE_HOST=127.0.0.1
OHE_PORT=8787
# Set by enable-tailscale.sh:
#OHE_PUBLIC_HOST=
EOF
  chmod 600 "$ENV_DIR/env"
fi

cd "$APP_DIR"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent

install -m 644 deploy/expense-hub.service /etc/systemd/system/expense-hub.service
install -m 644 deploy/expense-hub-backup.service /etc/systemd/system/expense-hub-backup.service
install -m 644 deploy/expense-hub-backup.timer /etc/systemd/system/expense-hub-backup.timer
systemctl daemon-reload
systemctl enable --now expense-hub.service expense-hub-backup.timer
systemctl restart expense-hub.service

if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
fi

echo "Expense Hub is running on 127.0.0.1:8787 inside this container."
