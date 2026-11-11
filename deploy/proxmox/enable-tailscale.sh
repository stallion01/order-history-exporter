#!/usr/bin/env bash
# Puts Expense Hub on your tailnet with HTTPS. Runs inside the container.
# Your tailnet needs MagicDNS and HTTPS certificates turned on
# (Tailscale admin console > DNS).
set -euo pipefail

ENV_FILE=/etc/expense-hub/env

if ! tailscale status >/dev/null 2>&1; then
  echo "Sign this container in to Tailscale using the link below."
  tailscale up --hostname expense-hub
fi

NAME="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
[ -n "$NAME" ] || { echo "Could not read this machine's tailnet name." >&2; exit 1; }

# Tailscale serves HTTPS on the tailnet and passes requests to the app on this machine.
tailscale serve --bg http://127.0.0.1:8787

if grep -q '^#\?OHE_PUBLIC_HOST=' "$ENV_FILE"; then
  sed -i "s|^#\?OHE_PUBLIC_HOST=.*|OHE_PUBLIC_HOST=$NAME|" "$ENV_FILE"
else
  echo "OHE_PUBLIC_HOST=$NAME" >>"$ENV_FILE"
fi
systemctl restart expense-hub

echo
echo "Expense Hub:  https://$NAME"
echo "Open it on any device signed in to your tailnet. It isn't reachable from the internet."
