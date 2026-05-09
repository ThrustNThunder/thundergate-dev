#!/bin/bash
#
# ThunderGate One-Command Installer
# https://thunderai.us/admin/install.sh
#
# Usage:
#   curl -fsSL https://thunderai.us/admin/install.sh | bash
#   curl -fsSL https://thunderai.us/admin/install.sh | bash -s -- --service
#

set -e

THUNDERGATE_DIR="$HOME/.thundergate"
REPO_URL="https://github.com/ThrustNThunder/thundergate.git"

echo "⚡ ThunderGate Installer"
echo "========================"
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo "   Install: https://nodejs.org/ or 'nvm install 20'"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ required. Found: $(node -v)"
    exit 1
fi
echo "  ✓ Node.js $(node -v)"

if ! command -v git &> /dev/null; then
    echo "❌ Git is required but not installed."
    exit 1
fi
echo "  ✓ Git $(git --version | cut -d' ' -f3)"

if ! command -v npm &> /dev/null; then
    echo "❌ npm is required but not installed."
    exit 1
fi
echo "  ✓ npm $(npm -v)"

echo ""

# Clone or update
if [ -d "$THUNDERGATE_DIR" ]; then
    echo "Updating existing installation..."
    cd "$THUNDERGATE_DIR"
    git fetch origin
    git reset --hard origin/master
    echo "  ✓ Updated to latest"
else
    echo "Installing ThunderGate..."
    git clone "$REPO_URL" "$THUNDERGATE_DIR"
    echo "  ✓ Cloned repository"
fi

cd "$THUNDERGATE_DIR"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install --production
echo "  ✓ Dependencies installed"

# Build TypeScript
echo ""
echo "Building..."
npm run build 2>/dev/null || echo "  ⚠ Build step skipped (dev mode)"

# Create config directory
mkdir -p "$THUNDERGATE_DIR/config"
mkdir -p "$THUNDERGATE_DIR/data"

# Create default config if not exists
if [ ! -f "$THUNDERGATE_DIR/config/config.json" ]; then
    cat > "$THUNDERGATE_DIR/config/config.json" << 'CONFIGEOF'
{
  "version": "0.1.0",
  "model": {
    "mode": "auto",
    "primary": "anthropic/claude-sonnet-4-6",
    "reasoning": "anthropic/claude-opus-4-5"
  },
  "doctor": {
    "enabled": true,
    "intervalMs": 30000
  }
}
CONFIGEOF
    echo "  ✓ Default config created"
fi

# Create CLI symlink
echo ""
echo "Setting up CLI..."
mkdir -p "$HOME/.local/bin"

cat > "$HOME/.local/bin/thundergate" << 'CLIEOF'
#!/bin/bash
node "$HOME/.thundergate/dist/cli/main.js" "$@"
CLIEOF
chmod +x "$HOME/.local/bin/thundergate"

# Add to PATH if needed
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
    echo "  ⚠ Added ~/.local/bin to PATH (restart shell or run: source ~/.bashrc)"
fi
echo "  ✓ CLI installed: thundergate"

# Install systemd service if requested
if [ "$1" = "--service" ]; then
    echo ""
    echo "Installing systemd service..."
    
    sudo tee /etc/systemd/system/thundergate.service > /dev/null << SERVICEEOF
[Unit]
Description=ThunderGate Runtime
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$THUNDERGATE_DIR
ExecStart=/usr/bin/node $THUNDERGATE_DIR/dist/core/runtime.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SERVICEEOF

    sudo systemctl daemon-reload
    sudo systemctl enable thundergate
    sudo systemctl start thundergate
    echo "  ✓ Service installed and started"
fi

echo ""
echo "⚡ ThunderGate installed successfully!"
echo ""
echo "Location: $THUNDERGATE_DIR"
echo ""
echo "Commands:"
echo "  thundergate start     Start runtime"
echo "  thundergate stop      Stop runtime"
echo "  thundergate status    Show status"
echo "  thundergate doctor    Run diagnostics"
echo ""
echo "To install as service: curl ... | bash -s -- --service"
echo ""
