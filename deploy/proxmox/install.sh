#!/usr/bin/env bash
# Creates a Debian 12 container (LXC) on Proxmox and installs Expense Hub in it.
# Run this on the Proxmox host, as root.
#
# Settings (optional, as environment variables):
#   CTID          container id (default: next free id)
#   CT_HOSTNAME   default: expense-hub
#   STORAGE       disk storage (default: local-lvm)
#   TEMPLATE_STORAGE  where templates are kept (default: local)
#   BRIDGE        network bridge (default: vmbr0)
#   DISK_GB       default: 16    MEMORY_MB default: 1024    CORES default: 2
#   IMPORT_DIR    folder on this host holding orders.db and token from an existing
#                 install, to copy across (optional)
#   REPO / BRANCH default: the public GitHub repository, main
set -euo pipefail

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
CT_HOSTNAME="${CT_HOSTNAME:-expense-hub}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
DISK_GB="${DISK_GB:-16}"
MEMORY_MB="${MEMORY_MB:-1024}"
CORES="${CORES:-2}"
REPO="${REPO:-https://github.com/stallion01/order-history-exporter.git}"
BRANCH="${BRANCH:-main}"
IMPORT_DIR="${IMPORT_DIR:-}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

command -v pct >/dev/null || die "Run this on a Proxmox host (pct was not found)."
[ "$(id -u)" -eq 0 ] || die "Run this as root."
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists. Set CTID to a free id."
if [ -n "$IMPORT_DIR" ]; then
  [ -f "$IMPORT_DIR/orders.db" ] || die "IMPORT_DIR has no orders.db."
fi

say "Finding the Debian 12 template"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "No Debian 12 template is available."
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

say "Creating container $CTID ($CT_HOSTNAME)"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_HOSTNAME" \
  --unprivileged 1 \
  --features nesting=1 \
  --cores "$CORES" \
  --memory "$MEMORY_MB" \
  --swap 512 \
  --rootfs "$STORAGE:$DISK_GB" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --onboot 1 \
  --ostype debian

# Tailscale inside the container needs the tunnel device.
cat >>"/etc/pve/lxc/$CTID.conf" <<'EOF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF

pct start "$CTID"
say "Waiting for the container's network"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 || die "The container has no network. Check the bridge ($BRIDGE) and DHCP."

say "Installing Expense Hub (this takes a few minutes)"
pct exec "$CTID" -- bash -c "apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null"
pct exec "$CTID" -- git clone --depth 1 --branch "$BRANCH" "$REPO" /opt/expense-hub
pct exec "$CTID" -- bash /opt/expense-hub/deploy/proxmox/setup-in-container.sh

if [ -n "$IMPORT_DIR" ]; then
  say "Importing your existing database"
  pct exec "$CTID" -- systemctl stop expense-hub
  pct push "$CTID" "$IMPORT_DIR/orders.db" /var/lib/expense-hub/orders.db --perms 600
  [ -f "$IMPORT_DIR/token" ] && pct push "$CTID" "$IMPORT_DIR/token" /var/lib/expense-hub/token --perms 600
  pct exec "$CTID" -- bash -c "rm -f /var/lib/expense-hub/orders.db-wal /var/lib/expense-hub/orders.db-shm; chown expense-hub /var/lib/expense-hub/*"
  pct exec "$CTID" -- systemctl start expense-hub
fi

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
say "Done. Container $CTID is running Expense Hub."
cat <<EOF

Next steps:
  1. Turn on private HTTPS access through Tailscale (it prints a sign-in link):
       pct exec $CTID -- bash /opt/expense-hub/deploy/proxmox/enable-tailscale.sh
  2. Read the setup code (the extension's access token):
       pct exec $CTID -- cat /var/lib/expense-hub/token
  3. Open the https:// address that step 1 prints, on a device signed in to your
     tailnet, and create your account with the setup code.

Until Tailscale is on, the app only listens inside the container ($IP is not exposed).
Updates later:  pct exec $CTID -- bash /opt/expense-hub/deploy/proxmox/update.sh
EOF
