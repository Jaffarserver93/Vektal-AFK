#!/bin/bash

set -e

echo "=========================================="
echo "  AFK Bot - vektalnodes.in/earn"
echo "=========================================="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$SCRIPT_DIR/afk-bot"

echo "[1/4] Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js is not installed."
  echo "Install it from https://nodejs.org"
  exit 1
fi
node --version

echo "[2/4] Locating .env file..."

ENV_FILE=""

if [ -f "$BOT_DIR/.env" ]; then
  ENV_FILE="$BOT_DIR/.env"
  echo "Found .env in afk-bot/"
elif [ -f "$SCRIPT_DIR/.env" ]; then
  ENV_FILE="$SCRIPT_DIR/.env"
  echo "Found .env in repo root — copying into afk-bot/"
  cp "$SCRIPT_DIR/.env" "$BOT_DIR/.env"
elif [ -f "$(pwd)/.env" ]; then
  ENV_FILE="$(pwd)/.env"
  echo "Found .env in current directory — copying into afk-bot/"
  cp "$(pwd)/.env" "$BOT_DIR/.env"
else
  echo ""
  echo "[ERROR] .env file not found! Create it with your credentials:"
  echo ""
  echo "  Option A — put it in the afk-bot/ folder:"
  echo "    nano afk-bot/.env"
  echo ""
  echo "  Option B — put it in the same folder as start.sh:"
  echo "    nano .env"
  echo ""
  echo "Contents of .env should be:"
  echo "    EMAIL=your@email.com"
  echo "    PASSWORD=yourpassword"
  echo ""
  exit 1
fi

echo "[3/4] Installing dependencies..."
cd "$BOT_DIR"
npm install --silent

echo "[4/4] Starting AFK bot... (Press Ctrl+C to stop)"
echo ""
node bot.js
