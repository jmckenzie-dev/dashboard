# Fix: Stuck Error Session After `/new`

## Problem
An errored opencode session that was superseded by `/new` remained stuck in the
dashboard as `❌ Error`. The root cause: `scanProcesses()` reads the process
argv (`-s <session-id>`), which is **immutable on Linux** after process start.
Even after `/new` creates a new session, the old session ID lingers in
`/proc/<pid>/cmdline`, so the dashboard's liveness pipeline treated the stale
`process_session_id` signal as unconditional proof that the old session was
still alive.

## Fix (one core file + one test file)

### `src/lib/agents/opencode-liveness.ts`
- Computed `directoriesWithStatusSignal` — the set of directories containing at
  least one session confirmed alive by `/session/status` (`hasStatusSignal`).
- Modified `directReason()` to accept this set as a third parameter.
- When a candidate has `hasProcessSessionId` but its directory already has a
  **different** session with `hasStatusSignal` (the `/new` session), the
  `process_session_id` signal is suppressed — the old session falls through to
  `cwd_allocated`, `recent_active_fallback`, or `hidden_stale`.
- Added JSDoc explaining the rational and scenario.

### `scripts/test-opencode-liveness.mjs`
- The property test invariant `hasDirectSignal → instanceAlive === true` was
  violated when PSID was suppressed. Added an exemption: candidates with
  `hasProcessSessionId` that are in a directory where another session has
  `hasStatusSignal` are skipped in this check.

## Surprises
- The worktree had no `node_modules/` — had to create symlinks manually. The
  parent repo's `node_modules` is on a read-only mount, causing `EROFS` errors
  for `npm run check` and `npm run build`.
- The first code review found a real issue in the property test (a stale
  invariant), which was fixed before the second review.

## What we learned
- `process_session_id` is NOT proof of process intent — argv is immutable on
  Linux after `exec()`.
- The `/session/status` API is the authoritative source for which session a
  process considers active.
- The property test's `hasDirectSignal` invariant was too aggressive — it
  didn't account for signal suppression scenarios.
