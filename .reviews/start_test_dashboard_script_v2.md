# Code Review

## Verdict
REQUEST CHANGES

## Summary
- Solid overall structure: clear sections, proper `set -euo pipefail`, dependency checks, and a well-thought-out readiness probe with graceful fallbacks.
- **One blocker**: `exit` calls inside `pick_port` are swallowed by command substitution — a dead error path that silently produces an empty `$PORT` and wrong behavior.
- **One blocker**: `curl` in the readiness loop has no timeout — a single stalled HTTP probe wastes the entire 30-second budget.
- Argument parsing is done twice (`$@` scanned in two separate places); the logic is correct but unnecessarily duplicated.
- No orphan cleanup for SIGKILL scenarios: the server leaks if the script is killed ungracefully, which matters in test-automation contexts.

## Blocking findings

- [Severity: Blocker] **`pick_port` subshell `exit` doesn't propagate to the parent script**
  - Why this matters: when `pick_port` fails (all ports busy, or `TEST_DASHBOARD_PORT_STRICT` hit), `exit 1` runs inside `$(...)` and terminates only the subshell. With `set -e`, a simple assignment `PORT=$(pick_port)` does **not** cause the script to exit — `$PORT` is set to the empty string, and execution continues with an unset port.
  - Evidence: `start_test_dashboard.sh:135` — `PORT=$(pick_port)`. In bash, `x=$(exit 1)` under `set -e` produces an exit code of 0 for the assignment itself (POSIX special-cases assignments from command substitution). Lines 124 and 132 inside `pick_port` are dead code paths from the parent's perspective.
  - Recommended fix: append `|| exit 1` to the assignment:
    ```bash
    PORT=$(pick_port) || exit 1
    ```
    Alternatively, replace the subshell with a mutable global variable approach, but the `|| exit 1` is the minimal correct change.

- [Severity: Blocker] **`curl` readiness probe can hang forever (no timeout)**
  - Why this matters: the 30-second readiness loop calls `curl -sS -o /dev/null "http://127.0.0.1:$PORT/"` with **no** `--connect-timeout` or `--max-time`. If the server process is alive but the HTTP listener is wedged (or the network stack behaves oddly in a container), a single `curl` invocation can block for the kernel's default TCP connect timeout (typically 60–120 seconds). The `for _ in $(seq 1 30)` loop fully exhausts its budget waiting for one hung probe, and the server is falsely declared unhealthy.
  - Evidence: `start_test_dashboard.sh:190`.
  - Recommended fix: add a short timeout:
    ```bash
    if curl -sS --connect-timeout 2 --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    ```
    Since `ss` has already confirmed the TCP listener exists, a 2-second connect timeout is generous; 5-second max-time handles any stall in the HTTP response.

## Non-blocking findings

- [Severity: Major] **No PID file or process-group tracking — orphan risk on SIGKILL**
  - Why this matters: if the script receives `SIGKILL` (kill -9), the `trap cleanup INT TERM EXIT` never fires. The background server process becomes an orphan and continues listening. The next script invocation finds the port occupied and picks a different one, quietly leaking ports and accumulating zombie servers.
  - Evidence: `start_test_dashboard.sh:167-168, 236-243`. Cleanup is trap-only; no PID file is written or checked at startup.
  - Recommended fix: write `$SERVER_PID` to a well-known file on startup, and `kill` any previous PID from that file before launching:
    ```bash
    PID_FILE="$SCRIPT_DIR/tmp/test-dashboard-server.pid"
    if [ -f "$PID_FILE" ]; then
      old_pid=$(cat "$PID_FILE")
      kill "$old_pid" 2>/dev/null || true
    fi
    echo "$SERVER_PID" > "$PID_FILE"
    ```
    Then also `rm -f "$PID_FILE"` in `cleanup`. This is a follow-up; not blocking for a dev-only script.

- [Severity: Major] **`TEST_DASHBOARD_PORT` is not validated**
  - Why this matters: a user sets `export TEST_DASHBOARD_PORT=abc`. The script enters `pick_port`, sets `base=abc`, hits `attempt=$((attempt + 1))`, and bash errors with `value too great for base` (arithmetic error under `set -e`). The error message is cryptic.
  - Evidence: `start_test_dashboard.sh:109-111` sets `base` from the env var with no numeric guard. Line 127 `port=$((port + 1))` then crashes on a non-numeric value.
  - Recommended fix: add an explicit numeric check after the override:
    ```bash
    if [ -n "${TEST_DASHBOARD_PORT:-}" ]; then
      case "$TEST_DASHBOARD_PORT" in
        ''|*[!0-9]*) echo "ERROR: TEST_DASHBOARD_PORT must be a number, got '$TEST_DASHBOARD_PORT'" >&2; exit 1 ;;
      esac
      base="$TEST_DASHBOARD_PORT"
    fi
    ```

