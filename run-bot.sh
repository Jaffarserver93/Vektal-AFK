#!/bin/bash
set -e

echo "=========================================="
echo "  AFK Bot - vektalnodes.in/earn"
echo "=========================================="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$SCRIPT_DIR/afk-bot"

echo "[1/4] Node.js: $(node --version)"

echo "[2/4] Setting up .env..."
if [ ! -f "$BOT_DIR/.env" ]; then
  if [ -f "$SCRIPT_DIR/.env" ]; then
    cp "$SCRIPT_DIR/.env" "$BOT_DIR/.env"
  else
    echo "[ERROR] No .env file found in afk-bot/ or repo root"
    exit 1
  fi
fi

echo "[3/4] Installing dependencies..."
cd "$BOT_DIR"
PUPPETEER_SKIP_DOWNLOAD=true npm install --no-audit --no-fund --silent

echo "[4/4] Starting Xvfb + bot..."

CHROMIUM_PATH="$(command -v chromium 2>/dev/null || command -v google-chrome-stable 2>/dev/null || command -v google-chrome 2>/dev/null || echo "")"
if [ -z "$CHROMIUM_PATH" ]; then
  echo "[ERROR] No Chrome/Chromium found"
  exit 1
fi
echo "Chrome: $CHROMIUM_PATH"

XVFB_PATH="$(command -v Xvfb 2>/dev/null || echo "")"
if [ -z "$XVFB_PATH" ]; then
  echo "[ERROR] Xvfb not found"
  exit 1
fi
echo "Xvfb: $XVFB_PATH"

pkill -f "Xvfb :94" 2>/dev/null || true
sleep 1
rm -f /tmp/.X94-lock /tmp/.X94-unix 2>/dev/null || true

"$XVFB_PATH" :94 -screen 0 1280x900x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[ERROR] Xvfb failed to start"
  exit 1
fi

echo "Xvfb running (PID $XVFB_PID)"

cleanup() {
  echo "Stopping Xvfb..."
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

export DISPLAY=:94
export CHROMIUM_PATH="$CHROMIUM_PATH"

echo ""
echo "Bot starting... (Ctrl+C to stop)"
echo ""
node bot.js
