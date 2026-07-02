# Code Review

## Verdict
REQUEST CHANGES

## Summary
- Script is well-structured with clear sections, helpful banners, and comprehensive readiness polling.
- One **blocker**: `PORT` is not exported to the Node.js server process — adapter-node will bind to default port 3000 instead of the randomly selected port, causing the readiness probe to time out.
- Several minor maintainability regressions from the original version (removed `git` dep check, redundant double arg parsing).
- Error handling and cleanup are generally solid (process alive checks, EXIT trap, timeout with last-log-lines dump).

## Blocking findings

- [Severity: Blocker] **`PORT` not exported to server process — server binds to port 3000, not the selected random port**
  - Why this matters: The script picks a random port via `pick_port()`, stores it in shell variable `PORT`, then probes that port for readiness. But `PORT` is never exported, so `adapter-node` (`node_modules/@sveltejs/adapter-node/files/index.js:237`) reads `process.env.PORT` as `undefined` and falls back to `'3000'`. The readiness loop checks `$PORT` (e.g. 50001) while the server listens on 3000 — the probe never succeeds and the script exits after 30 seconds with a misleading timeout error.
  - Evidence: `start_test_dashboard.sh:135` (`PORT=$(pick_port)`) sets a shell variable. `start_test_dashboard.sh:167` (`HOST=127.0.0.1 node ...`) does *not* prefix with `PORT=$PORT`. The diff from main confirms `PORT=$PORT` was *removed* (original had `PORT=$PORT HOST=127.0.0.1 node ...`). Confirmed by shell test: `PORT=99999; bash -c 'echo $PORT'` emits empty string; only `export PORT; …` or inline `PORT=$PORT cmd` passes the variable.
  - Recommended fix: Restore the inline export: change line 167 from:
    ```bash
    HOST=127.0.0.1 node "$SCRIPT_DIR/build/index.js" &
    ```
    to:
    ```bash
    PORT="$PORT" HOST=127.0.0.1 node "$SCRIPT_DIR/build/index.js" &
    ```
    (Or add `export PORT` after line 135, but the inline form is more scoped and was the original approach.)

## Non-blocking findings

- [Severity: Major] **`git` dependency check removed despite `git` being used**
  - Why this matters: Lines 55-56 run `git rev-parse` and gracefully fall back to `<unknown>` if git is absent. But the original script explicitly checked for `git` in the `missing_deps` array and that check was removed in the current version. While not a correctness issue (fallbacks exist), it silently degrades the user-facing output instead of telling the user they're missing `git`.
  - Evidence: `start_test_dashboard.sh:70-72` checks `node`, `npm`, `ss` but not `git`. The diff from main shows the original had `command -v git ... || missing_deps+=("git")`.
  - Recommended fix: Add `git` back to the dependency check on line 72, or keep it optional but add a note that branch/commit info will be unavailable.

- [Severity: Major] **Redundant double parsing of `$@`**
  - Why this matters: The arguments are parsed first on lines 37-47 (validates known args) and then again on lines 140-147 (sets `USE_PROD_CONFIG`). The first loop already sees `--use-prod-config` but discards it (empty `;;` action). This is a DRY violation that makes the script harder to maintain if new flags are added.
  - Evidence: `start_test_dashboard.sh:37-47` and `start_test_dashboard.sh:140-147`.
  - Recommended fix: Consolidate arg parsing into a single loop. Set `USE_PROD_CONFIG=true` in the first loop's `--use-prod-config` case and remove the second loop.

- [Severity: Minor] **`exec > >(tee ...)` may truncate last log lines on exit**
  - Why this matters: `exec > >(tee ...)` runs `tee` as a process substitution child. When the script exits (or is signalled), the shell does *not* wait for `tee` to flush its write buffer. The last few lines of output (e.g. "Stopped test dashboard") may be missing from the log file. For a test/dev script this is cosmetic, but frustrating when debugging a crash.
  - Evidence: `start_test_dashboard.sh:52`.
  - Recommended fix: Capture the PID of the `tee` process (tricky with process substitution) or use a named pipe. A simpler approach for a test script is acceptable — not required to fix now, but worth documenting.

