#!/bin/bash
# launch-browser.sh — headless Chromium for ThunderBase, ThunderBrowser extension loaded.
#
# Purpose: keep a long-lived browser running on the EC2 instance so the
# ThunderBrowser extension stays dialed into the BrowserBridge on port 8770.
# Ghost Jon then sees "a browser is open watching X page" as part of his
# session context.
#
# Mode: --headless=new is required to load the extension. Legacy --headless
# silently drops extensions. --no-sandbox is required to run as ubuntu (or
# root) on EC2; --disable-gpu is required because there's no DRI device.
#
# Profile lives under ~/.thundergate/chrome-profile so it survives a reboot
# (unlike the dev launcher under /tmp). The DevTools protocol listens on
# 9222 — that's how the CLI `browser navigate` command talks to the page.

set -euo pipefail

EXTENSION_DIR="${TB_EXTENSION_DIR:-/home/ubuntu/thundergate-dev/extensions/thunderbrowser}"
# Chromium on modern Ubuntu ships as a snap. Snaps with the `home` plug
# can read/write inside $HOME but cannot touch hidden dirs (anything
# starting with a dot). The original "~/.thundergate/chrome-profile"
# path errored with `Failed to create SingletonLock: Permission denied`
# on first launch. A non-hidden subdir under $HOME works for both snap
# and non-snap chromium without elevating permissions.
PROFILE_DIR="${TB_PROFILE_DIR:-$HOME/thundergate-chrome-profile}"
DEBUG_PORT="${TB_DEBUG_PORT:-9222}"
INITIAL_URL="${TB_INITIAL_URL:-http://localhost:7860}"

mkdir -p "$PROFILE_DIR"

CHROME_BIN=""
for candidate in \
  "$(command -v chromium-browser || true)" \
  "$(command -v chromium || true)" \
  "$(command -v google-chrome || true)" \
  "$(command -v google-chrome-stable || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    CHROME_BIN="$candidate"
    break
  fi
done

if [ -z "$CHROME_BIN" ]; then
  echo "launch-browser.sh: no Chromium/Chrome binary found." >&2
  echo "Install: sudo apt-get install -y chromium-browser" >&2
  exit 1
fi

if [ ! -d "$EXTENSION_DIR" ]; then
  echo "launch-browser.sh: extension dir not found: $EXTENSION_DIR" >&2
  exit 1
fi

echo "ThunderBrowser native launcher"
echo "  Chrome:     $CHROME_BIN"
echo "  Profile:    $PROFILE_DIR"
echo "  Extension:  $EXTENSION_DIR"
echo "  DevTools:   http://127.0.0.1:$DEBUG_PORT"
echo "  Opening:    $INITIAL_URL"

exec "$CHROME_BIN" \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXTENSION_DIR" \
  --disable-extensions-except="$EXTENSION_DIR" \
  --remote-debugging-port="$DEBUG_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=ChromeWhatsNewUI \
  --window-size=1280,800 \
  "$INITIAL_URL"
