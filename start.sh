#!/bin/bash
set -e

echo "=========================================="
echo "  AFK Bot - vektalnodes.in/earn"
echo "=========================================="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-detect BOT_DIR: works whether run from repo root OR from inside afk-bot/
if [ -f "$SCRIPT_DIR/bot.js" ]; then
  BOT_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/afk-bot/bot.js" ]; then
  BOT_DIR="$SCRIPT_DIR/afk-bot"
else
  echo "[ERROR] Cannot find bot.js."
  echo "  Run this script from the repo root or from inside the afk-bot/ folder."
  exit 1
fi

echo "[1/5] Node.js: $(node --version 2>/dev/null || echo 'NOT FOUND')"
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js not installed. Get it from https://nodejs.org"
  exit 1
fi

echo "[2/5] Setting up .env..."
if [ -f "$BOT_DIR/.env" ]; then
  echo "  Found .env in $BOT_DIR"
elif [ -f "$SCRIPT_DIR/.env" ]; then
  echo "  Copying .env from $SCRIPT_DIR"
  cp "$SCRIPT_DIR/.env" "$BOT_DIR/.env"
elif [ -f "$(pwd)/.env" ]; then
  echo "  Copying .env from $(pwd)"
  cp "$(pwd)/.env" "$BOT_DIR/.env"
else
  echo ""
  echo "[ERROR] .env file not found! Create one:"
  echo "  nano $BOT_DIR/.env"
  echo ""
  echo "  EMAIL=your@email.com"
  echo "  PASSWORD=yourpassword"
  echo ""
  exit 1
fi

echo "[3/5] Installing Node dependencies..."
cd "$BOT_DIR"
# Force public npm registry — Replit sets npm_config_registry as an env var
# which overrides even the --registry flag, so we must unset it first
unset npm_config_registry
npm config set registry https://registry.npmjs.org 2>/dev/null || true
PUPPETEER_SKIP_DOWNLOAD=true npm install --no-audit --no-fund --registry https://registry.npmjs.org
echo "  Dependencies installed."

echo "[4/5] Detecting Chrome/Chromium..."
find_chrome() {
  for candidate in \
    "/usr/bin/google-chrome-stable" \
    "/usr/bin/google-chrome" \
    "/usr/local/bin/google-chrome" \
    "/usr/bin/chromium" \
    "/usr/bin/chromium-browser"; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  for cmd in google-chrome-stable google-chrome chromium chromium-browser; do
    path="$(which "$cmd" 2>/dev/null || true)"
    if [ -n "$path" ] && [ -x "$path" ]; then echo "$path"; return; fi
  done
  nix_chrome="$(find /nix/store -name 'chromium' -type f 2>/dev/null | head -1 || true)"
  if [ -n "$nix_chrome" ]; then echo "$nix_chrome"; return; fi
}

CHROMIUM_PATH="$(find_chrome)"
if [ -z "$CHROMIUM_PATH" ]; then
  echo "  Chrome not found — trying to install via apt-get..."
  if command -v apt-get &>/dev/null; then
    apt-get update -qq
    apt-get install -y -qq wget gnupg ca-certificates
    wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    dpkg -i /tmp/chrome.deb 2>/dev/null || apt-get -f install -y -qq
    rm -f /tmp/chrome.deb
    CHROMIUM_PATH="$(find_chrome)"
  fi
fi
if [ -z "$CHROMIUM_PATH" ]; then
  echo "[ERROR] Chrome not found. Install with: apt-get install -y chromium-browser"
  exit 1
fi
echo "  Chrome: $CHROMIUM_PATH"

echo "[5/5] Detecting Xvfb (virtual display)..."
find_xvfb() {
  for candidate in "/usr/bin/Xvfb" "/usr/local/bin/Xvfb"; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  path="$(which Xvfb 2>/dev/null || true)"
  if [ -n "$path" ]; then echo "$path"; return; fi
  nix_xvfb="$(find /nix/store -name 'Xvfb' -type f 2>/dev/null | head -1 || true)"
  if [ -n "$nix_xvfb" ]; then echo "$nix_xvfb"; return; fi
}

XVFB_PATH="$(find_xvfb)"
if [ -z "$XVFB_PATH" ]; then
  echo "  Xvfb not found — trying to install via apt-get..."
  if command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq xvfb
    XVFB_PATH="$(find_xvfb)"
  fi
fi
if [ -z "$XVFB_PATH" ]; then
  echo "[ERROR] Xvfb not found. Install with: apt-get install -y xvfb"
  exit 1
fi
echo "  Xvfb: $XVFB_PATH"

echo ""
echo "Starting virtual display + bot..."
echo "(Press Ctrl+C to stop)"
echo ""

pkill -f "Xvfb :94" 2>/dev/null || true
sleep 1
rm -f /tmp/.X94-lock /tmp/.X94-unix 2>/dev/null || true

"$XVFB_PATH" :94 -screen 0 1280x900x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "  Xvfb failed — removing stale lock and retrying..."
  rm -f /tmp/.X94-lock /tmp/.X94-unix 2>/dev/null || true
  "$XVFB_PATH" :94 -screen 0 1280x900x24 -ac +extension GLX +render -noreset &
  XVFB_PID=$!
  sleep 2
fi

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[ERROR] Xvfb could not start."
  exit 1
fi

echo "Xvfb running (PID $XVFB_PID)"

cleanup() {
  echo "Stopping..."
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

export DISPLAY=:94
export CHROMIUM_PATH="$CHROMIUM_PATH"

node bot.js
