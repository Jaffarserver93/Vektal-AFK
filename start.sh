#!/bin/bash

set -e

echo "=========================================="
echo "  AFK Bot - vektalnodes.in/earn"
echo "=========================================="

cd "$(dirname "$0")/afk-bot"

if [ ! -f ".env" ]; then
  echo ""
  echo "[ERROR] .env file not found inside afk-bot/"
  echo "Create it from the example:"
  echo ""
  echo "  cp afk-bot/.env.example afk-bot/.env"
  echo "  nano afk-bot/.env   # fill in your EMAIL and PASSWORD"
  echo ""
  exit 1
fi

echo "[1/3] Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js is not installed."
  echo "Install it from https://nodejs.org or via your package manager."
  exit 1
fi
node --version

echo "[2/3] Installing dependencies (this downloads Chromium on first run)..."
npm install

echo "[3/3] Starting AFK bot..."
echo ""
node bot.js
