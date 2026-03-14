#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_SCRIPT="$SCRIPT_DIR/scripts/start-dashboard.sh"
LOG_DIR="$SCRIPT_DIR/tmp"
LOG_FILE="$LOG_DIR/dashboard-restart.log"
PORT="35001"

if [ ! -f "$START_SCRIPT" ]; then
  echo "Error: start script not found at $START_SCRIPT"
  exit 1
fi

mkdir -p "$LOG_DIR"

stop_dashboard() {
  local pids=""

  if command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]\+' | cut -d= -f2 | sort -u | tr '\n' ' ' || true)"
  fi

  if [ -z "$pids" ]; then
    pids="$(pgrep -f "$START_SCRIPT|ai-agent-dashboard|build/index.js|start:https" | tr '\n' ' ' || true)"
  fi

  if [ -n "$pids" ]; then
    echo "Stopping dashboard processes: $pids"
    kill $pids 2>/dev/null || true

    sleep 2

    local remaining
    remaining="$(for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then
        printf '%s ' "$pid"
      fi
    done)"

    if [ -n "$remaining" ]; then
      echo "Force stopping remaining processes: $remaining"
      kill -9 $remaining 2>/dev/null || true
    fi
  else
    echo "Dashboard is not currently running."
  fi
}

start_dashboard() {
  echo "Starting dashboard..."
  bash "$START_SCRIPT" >>"$LOG_FILE" 2>&1 &
}

run_pre_restart_checks() {
  echo "Running npm run check..."
  (
    cd "$SCRIPT_DIR"
    npm run check
  )

  echo "Running npm run build..."
  (
    cd "$SCRIPT_DIR"
    npm run build
  )
}

run_pre_restart_checks
stop_dashboard
start_dashboard
