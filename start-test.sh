#!/bin/bash
# Run test-linkpays.js with Xvfb virtual display
# Usage: bash start-test.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$SCRIPT_DIR/afk-bot"

echo "=========================================="
echo "  LinkPays Test Runner"
echo "=========================================="

# .env check
if [ -f "$BOT_DIR/.env" ]; then
  echo "Found .env in afk-bot/"
elif [ -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env" "$BOT_DIR/.env"
  echo "Copied .env from repo root"
else
  echo "[ERROR] .env not found"
  exit 1
fi

cd "$BOT_DIR"

# Install deps if needed
if [ ! -d "node_modules/puppeteer-real-browser" ]; then
  echo "Installing dependencies..."
  PUPPETEER_SKIP_DOWNLOAD=true npm install --no-audit --no-fund
fi

# Find Chrome
find_chrome() {
  for c in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/local/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
    [ -x "$c" ] && echo "$c" && return
  done
  which google-chrome-stable 2>/dev/null || which google-chrome 2>/dev/null || which chromium 2>/dev/null || true
}
CHROMIUM_PATH="$(find_chrome)"
if [ -z "$CHROMIUM_PATH" ]; then
  echo "[ERROR] Chrome not found. Run: bash start.sh (auto-installs Chrome)"
  exit 1
fi
echo "Chrome: $CHROMIUM_PATH"

# Install Xvfb if missing
if ! command -v Xvfb &>/dev/null; then
  echo "Installing Xvfb..."
  apt-get update -qq && apt-get install -y -qq xvfb
fi

# Start Xvfb
echo "Starting Xvfb on :94..."
Xvfb :94 -screen 0 1280x900x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2

export DISPLAY=:94
export CHROMIUM_PATH="$CHROMIUM_PATH"

cleanup() {
  echo "Cleaning up..."
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo ""
echo "Running test-linkpays.js..."
echo "Screenshots will be saved to: afk-bot/screenshots/"
echo "(Press Ctrl+C to stop)"
echo ""

node test-linkpays.js
