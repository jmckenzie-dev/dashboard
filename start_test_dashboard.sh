#!/bin/bash
set -euo pipefail

# ──────────────────────────────────────────────
# start_test_dashboard.sh
# Build the current branch and launch a test
# dashboard on a randomized free port (>=50001).
# ──────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Help + arg parsing ────────────────────────
show_help() {
  cat <<EOF
Usage: $0 [OPTIONS]

Build the current branch and launch a test dashboard on a randomized
free port (>=50001).

Options:
  -h, --help              Show this help message and exit.
  --use-prod-config       Use production XDG config/data directories
                          instead of isolated tmp/test-dashboard.
                          (Also: TEST_DASHBOARD_USE_PROD_CONFIG=1)

Environment variables:
  TEST_DASHBOARD_PORT     Preferred port (auto-falls back if busy).
  TEST_DASHBOARD_PORT_STRICT=1
                          Exit with error if preferred port is in use.
  TEST_DASHBOARD_USE_PROD_CONFIG=1
                          Same as --use-prod-config.
EOF
  exit 0
}

USE_PROD_CONFIG=false
for arg in "$@"; do
  case "$arg" in
    -h|--help) show_help ;;
    --use-prod-config) USE_PROD_CONFIG=true ;;
    *)
      echo "ERROR: Unknown argument: $arg" >&2
      echo "Run '$0 --help' for usage." >&2
      exit 1
      ;;
  esac
done
if [ "${TEST_DASHBOARD_USE_PROD_CONFIG:-}" = "1" ]; then
  USE_PROD_CONFIG=true
fi

# ── Log setup ─────────────────────────────────
mkdir -p "$SCRIPT_DIR/logs"
LOG_FILE="$SCRIPT_DIR/logs/start_test_dashboard_$(date +%Y%m%d_%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

# ── Banner ────────────────────────────────────
BRANCH="$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '<unknown>')"
SHA="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo '<unknown>')"

echo "═══════════════════════════════════════════"
echo "  Test Dashboard Launcher"
echo "═══════════════════════════════════════════"
echo "  Branch:   $BRANCH"
echo "  Commit:   $SHA"
echo "  Worktree: $SCRIPT_DIR"
echo "  Log:      $LOG_FILE"
echo "═══════════════════════════════════════════"
echo ""

# ── Dependency check ──────────────────────────
missing_deps=()
command -v node  >/dev/null 2>&1 || missing_deps+=("node")
command -v npm   >/dev/null 2>&1 || missing_deps+=("npm")
command -v git   >/dev/null 2>&1 || missing_deps+=("git")
command -v ss    >/dev/null 2>&1 || missing_deps+=("ss (iproute2)")

