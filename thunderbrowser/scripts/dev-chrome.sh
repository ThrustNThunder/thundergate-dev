#!/usr/bin/env bash
# Launch a clean Chrome profile with ThunderBrowser (dev) loaded.
# The profile is isolated from Michael's real Chrome so a misbehaving dev
# build can't touch his real session.

set -euo pipefail
ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
EXT="$ROOT/extension"
PROFILE_DIR="${TB_PROFILE_DIR:-$HOME/.thunderbrowser-dev-profile}"

mkdir -p "$PROFILE_DIR"

case "$(uname -s)" in
  Darwin)
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ;;
  Linux)
    CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
    ;;
  *)
    echo "Unsupported OS" >&2
    exit 1
    ;;
esac

if [[ -z "${CHROME:-}" || ! -x "$CHROME" ]]; then
  echo "Chrome binary not found. Set TB_CHROME=/path/to/chrome and re-run." >&2
  exit 1
fi

echo "Profile: $PROFILE_DIR"
echo "Extension: $EXT"
echo "Launching $CHROME ..."
exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --load-extension="$EXT" \
  --no-first-run \
  --no-default-browser-check \
  "http://localhost:7860/aa/dashboard"
