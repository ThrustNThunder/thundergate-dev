#!/bin/bash
# install-extension-policy.sh — write Chrome's external_extensions descriptor.
#
# Run once per host (and again whenever the signing key under ~/.thundergate/ext
# changes, since that would change the extension ID). Requires sudo to write
# under /opt/google/chrome/extensions/.
#
# Chrome installs any extension whose JSON descriptor sits in that directory at
# startup. We point it at the CRX that launch-browser.sh re-packs on each boot,
# and at the version recorded in the source manifest. Chrome refuses to load
# the CRX if external_version differs from the version inside the CRX, so this
# script reads manifest.json rather than hard-coding "0.1.0".

set -euo pipefail

CRX_DIR="${TB_CRX_DIR:-$HOME/.thundergate/ext}"
SIGNING_KEY="$CRX_DIR/thunderbrowser-signing.pem"
CRX_FILE="$CRX_DIR/thunderbrowser.crx"
EXTENSION_DIR="${TB_EXTENSION_DIR:-/home/ubuntu/thundergate-dev/thunderbrowser}"
POLICY_DIR="/opt/google/chrome/extensions"

if [ ! -f "$SIGNING_KEY" ] || [ ! -f "$CRX_FILE" ]; then
  echo "install-extension-policy.sh: CRX or signing key missing under $CRX_DIR." >&2
  echo "Run scripts/launch-browser.sh once first to generate them." >&2
  exit 1
fi

EXT_ID=$(openssl rsa -in "$SIGNING_KEY" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | head -c 16 | xxd -p -c 16 \
  | tr '0-9a-f' 'a-p' | tr -d ' \n')

EXT_VERSION=$(python3 -c "import json,sys; print(json.load(open('$EXTENSION_DIR/manifest.json'))['version'])")

echo "Installing external_extensions descriptor"
echo "  Ext ID:     $EXT_ID"
echo "  Version:    $EXT_VERSION"
echo "  CRX path:   $CRX_FILE"

sudo mkdir -p "$POLICY_DIR"
sudo tee "$POLICY_DIR/$EXT_ID.json" > /dev/null <<EOF
{
  "external_crx": "$CRX_FILE",
  "external_version": "$EXT_VERSION"
}
EOF

echo "  Wrote:      $POLICY_DIR/$EXT_ID.json"
