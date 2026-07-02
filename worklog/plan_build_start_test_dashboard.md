# Plan Build: start_test_dashboard.sh

Executed the `/plan-build` workflow on `.plans/start-a-test-dashboard-on-a-random-port.md`.

## What was done

The script already existed with most of the implementation complete. The plan-build
process identified and fixed several gaps through two code review passes:

### Fixes applied
1. **Added `npm run check` before `npm run build`** — plan requirement for pre-merge
   verification. Was missing in the original implementation.
2. **Fixed `build/server.js` → `build/index.js`** — adapter-node 5.5.3 outputs
   `build/index.js`, not `build/server.js`. The original script (and `package.json`
   `start` script) referenced the wrong file. This is a pre-existing bug in the repo.
3. **Restored `PORT="$PORT"` inline export** — shell variables are not automatically
   exported to child processes. Without the inline export, the Node.js server would
   bind to default port 3000 instead of the selected random port.
4. **Consolidated arg parsing** — `USE_PROD_CONFIG` is now set directly in the first
   argument loop, eliminating redundant second parse.
5. **Added `git` to dependency check** — was removed in an earlier edit despite being
   used for branch/commit display.
6. **Replaced `seq` with bash `for ((...))`** — `seq` is not POSIX.
7. **Added port range validation** — `TEST_DASHBOARD_PORT` override is now validated
   to be 1-65535.
8. **Added `mkdir -p tmp/`** — PID file directory wasn't guaranteed to exist when
   `--use-prod-config` was used on a fresh checkout.
9. **Documented `TEST_DASHBOARD_PORT_STRICT=1` in README** — was missing from the
   "Test Dashboard" subsection.

### Code review findings
- Pass 1 found 1 blocker (PORT not exported), 2 majors (git dep, double arg parse),
  4 minors (seq, port validation, tee truncation, curl errors), 1 nit (npm ci).
- Pass 2 found 1 blocker (missing `mkdir -p tmp/`), 2 minors (README gap,
  stale package.json start script).
- All findings were remediated or explicitly deferred.

### Surprises / lessons
- The parent `node_modules/` is on a read-only btrfs mount, causing `npm run check`
  to fail with EROFS. This is a pre-existing environment issue unrelated to our changes.
- The `package.json` `start` script (`node build/server.js`) has been broken since
  adapter-node started outputting `build/index.js`. The test script now correctly
  uses `build/index.js`.
- Shell variables set via `VAR=$(...)` are NOT exported to child processes. The inline
  `VAR="$VAR" cmd` prefix is required to pass the variable to the subprocess.