- [Severity: Minor] **`seq` is not POSIX and absent on some systems**
  - Why this matters: Line 177 uses `seq 1 30` for the readiness loop. `seq` is a GNU utility not available on all POSIX systems (e.g. macOS, some minimal containers). The script targets Linux (`ss` dependency, `shuf`), so this is low risk, but a bash built-in alternative exists.
  - Evidence: `start_test_dashboard.sh:177`.
  - Recommended fix: Replace with `for ((i=0; i<30; i++))` (pure bash, no external dependency).

- [Severity: Minor] **No port range validation for `TEST_DASHBOARD_PORT` override**
  - Why this matters: If a user sets `TEST_DASHBOARD_PORT=99999` (invalid port), `ss` will not match it, the port is "free" according to the probe, the server is started with an invalid port, and Node.js will fail to bind. The error surfaces as a generic readiness timeout rather than a clear "invalid port" message.
  - Evidence: `start_test_dashboard.sh:108-111` accepts any value for `TEST_DASHBOARD_PORT` without validation.
  - Recommended fix: After resolving `TEST_DASHBOARD_PORT` into `base`, add a range guard:
    ```bash
    if [ "$base" -lt 1 ] || [ "$base" -gt 65535 ]; then
      echo "ERROR: TEST_DASHBOARD_PORT=$base is not a valid port (1-65535)." >&2
      exit 1
    fi
    ```

- [Severity: Minor] **Readiness curl errors are silently discarded**
  - Why this matters: Line 190 redirects curl's stderr to `/dev/null`. During polling, if the server is misconfigured and returning connection resets, the user sees no per-attempt errors — only the final "did not become ready" message. This makes debugging startup failures harder.
  - Evidence: `start_test_dashboard.sh:190` (`curl -sS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null`).
  - Recommended fix: For a test script this is acceptable (avoids noise during normal polling), but consider logging curl failures to the log file (not stderr) so they're available in `tail -20` on line 212.

- [Severity: Nit] **`npm install` could be `npm ci` for deterministic installs**
  - Evidence: `start_test_dashboard.sh:82`. `npm ci` is faster, fails if `package-lock.json` is out of sync, and is the recommended install for automated environments.
  - Recommended fix: Replace `npm install` with `npm ci` on line 82.

- [Severity: Nit] **Typo in argument: `--use-prod-config` uses "prod" instead of "prod" — intentional abbreviation**
  - This is a style observation, not a change request. The abbreviation is consistent throughout. No action needed.

## Simplicity and design notes (KISS/YAGNI/DRY/SOLID)

- **KISS**: The readiness probe is well-designed — two-tier (ss TCP check + HTTP probe) with the HTTP check first and a net.connect fallback. The comments accurately explain the curl `-f`/no-`-f` distinction. No over-engineering.
- **DRY violation**: Double arg parsing (lines 37-47 and 140-147) is unnecessary complexity. The first loop could set `USE_PROD_CONFIG` directly.
- **YAGNI**: All features have clear present use-cases. No speculative abstraction.
- **SOLID**: Not applicable (shell script).

## Test gaps

- No automated regression test for the script itself. Consider adding a `bash -n` and `shellcheck` invocation to a test script or CI check, similar to other self-tests in `scripts/`.
- Specific cases to property-test (if a test harness is added):
  - `PORT` is correctly exported and visible to a child process.
  - Readiness probe succeeds on HTTP 200, 401, 404, 500.
  - Readiness probe fails when server is not listening.
  - Port collision + auto-increment works.
  - `TEST_DASHBOARD_PORT_STRICT=1` exits on busy port.
  - `--use-prod-config` sets `USE_PROD_CONFIG=true`.
  - Missing `node`/`npm`/`ss` prints clear dependency error.

## Suggested next steps

1. **Fix blocker**: Restore `PORT="$PORT"` inline export on the `node` startup line (`start_test_dashboard.sh:167`).
2. **Fix major**: Consolidate arg parsing into a single loop (lines 37–47 and 140–147).
3. **Fix major**: Restore `git` to the dependency check.
4. **Address minors**: Replace `seq` with bash `for ((...))`, add port range validation, consider `npm ci`.
5. **Validate**: Run `bash -n start_test_dashboard.sh && shellcheck start_test_dashboard.sh` after changes.
6. **Functional test**: After fix #1, run the script (or at minimum verify `PORT` reaches the Node process) before merging.
