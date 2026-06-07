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
  echo "[ERROR] .env file not found! Create one with:"
  echo ""
  echo "  nano .env"
  echo ""
  echo "  EMAIL=your@email.com"
  echo "  PASSWORD=yourpassword"
  echo ""
  exit 1
fi

echo "[3/4] Installing Node dependencies (skipping Chromium download)..."
cd "$BOT_DIR"
rm -rf node_modules package-lock.json
PUPPETEER_SKIP_DOWNLOAD=true npm install --no-audit --no-fund
echo "Dependencies installed."

echo "[4/4] Detecting Chromium..."
CHROMIUM_PATH=""
for candidate in \
  "$(which chromium 2>/dev/null)" \
  "$(which chromium-browser 2>/dev/null)" \
  "$(which google-chrome 2>/dev/null)" \
  "$(which google-chrome-stable 2>/dev/null)" \
  "/usr/bin/chromium" \
  "/usr/bin/chromium-browser" \
  "/usr/bin/google-chrome" \
  "/usr/bin/google-chrome-stable" \
  "/snap/bin/chromium"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    CHROMIUM_PATH="$candidate"
    echo "Found Chromium: $CHROMIUM_PATH"
    break
  fi
done

if [ -z "$CHROMIUM_PATH" ]; then
  echo ""
  echo "[!] Chromium not found. Installing it now..."
  if command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq chromium-browser || \
    apt-get install -y -qq chromium || true
  elif command -v apt &>/dev/null; then
    apt update -qq && apt install -y -qq chromium-browser || \
    apt install -y -qq chromium || true
  fi

  for candidate in \
    "$(which chromium 2>/dev/null)" \
    "$(which chromium-browser 2>/dev/null)" \
    "/usr/bin/chromium" \
    "/usr/bin/chromium-browser"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      CHROMIUM_PATH="$candidate"
      echo "Chromium installed at: $CHROMIUM_PATH"
      break
    fi
  done
fi

if [ -z "$CHROMIUM_PATH" ]; then
  echo ""
  echo "[ERROR] Could not find or install Chromium."
  echo "Please install it manually:"
  echo "  sudo apt install chromium-browser"
  exit 1
fi

echo ""
echo "Starting AFK bot... (Press Ctrl+C to stop)"
echo ""
CHROMIUM_PATH="$CHROMIUM_PATH" node bot.js