if [ ${#missing_deps[@]} -gt 0 ]; then
  echo "ERROR: Missing required tools: ${missing_deps[*]}" >&2
  exit 1
fi

# ── Ensure deps ───────────────────────────────
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# ── Build ─────────────────────────────────────
echo "Building..."
npm run build
if [ ! -f "build/index.js" ]; then
  echo "ERROR: Build succeeded but build/index.js not found." >&2
  exit 1
fi
echo "Build complete."
echo ""

# ── Port selection ────────────────────────────
pick_port() {
  local base
  if command -v shuf &>/dev/null; then
    base=$(shuf -i 50001-59999 -n 1)
  else
    base=$(( (RANDOM % 9999) + 50001 ))
  fi

  # Allow override via env (must be numeric)
  if [ -n "${TEST_DASHBOARD_PORT:-}" ]; then
    case "$TEST_DASHBOARD_PORT" in
      ''|*[!0-9]*)
        echo "ERROR: TEST_DASHBOARD_PORT must be a number, got '$TEST_DASHBOARD_PORT'" >&2
        return 1
        ;;
    esac
    base="$TEST_DASHBOARD_PORT"
  fi

  # Validate port range
  if [ "$base" -lt 1 ] || [ "$base" -gt 65535 ]; then
    echo "ERROR: Invalid port $base (must be 1-65535)." >&2
    return 1
  fi

  local port="$base"
  local attempt=0
  while [ "$attempt" -lt 200 ]; do
    # Check if port is free (v4 or v6)
    if ! ss -Hltn "sport = :$port" 2>/dev/null | grep -q .; then
      echo "$port"
      return 0
    fi
    # If caller set a specific port and strict mode is on, fail
    if [ -n "${TEST_DASHBOARD_PORT:-}" ] && [ "${TEST_DASHBOARD_PORT_STRICT:-}" = "1" ]; then
      echo "ERROR: Port $port is in use and TEST_DASHBOARD_PORT_STRICT=1 is set." >&2
      return 1
    fi
    attempt=$((attempt + 1))
    port=$((port + 1))
    [ "$port" -gt 60000 ] && port=50001
  done

  echo "ERROR: Could not find a free port after 200 attempts." >&2
  return 1
}

PORT=$(pick_port) || exit 1
echo "Selected port: $PORT"

# ── Config/data isolation ────────────────────
if [ "$USE_PROD_CONFIG" = true ]; then
  echo ""
  echo "⚠ WARNING: Using production config/data directories."
  echo "   Settings writes will affect your real dashboard config."
  echo "   XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config/ai-dashboard}"
  echo "   XDG_DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share/ai-dashboard}"
  echo ""
else
  TEST_HOME="$SCRIPT_DIR/tmp/test-dashboard"
  export XDG_CONFIG_HOME="$TEST_HOME/config"
  export XDG_DATA_HOME="$TEST_HOME/data"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
  echo "Using isolated config/data: $TEST_HOME"
fi

# ── Start server ──────────────────────────────
echo ""
echo "Starting test dashboard..."

# PID file for orphan cleanup: kill any stale server from a previous
# ungraceful exit before launching a new one.
PID_FILE="$SCRIPT_DIR/tmp/test-dashboard-server.pid"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Killing stale server (pid $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

PORT="$PORT" HOST=127.0.0.1 node "$SCRIPT_DIR/build/index.js" &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"
echo "Server PID: $SERVER_PID"

# ── Wait for readiness ────────────────────────
# Strategy: confirm TCP listener via ss, then try an HTTP probe (any
# response — including 401 — means the server is up). ss alone is
# sufficient when curl is absent (a listening socket means the server
# process accepted the connection).
echo "Waiting for server to be ready..."
ready=false
for ((i=0; i<30; i++)); do
  sleep 1
  # Check if process is still alive
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: Server process exited prematurely." >&2
    wait "$SERVER_PID" || true
    exit 1
  fi
  # Check TCP listener via ss
  if ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; then
    # HTTP probe: any response (incl. 401) means server is up.
    # Use short timeouts so one hung probe doesn't exhaust the budget.
    if command -v curl &>/dev/null; then
      if curl -sS --connect-timeout 2 --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        ready=true
        break
      fi
    else
      # No curl: ss listener is sufficient evidence.
      ready=true
      break
    fi
  fi
done

if [ "$ready" != true ]; then
  echo "ERROR: Server did not become ready within 30 seconds." >&2
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  echo "--- Last log lines ---"
  tail -20 "$LOG_FILE" 2>/dev/null || true
  exit 1
fi

echo "Server is ready."

# ── Print result ──────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  Test dashboard ready!"
echo ""
echo "  http://127.0.0.1:${PORT}"
echo ""
echo "  Branch:   $BRANCH"
echo "  Commit:   $SHA"
echo "  PID:      $SERVER_PID"
echo "  Log:      $LOG_FILE"
echo "  Config:   $([ "$USE_PROD_CONFIG" = true ] && echo 'production (shared)' || echo 'isolated (tmp/test-dashboard)')"
echo ""
echo "  Stop:     kill $SERVER_PID  or  Ctrl-C"
echo "═══════════════════════════════════════════"
echo ""

# ── Foreground + cleanup ─────────────────────
_cleaned=false
cleanup() {
  ${_cleaned} && return
  _cleaned=true
  kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo ""
  echo "Stopped test dashboard (pid $SERVER_PID)"
}
trap cleanup INT TERM EXIT

# Wait in foreground. || true prevents set -e abort if the server
# exits between the readiness check and this wait.
wait "$SERVER_PID" || true
