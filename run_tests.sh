#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

mkdir -p logs
timestamp="$(date +%Y%m%d_%H%M%S)"
log_file="logs/run_tests_${timestamp}.log"

exec > >(tee "$log_file") 2>&1

echo "Logging test output to $ROOT_DIR/$log_file"

run_long=false
for arg in "$@"; do
  case "$arg" in
    --long) run_long=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

echo "Running npm run check..."
npm run check

echo "Running npm run build..."
npm run build

echo "Running dashboard API property check..."
node scripts/property-test-agents-api.mjs

echo "Running status inference self-test..."
node scripts/test-status-inference.mjs

if [[ "$run_long" == "true" ]]; then
  echo "No long-running dashboard tests are currently defined."
fi

echo "All dashboard checks passed."
