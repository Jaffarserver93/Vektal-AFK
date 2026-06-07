#!/bin/bash

set -e

echo "=========================================="
echo "  AFK Bot - vektalnodes.in/earn"
echo "=========================================="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$SCRIPT_DIR/afk-bot"

echo "[1/4] Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js not installed. Install from https://nodejs.org"
  exit 1
fi
node --version

echo "[2/4] Locating .env file..."

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

echo "[3/4] Installing Node dependencies..."
cd "$BOT_DIR"
rm -rf node_modules package-lock.json
PUPPETEER_SKIP_DOWNLOAD=true npm install --no-audit --no-fund
echo "Dependencies installed."

echo "[4/4] Detecting Chrome/Chromium..."
CHROMIUM_PATH=""

find_chrome() {
  for candidate in \
    "/usr/bin/google-chrome-stable" \
    "/usr/bin/google-chrome" \
    "/usr/local/bin/google-chrome" \
    "/usr/bin/chromium" \
    "/snap/bin/chromium"; do
    if [ -x "$candidate" ]; then
      # Skip snap stubs (they fail without snapd)
      if file "$candidate" 2>/dev/null | grep -q "ELF"; then
        echo "$candidate"
        return
      elif [ "$candidate" != "/usr/bin/chromium-browser" ] && [ "$candidate" != "/snap/bin/chromium" ]; then
        echo "$candidate"
        return
      fi
    fi
  done
  # Try which, skip snap paths
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
echo ""
echo "Starting AFK bot... (Press Ctrl+C to stop)"
echo ""
CHROMIUM_PATH="$CHROMIUM_PATH" node bot.js
