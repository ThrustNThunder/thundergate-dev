#!/bin/bash
# ThunderBrowser dev launcher — opens a fresh Chrome profile with the extension loaded.
#
# TB-0-9: separate profile (cookies/history empty), dev-only extension, no
# first-run prompts, no default-browser hijack. The profile lives under
# /tmp/thunderbrowser-dev-profile so it's wiped on reboot — by design, we
# don't want sticky dev state confusing the next test.

set -euo pipefail

CHROME_PROFILE="${TB_DEV_PROFILE:-/tmp/thunderbrowser-dev-profile}"
EXTENSION_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$CHROME_PROFILE"

# Pick the first available Chrome binary. macOS, Linux, and Chromium fallbacks.
CHROME_BIN=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "$(command -v google-chrome || true)" \
  "$(command -v google-chrome-stable || true)" \
  "$(command -v chromium || true)" \
  "$(command -v chromium-browser || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    CHROME_BIN="$candidate"
    break
  fi
done

if [ -z "$CHROME_BIN" ]; then
  echo "dev-chrome.sh: no Chrome/Chromium binary found." >&2
  echo "Install Chrome or set CHROME_BIN explicitly." >&2
  exit 1
fi

echo "ThunderBrowser dev launcher"
echo "  Chrome:    $CHROME_BIN"
echo "  Profile:   $CHROME_PROFILE"
echo "  Extension: $EXTENSION_DIR"

exec "$CHROME_BIN" \
  --user-data-dir="$CHROME_PROFILE" \
  --load-extension="$EXTENSION_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=ChromeWhatsNewUI \
  "$@"
