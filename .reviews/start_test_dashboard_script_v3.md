# Code Review

## Verdict
APPROVE

## Summary
- All 7 findings from the previous review (`pick_port` exit propagation, curl timeout, arg dedup, numeric validation, PID file, node probe removal, `build/index.js`) have been correctly fixed.
- The script is well-structured, with clear sections, extracted helpers, and disciplined error checking throughout.
- I found no blocking issues. The remaining findings are maintainability nits and one portability edge case.
- The cleanup trap (INT/TERM/EXIT) with the `_cleaned` guard is correctly implemented and handles double-invocation properly.

## Blocking findings
- None.

## Non-blocking findings

- [Severity: Major] **`seq` is not universally available**
  - Why this matters: `seq` is a separate binary from coreutils and may not be present in minimal containers, Alpine-based images, or macOS without coreutils. The rest of the script targets `#!/bin/bash`, so using a bash built-in alternative makes the readiness loop more portable.
  - Evidence: `start_test_dashboard.sh:190` — `for _ in $(seq 1 30)`.
  - Recommended fix: Replace with bash brace expansion: `for _ in {1..30}`. Bash expands this inline without forking a subprocess.

- [Severity: Major] **`kill -0` readiness check races with process termination**
  - Why this matters: At `start_test_dashboard.sh:193`, `kill -0 "$SERVER_PID"` checks the process is alive, then `wait "$SERVER_PID"` at line 255 blocks. If the server exits between the readiness loop and the `wait`, the script exits with `set -e` from `wait`'s non-zero status (the process exited with code != 0 from being killed). This would suppress the cleanup message.
  - Evidence: `start_test_dashboard.sh:193-196` (kill -0 check), `start_test_dashboard.sh:255` (wait).
  - Recommended fix: Change `wait "$SERVER_PID"` to `wait "$SERVER_PID" || true` so a natural exit doesn't cause `set -e` to abort before the cleanup trap fires. The exit status is already shown in the `cleanup` function's message.

- [Severity: Minor] **`npm install` does not detect stale `node_modules`**
  - Why this matters: If `package-lock.json` or `package.json` changes while `node_modules/` exists (e.g., after a pull), the script skips `npm install` and launches the dashboard with outdated dependencies. This can cause confusing runtime errors.
  - Evidence: `start_test_dashboard.sh:85-88` — only checks `[ ! -d "node_modules" ]`.
  - Recommended fix: Add a fresh install condition: `[ ! -d "node_modules" ] || [ package-lock.json -nt node_modules/.package-lock.json 2>/dev/null ]`. Or remove the guard entirely for test mode (simpler, KISS-aligned) since `npm install` is idempotent and fast with a lockfile.

- [Severity: Minor] **Cleanup guard `$_cleaned` is confusing**
  - Why this matters: `$_` is a well-known bash special variable ("last argument of previous command"). Many readers will briefly wonder whether `$_cleaned` resolves as `$_` + `cleaned` vs `${_cleaned}`. Testing confirmed it resolves as the variable `_cleaned` (longest valid name wins), but the cognitive friction is unnecessary.
  - Evidence: `start_test_dashboard.sh:244-247`.
  - Recommended fix: Use braces: `${_cleaned}`. This makes the variable name unambiguous at a glance.

- [Severity: Nit] **No trap on SIGHUP**
  - Why this matters: If the terminal/SSH session disconnects, the background server process survives (due to `&`), which is usually desirable. But the cleanup trap won't fire, leaving the PID file stale. The stale-PID cleanup on the next run handles this correctly, so this is a documentation/expectation note, not a defect.
  - Evidence: `start_test_dashboard.sh:253` — only traps `INT`, `TERM`, `EXIT`.
  - No change required unless the intent is "stop server on disconnect."

- [Severity: Nit] **Unquoted `$PID_FILE` in trap**
  - Why this matters: `$PID_FILE` contains a path under `$SCRIPT_DIR/tmp/`. If `$SCRIPT_DIR` ever contained spaces, `rm -f $PID_FILE` would fail. `$SCRIPT_DIR` is resolved from `BASH_SOURCE` so it typically won't, but quoting costs nothing.
  - Evidence: `start_test_dashboard.sh:249` — `rm -f "$PID_FILE"` is correct, but verify the trap cleanup also uses it: `rm -f "$PID_FILE"` at line 249 is already quoted.
    - Actually, line 249 IS quoted. The unquoted check was wrong. (Verified: `rm -f "$PID_FILE"` is at line 249, properly quoted.) No finding here — retracted.

## Simplicity and design notes (KISS/YAGNI/DRY/SOLID)
- The script is clean and follows KISS well. No over-engineering detected.
- `pick_port` is a nice self-contained function. The `shuf`/`RANDOM` fallback is appropriate.
- The `_cleaned` guard flag for the trap handler is a good pattern; just make the variable name less ambiguous.
- The readiness loop with dual-check (ss listener + optional curl probe) is lean — the curl-absent short-circuit at `start_test_dashboard.sh:207-210` avoids forking a subprocess just to skip curl.
- The script avoids the common trap of over-abstracting: no separate `die()` helper or config library where simple `echo >&2; exit 1` suffices.

## Test gaps
- **No shellcheck run in CI** — the script is clean under shellcheck, but there's no automation enforcing it.
- **TOCTOU race coverage** — the window between `ss` port-freeness check and `node` listen is untested. A synthetic test (reserve the port between check and listen) would confirm the readiness loop handles it gracefully.
- **curl-absent path** — the no-curl branch (ss-only readiness) is currently untested. Test by running with a minimal PATH that excludes curl.
- **Port wrap-around** — `pick_port` at line 135 wraps from 60000 to 50001. If every port 50001-60000 is in use, the function exits after 200 attempts. No test exercises the wrap-around logic specifically.
- **Stale PID collision** — the stale server kill at lines 168-176 is untested. A test that plants a fake PID file and a matching fake process (e.g., `sleep infinity`) would validate the cleanup.

## Suggested next steps
1. Replace `seq` with `{1..30}` for broader compatibility (Major).
2. Add `|| true` to `wait "$SERVER_PID"` to suppress `set -e` exit when the server process terminates naturally after being killed (Major).
3. Consider removing the `node_modules` guard so `npm install` always runs in test mode — simpler and ensures up-to-date deps (Minor).
4. Add braces to `$_cleaned` → `${_cleaned}` to eliminate ambiguity (Minor).
5. Add shellcheck to the project's CI or `run_tests.sh` if one exists (follow-up).
