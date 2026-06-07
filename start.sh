#!/bin/bash

set -e

echo "=========================================="
echo "  AFK Bot - vektalnodes.in/earn"
echo "=========================================="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$SCRIPT_DIR/afk-bot"

echo "[1/5] Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js not installed. Install from https://nodejs.org"
  exit 1
fi
node --version

echo "[2/5] Locating .env file..."

if [ -f "$BOT_DIR/.env" ]; then
  echo "Found .env in afk-bot/"
elif [ -f "$SCRIPT_DIR/.env" ]; then
  echo "Found .env in repo root — copying into afk-bot/"
  cp "$SCRIPT_DIR/.env" "$BOT_DIR/.env"
elif [ -f "$(pwd)/.env" ]; then
  echo "Found .env in current directory — copying into afk-bot/"
  cp "$(pwd)/.env" "$BOT_DIR/.env"
else
  echo ""
  echo "[ERROR] .env file not found! Create one:"
  echo "  nano .env"
  echo "  EMAIL=your@email.com"
  echo "  PASSWORD=yourpassword"
  echo ""
  exit 1
fi

echo "[3/5] Installing Node dependencies..."
cd "$BOT_DIR"
rm -rf node_modules package-lock.json
PUPPETEER_SKIP_DOWNLOAD=true npm install --no-audit --no-fund
echo "Dependencies installed."

echo "[4/5] Detecting Chrome/Chromium + Xvfb..."

find_chrome() {
  for candidate in \
    "/usr/bin/google-chrome-stable" \
    "/usr/bin/google-chrome" \
    "/usr/local/bin/google-chrome" \
    "/usr/bin/chromium" \
    "/usr/bin/chromium-browser"; do
    if [ -x "$candidate" ]; then
      if file "$candidate" 2>/dev/null | grep -q "ELF"; then
        echo "$candidate"
        return
      elif [ "$candidate" != "/usr/bin/chromium-browser" ]; then
        echo "$candidate"
        return
      fi
    fi
  done
  for cmd in google-chrome-stable google-chrome chromium; do
    path="$(which "$cmd" 2>/dev/null || true)"
    if [ -n "$path" ] && [ -x "$path" ]; then
      if ! echo "$path" | grep -q "snap"; then
        echo "$path"
        return
      fi
    fi
  done
}

CHROMIUM_PATH="$(find_chrome)"

if [ -z "$CHROMIUM_PATH" ]; then
  echo "Chrome not found. Installing Google Chrome..."
  apt-get update -qq
  apt-get install -y -qq wget gnupg ca-certificates
  wget -q -O /tmp/google-chrome.deb \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq /tmp/google-chrome.deb || \
    dpkg -i /tmp/google-chrome.deb && apt-get -f install -y -qq
  rm -f /tmp/google-chrome.deb
  CHROMIUM_PATH="$(find_chrome)"
fi

if [ -z "$CHROMIUM_PATH" ]; then
  echo ""
  echo "[ERROR] Could not install Chrome. Try manually:"
  echo "  wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  echo "  dpkg -i google-chrome-stable_current_amd64.deb"
  echo "  apt-get -f install -y"
  exit 1
fi

echo "Using Chrome: $CHROMIUM_PATH"

# Install Xvfb (needed for puppeteer-real-browser headless: false)
if ! command -v Xvfb &>/dev/null; then
  echo "Xvfb not found. Installing..."
  apt-get update -qq
  apt-get install -y -qq xvfb
fi
echo "Xvfb: $(which Xvfb)"

echo "[5/5] Starting AFK bot with Xvfb virtual display..."
echo "(Press Ctrl+C to stop)"
echo ""

# Kill any leftover Xvfb on display :94 and remove stale lock
echo "Cleaning up any existing Xvfb on :94..."
pkill -f "Xvfb :94" 2>/dev/null || true
sleep 1
rm -f /tmp/.X94-lock /tmp/.X94-unix

# Start fresh Xvfb
Xvfb :94 -screen 0 1280x900x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2

# Verify Xvfb actually started
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[ERROR] Xvfb failed to start. Trying to remove stale lock and retry..."
  rm -f /tmp/.X94-lock /tmp/.X94-unix
  Xvfb :94 -screen 0 1280x900x24 -ac +extension GLX +render -noreset &
  XVFB_PID=$!
  sleep 2
fi

export DISPLAY=:94

echo "Display: $DISPLAY | Chrome: $CHROMIUM_PATH"
echo ""

# Trap Ctrl+C to cleanly kill Xvfb
cleanup() {
  echo ""
  echo "Stopping..."
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

CHROMIUM_PATH="$CHROMIUM_PATH" DISPLAY="$DISPLAY" node bot.js
