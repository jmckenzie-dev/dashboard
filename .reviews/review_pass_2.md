# Code Review (Pass 2)

## Verdict
REQUEST CHANGES

## Summary
- Script is well-structured, clean, and the pass 1 remediations are correctly applied.
- One **blocker** remains: the PID file directory (`tmp/`) is not guaranteed to exist when `--use-prod-config` is used on a fresh checkout, causing the PID file write to fail under `set -e`, which orphans the server process.
- All pass 1 findings (1 blocker, 2 major, 4 minor, 1 nit) are properly remediated as described.
- README additions are correct and well-documented; minor omission of `TEST_DASHBOARD_PORT_STRICT=1`.
- No new regressions, style drift, or shellcheck/syntax issues.

## Blocking findings

- [Severity: Blocker] **Missing `mkdir -p "$SCRIPT_DIR/tmp"` — PID file write fails on fresh checkout with `--use-prod-config`**
  - Why this matters: The PID file at `$SCRIPT_DIR/tmp/test-dashboard-server.pid` is written at line 186, and the parent directory `tmp/` is only created implicitly by the config-isolation `mkdir -p` at line 163. When `--use-prod-config` is used, that branch is skipped and `tmp/` is never created. The redirection `echo "$SERVER_PID" > "$PID_FILE"` fails with "No such file or directory", `set -e` causes the script to exit immediately, and the background `node` server (already launched at line 184) becomes an orphan — still running, no PID file recorded, no cleanup trap active yet (the trap is set at line 259). On the next run, the orphan is not found because no PID file exists to read.
  - Evidence: Line 173 defines `PID_FILE="$SCRIPT_DIR/tmp/test-dashboard-server.pid"`. Line 186 writes to it. The only `mkdir` for a `tmp/` ancestor is at line 163: `mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"` (where `XDG_CONFIG_HOME="$SCRIPT_DIR/tmp/test-dashboard/config"`), which is skipped when `USE_PROD_CONFIG=true`. Reproduced with:
    ```bash
    mkdir -p /tmp/test_fresh && cd /tmp/test_fresh
    PID_FILE="tmp/test-dashboard-server.pid"
    echo "123" > "$PID_FILE"  # fails: No such file or directory
    ```
  - Recommended fix: Add `mkdir -p "$SCRIPT_DIR/tmp"` before the PID file is written. The logical location is alongside the log dir creation at line 54:
    ```bash
    mkdir -p "$SCRIPT_DIR/logs" "$SCRIPT_DIR/tmp"
    ```
    This ensures the `tmp/` directory exists regardless of the config-isolation path. The config-isolation `mkdir` at line 163 remains necessary for creating `test-dashboard/config` and `test-dashboard/data`.

## Non-blocking findings

- [Severity: Minor] **README omits `TEST_DASHBOARD_PORT_STRICT=1`**
  - Why this matters: The script supports `TEST_DASHBOARD_PORT_STRICT=1` to fail immediately when the preferred port is busy, which is a useful option for CI/automation. It is documented in the script's `--help` output but absent from the README.
  - Evidence: `start_test_dashboard.sh:29-30` documents `TEST_DASHBOARD_PORT_STRICT=1` in the help text. The README "Test Dashboard" section (lines 129–156) documents `TEST_DASHBOARD_PORT` but not `TEST_DASHBOARD_PORT_STRICT`.
  - Recommended fix: Add a brief note after the port-override example:
    ```markdown
    To fail immediately if the preferred port is busy:
    
    ```bash
    TEST_DASHBOARD_PORT=51000 TEST_DASHBOARD_PORT_STRICT=1 ./start_test_dashboard.sh
    ```
    ```

- [Severity: Minor] **Pre-existing `package.json` `start` script references `build/server.js` instead of `build/index.js`**
  - Why this matters: This is not introduced by the change, but the script correctly uses `build/index.js` (line 93, line 184) which matches the actual build output. The stale `package.json` entry (`"start": "node build/server.js"`) could confuse anyone comparing the two. Worth fixing if the test script is the new canonical launch method.
  - Evidence: `package.json:10` has `"start": "node build/server.js"` but the build produces `build/index.js` (confirmed: 345-line ES module with `import { handler } from './handler.js'`). The test script checks for `build/index.js` at line 93 and launches it at line 184.
  - Recommended fix (optional): Update `package.json` start script to match reality: `"start": "node build/index.js"`. Not required for this PR but worth a drive-by fix.

## Pass 1 finding verification

| Finding | Severity | Status | Evidence |
|---------|----------|--------|----------|
| PORT not exported to server | Blocker | ✅ **Fixed** | Line 184: `PORT="$PORT" HOST=127.0.0.1 node ...` inline export restored |
| git dep check removed | Major | ✅ **Fixed** | Line 76: `command -v git ... || missing_deps+=("git")` added |
| Redundant double arg parsing | Major | ✅ **Fixed** | Lines 37-51: single consolidated loop with `USE_PROD_CONFIG=true` set directly |
| `seq` not POSIX | Minor | ✅ **Fixed** | Line 196: replaced with `for ((i=0; i<30; i++))` |
| No port range validation | Minor | ✅ **Fixed** | Lines 121-124: range guard `-lt 1 \|\| -gt 65535` added |
| `exec > >(tee ...)` truncation | Minor | ⚠️ **Acknowledged, left as-is** | Acceptable for test script; no action taken per pass 1 decision |
| Readiness curl errors discarded | Minor | ⚠️ **Acknowledged, left as-is** | Acceptable for test script; logging available via `tail -20` timeout dump |
| `npm install` vs `npm ci` | Nit | ⚠️ **Acknowledged, left as-is** | Acceptable — worktree may not have lockfile |

All pass 1 findings are either properly remediated or intentionally left as-is per the agreed scope.

## Suggested next steps

1. **Fix blocker**: Add `mkdir -p "$SCRIPT_DIR/logs" "$SCRIPT_DIR/tmp"` at line 54 to guarantee `tmp/` exists for PID file writes.
2. **Fix minor README gap**: Add `TEST_DASHBOARD_PORT_STRICT=1` documentation to the "Test Dashboard" subsection.
3. **Drive-by**: Consider correcting `package.json`'s stale `"start": "node build/server.js"` to `"start": "node build/index.js"` if convenient.
4. **Final validation**: After changes, re-run `bash -n start_test_dashboard.sh && shellcheck start_test_dashboard.sh`.
