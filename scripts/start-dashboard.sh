#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if [ ! -f "package.json" ]; then
  echo "Error: package.json not found"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ ! -f "${XDG_CONFIG_HOME:-$HOME/.config}/ai-dashboard/cert.pem" ]; then
  echo "Generating certificates..."
  ./scripts/generate-certs.sh
fi

echo "Building dashboard..."
npm run build

echo ""
echo "Starting AI Agent Dashboard on https://0.0.0.0:35001"
echo ""

npm run start:https &
PID=$!
echo "Server started with PID $PID"
