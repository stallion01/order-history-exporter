#!/usr/bin/env bash
# Updates Expense Hub to the latest version. Runs inside the container.
# The database is backed up first, and upgrades itself when the server starts.
set -euo pipefail

cd /opt/expense-hub
sudo -u expense-hub env $(grep -v '^#' /etc/expense-hub/env | xargs) node --disable-warning=ExperimentalWarning server/dist/backup.js || true
git pull --ff-only
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
install -m 644 deploy/expense-hub*.service deploy/expense-hub-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl restart expense-hub
echo "Updated to $(git log -1 --format='%h %s')"
