#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/restart_dashboard_$(date +%Y%m%d_%H%M%S).log"
IMAGE="localhost/ai-agent-dashboard:local"
SERVICE="ai-agent-dashboard.service"

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "Logging restart output to $LOG_FILE"

if ! command -v podman >/dev/null 2>&1; then
  if command -v distrobox-host-exec >/dev/null 2>&1; then
    podman() { distrobox-host-exec podman "$@"; }
  else
    echo "Error: podman not found and distrobox-host-exec is unavailable"
    exit 1
  fi
fi

if systemctl --user list-units --type=service --no-pager >/dev/null 2>&1; then
  _systemctl() { systemctl "$@"; }
elif command -v distrobox-host-exec >/dev/null 2>&1 && \
    distrobox-host-exec systemctl --user list-units --type=service --no-pager >/dev/null 2>&1; then
  _systemctl() { distrobox-host-exec systemctl "$@"; }
else
  echo "Error: unable to access user systemd from this environment"
  exit 1
fi

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

rebuild_image() {
  echo "Building $IMAGE..."
  podman build -t "$IMAGE" -f "$SCRIPT_DIR/Containerfile" "$SCRIPT_DIR"
}

restart_service() {
  echo "Restarting $SERVICE..."
  _systemctl --user restart "$SERVICE"
}

run_pre_restart_checks
rebuild_image
restart_service

echo "Dashboard service restarted successfully."