- [Severity: Major] **Argument parsing done twice — duplicate `$@` scan**
  - Why this matters: `$@` is iterated at lines 37-47 (for validation and help) and again at lines 140-147 (for `USE_PROD_CONFIG` flag). The validation loop has an empty `--use-prod-config)` case, so it recognizes but doesn't process the flag. This is two maintenance surfaces that must stay in sync.
  - Evidence: lines 37-47 vs lines 140-147.
  - Recommended fix: fold the `USE_PROD_CONFIG` detection into the single argument loop:
    ```bash
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
    ```
    Then remove lines 139-147 entirely; the env-var fallback can be a single line after the loop:
    ```bash
    [ "${TEST_DASHBOARD_USE_PROD_CONFIG:-}" = "1" ] && USE_PROD_CONFIG=true
    ```

- [Severity: Minor] **TCP probe uses `node -e` — heavyweight for a connectivity check**
  - Why this matters: spawning a full Node.js process just to check if a TCP port is open is expensive (~100ms startup) and fragile (depends on `node` module resolution). The `ss` listener check on line 186 already confirms the port is accepting connections, and `ss` is a required dependency.
  - Evidence: line 200.
  - Recommended fix: drop the `node` TCP probe entirely and use only `ss` + `curl` (with the timeout fix above). If `ss` sees a listener and `curl` (when present) gets a response, the server is up. When curl is absent, `ss` alone is sufficient — a listening TCP socket on a known port is strong evidence the server is accepting connections.

- [Severity: Nit] **Empty `;;` case in argument switch**
  - Evidence: line 40 `--use-prod-config) ;;`
  - Would be resolved by the combined parsing fix above.

- [Severity: Nit] **Port randomization prefers `shuf` over bash `$RANDOM`**
  - Evidence: line 102-106. `shuf` adds a dependency path; `$RANDOM` is available in every bash and is sufficient for test-port randomization. Not wrong, just unnecessary branching.

## Simplicity and design notes (KISS/YAGNI/DRY/SOLID)

- **KISS**: the script is mostly straightforward. Sections are well-commented and the readiness probe strategy is documented inline, which is good.
- **Violation: DRY**: argument parsing is duplicated (see Major finding above). The `$@` loop should appear exactly once.
- **Violation: YAGNI (minor)**: the `shuf`-vs-`RANDOM` fork and the `node` TCP-probe fallback both add branching complexity for edge cases that the existing hard dependencies (`bash`, `ss`) already cover. Removing them makes the script simpler without losing capability.
- **No over-engineering**: the script does not define unnecessary abstractions, config files, or subcommands. The `pick_port` function is appropriately scoped and local.

## Test gaps

As a bash script in a project with no test framework, the current test coverage is:

1. **No automated tests exist** for this script. At minimum, the following cases should be verified manually after changes:
   - Nominal: script builds and starts dashboard on a free port.
   - Port exhaustion: simulate all ports 50001–60000 as busy (e.g., by binding them) — verify clean error message and exit.
   - `TEST_DASHBOARD_PORT_STRICT`: set a busy port + strict mode — verify error.
   - `TEST_DASHBOARD_PORT` invalid (non-numeric) — verify clear error.
   - `--use-prod-config` — verify config/data paths point to production dirs.
   - Missing deps (node, npm, ss) — verify error message lists each missing tool.
   - `kill -9` scenario — verify PID file cleanup or note the orphan risk.

2. **Unit-level bash testing** (e.g., `bats`) is appropriate for a script this size but should be added as a follow-up, not gating this change.

## Suggested next steps

1. **Fix Blocker 1**: append `|| exit 1` to `PORT=$(pick_port)` on line 135.
2. **Fix Blocker 2**: add `--connect-timeout 2 --max-time 5` to the `curl` invocation on line 190.
3. **Fix Major (arg parsing)**: merge the two `$@` loops into one.
4. **Fix Major (port validation)**: add a numeric guard for `TEST_DASHBOARD_PORT`.
5. **Consider PID file**: write `$SERVER_PID` to `tmp/test-dashboard-server.pid` and clean up stale PIDs on startup.
6. **Test manually**: run through the cases listed in the test gaps section.
