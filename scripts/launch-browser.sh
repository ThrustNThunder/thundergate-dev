#!/bin/bash
# launch-browser.sh — headless Chrome for ThunderBase, ThunderBrowser
# extension installed via Chrome's external_extensions JSON file mechanism.
#
# Purpose: keep a long-lived browser running on the EC2 instance so the
# ThunderBrowser extension stays dialed into the BrowserBridge on port 8771.
# Ghost Jon then sees "a browser is open watching X page" as part of his
# session context.
#
# Why external_extensions + CRX instead of --load-extension:
#   Chrome 142+ removed --load-extension entirely (and the
#   DisableLoadExtensionCommandLineSwitch policy that briefly let us re-enable
#   it). Snap Chromium 147+ has the same gap plus home-interface confinement
#   that blocks reads from /home/ubuntu/thundergate-dev/. Both branded Chrome
#   148 and snap Chromium 147 silently drop --load-extension.
#
#   Chrome's `external_extensions` mechanism still works: a JSON manifest at
#   /opt/google/chrome/extensions/<EXT_ID>.json points at a packed .crx, and
#   Chrome installs it silently at startup. We re-pack the .crx on every boot
#   from the current source under thunderbrowser/, using a persistent signing
#   key so the extension ID stays stable across restarts.
#
# Mode: --headless=new is required for service-worker-bearing extensions to
# fully initialize. --no-sandbox + --disable-gpu are required for headless
# Chrome running as ubuntu on EC2 with no DRI device.
#
# Profile lives under $HOME/thundergate-chrome-profile so it survives a reboot.
# The DevTools protocol listens on 9222 — that's how the CLI
# `browser navigate` command talks to the page.

set -euo pipefail

EXTENSION_DIR="${TB_EXTENSION_DIR:-/home/ubuntu/thundergate-dev/thunderbrowser}"
PROFILE_DIR="${TB_PROFILE_DIR:-$HOME/thundergate-chrome-profile}"
DEBUG_PORT="${TB_DEBUG_PORT:-9222}"
INITIAL_URL="${TB_INITIAL_URL:-http://localhost:7860}"

# CRX scratch dir — outside the repo, per-machine. The signing key here is
# what keeps the extension ID stable across rebuilds; lose it and you get a
# fresh ID, which would require rewriting the policy file under
# /opt/google/chrome/extensions/.
CRX_DIR="${TB_CRX_DIR:-$HOME/.thundergate/ext}"
SIGNING_KEY="$CRX_DIR/thunderbrowser-signing.pem"
CRX_FILE="$CRX_DIR/thunderbrowser.crx"

mkdir -p "$PROFILE_DIR" "$CRX_DIR"

CHROME_BIN=""
if [ -n "${TB_CHROME_BIN:-}" ]; then
  if [ -x "$TB_CHROME_BIN" ]; then
    CHROME_BIN="$TB_CHROME_BIN"
  else
    echo "launch-browser.sh: TB_CHROME_BIN=$TB_CHROME_BIN is not executable" >&2
    exit 1
  fi
else
  # Branded Chrome wins: snap Chromium can't read the CRX out of $HOME under
  # current home-interface confinement, so external_extensions installs fail.
  for candidate in \
    "$(command -v google-chrome || true)" \
    "$(command -v google-chrome-stable || true)" \
    "$(command -v chromium || true)" \
    "$(command -v chromium-browser || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      CHROME_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$CHROME_BIN" ]; then
  echo "launch-browser.sh: no Chrome binary found." >&2
  echo "Install: sudo apt-get install -y google-chrome-stable" >&2
  exit 1
fi

if [ ! -d "$EXTENSION_DIR" ]; then
  echo "launch-browser.sh: extension dir not found: $EXTENSION_DIR" >&2
  exit 1
fi

# Stage a clean copy of the extension into a scratch tree so pack-extension
# doesn't pull in node_modules / .git / dev tooling alongside the manifest.
STAGING="$CRX_DIR/stage"
rm -rf "$STAGING"
mkdir -p "$STAGING"
# Copy everything tracked-looking: manifest + background + content + icons +
# fixtures. Skip node_modules and any dotfiles.
for entry in manifest.json background content icons fixtures; do
  if [ -e "$EXTENSION_DIR/$entry" ]; then
    cp -r "$EXTENSION_DIR/$entry" "$STAGING/"
  fi
done

# Pack the extension. First boot generates the signing key; subsequent boots
# reuse it so the ID stays stable.
if [ ! -f "$SIGNING_KEY" ]; then
  echo "  → generating signing key (first boot)"
  "$CHROME_BIN" --no-sandbox --headless=new --pack-extension="$STAGING" >/dev/null 2>&1 || true
  if [ -f "$STAGING.pem" ]; then
    mv "$STAGING.pem" "$SIGNING_KEY"
    chmod 600 "$SIGNING_KEY"
  fi
fi
"$CHROME_BIN" --no-sandbox --headless=new \
  --pack-extension="$STAGING" \
  --pack-extension-key="$SIGNING_KEY" >/dev/null 2>&1 || true
if [ ! -f "$STAGING.crx" ]; then
  echo "launch-browser.sh: failed to pack extension into CRX" >&2
  exit 1
fi
mv "$STAGING.crx" "$CRX_FILE"

# Extension ID is the first 32 hex digits of sha256(pubkey-DER), mapped
# 0-9a-f → a-p. Compute it so we can log and so operators can verify it
# matches /opt/google/chrome/extensions/<EXT_ID>.json.
EXT_ID=$(openssl rsa -in "$SIGNING_KEY" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | head -c 16 | xxd -p -c 16 \
  | tr '0-9a-f' 'a-p' | tr -d ' \n')

echo "ThunderBrowser native launcher"
echo "  Chrome:     $CHROME_BIN"
echo "  Profile:    $PROFILE_DIR"
echo "  Extension:  $EXTENSION_DIR"
echo "  CRX:        $CRX_FILE"
echo "  Ext ID:     $EXT_ID"
echo "  DevTools:   http://127.0.0.1:$DEBUG_PORT"
echo "  Opening:    $INITIAL_URL"

# Chrome reads /opt/google/chrome/extensions/<EXT_ID>.json at startup and
# installs the CRX it references. We don't write that file here (it lives
# under /opt and would need sudo on every boot) — it's set up once via
# `scripts/install-extension-policy.sh`. The launcher only re-packs the CRX
# at the path that file already points to.
exec "$CHROME_BIN" \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-port="$DEBUG_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=ChromeWhatsNewUI \
  --window-size=1280,800 \
  "$INITIAL_URL"
