#!/usr/bin/env bash
# Install + enable the every-2h Ghost Jon calibration timer.
#
# This is the manual step the build-out couldn't take for itself —
# /etc/systemd/system/ writes require sudo. Run from the repo root:
#
#   sudo bash systemd/install-ghost-calibrate.sh
#
# Idempotent: re-running just reloads + re-enables. To remove, see
# uninstall-ghost-calibrate.sh.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "✗ Must be run as root (use sudo)." >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_SRC="$REPO_DIR/systemd/thundergate-ghost-calibrate.service"
TIMER_SRC="$REPO_DIR/systemd/thundergate-ghost-calibrate.timer"
DEST_DIR="/etc/systemd/system"

if [[ ! -f "$SERVICE_SRC" || ! -f "$TIMER_SRC" ]]; then
  echo "✗ Service or timer source missing in $REPO_DIR/systemd/" >&2
  exit 1
fi

install -m 0644 "$SERVICE_SRC" "$DEST_DIR/thundergate-ghost-calibrate.service"
install -m 0644 "$TIMER_SRC"   "$DEST_DIR/thundergate-ghost-calibrate.timer"

systemctl daemon-reload
systemctl enable --now thundergate-ghost-calibrate.timer

echo "✓ Installed and enabled thundergate-ghost-calibrate.timer"
systemctl status thundergate-ghost-calibrate.timer --no-pager || true
