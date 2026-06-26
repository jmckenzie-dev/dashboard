# Plan: Fix OpenCode Session Liveness and Status Resolution for TUI Sessions

## 1. Problem Statement
The user reported that the OpenCode session "Commit changes on branch" is live (PID 1000571 is running on the host, targeting `~/.config`) but listed as `Idle` in the dashboard.

Upon debugging:
1. The dashboard container runs in isolation and does not share the host's PID namespace (`Pid=host` is missing in `ai-agent-dashboard.container`), causing the process scanner inside the container to find 0 processes (`instanceAlive` is wrongly `false` or `undefined`).
2. Even when a process is running on the host, a TUI-driven local session (as opposed to an HTTP-serve-driven background session) never registers with the local serve server's `/session/status` endpoint.
3. Therefore, `sessionStatus` is evaluated as `null`. Since `WORKING_GRACE_MS` is only 10 seconds, any TUI process thinking or running for longer than 10 seconds is misclassified as `Idle` instead of `working` because the dashboard does not map process-level liveness back to the active status calculation.
4. Additionally, `scripts/test-status-inference.mjs` fails to compile because `tsc` is only run on `inference.ts`, which imports `types.ts` (uncompiled in the temp directory).

## 2. Proposed Changes

### Task A: Fix container PID namespace
Modify `/home/jmckenzie/.config/containers/systemd/ai-agent-dashboard.container` to add `Pid=host` under the `[Container]` section. This enables the container to see the host's running processes.

### Task B: Propagate process liveness to status inference
In `src/lib/agents/opencode.ts`:
1. Calculate `instanceAlive` earlier in both `getSessionsViaSQLite` and `getSessionsViaAPI`.
2. Compute `isBusy = sessionStatus === 'busy' || (instanceAlive && latestStepReason !== 'stop')`.
3. Pass `isBusy` as the `sessionStatus` input to `inferOpencodeStatus`.

### Task C: Fix `test-status-inference` script compilation
Modify `scripts/test-status-inference.mjs` to run `tsc` on both `src/lib/status/inference.ts` and `src/lib/agents/types.ts` so imports resolve correctly.

### Task D: Verify and restart service
1. Run `./restart_dashboard.sh` to rebuild the container image and restart the systemd service.
2. Run `bash run_tests.sh` to ensure type-checks, build checks, and status inference self-tests pass successfully.
3. Query `curl -s http://127.0.0.1:35001/api/status/diagnose` to verify the session now has `instanceAlive: true` and is correctly marked as `working`.
