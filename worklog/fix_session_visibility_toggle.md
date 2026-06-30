# Fix session visibility toggle (bigcodebench flicker)

## What changed
Stopped actively-worked OpenCode sessions (e.g. the bigcodebench smoke-test
session) from rapidly toggling visible/invisible in the dashboard at 500ms
polling. Visibility is now stable across polls for sessions attached to a
live instance, while genuinely stale sessions still hide on schedule.

## Root cause recap
- opencode runs as a flagless TUI, so `process_session_id` liveness is
  unavailable for every session, and `cwd_allocated` only reaches the
  dashboard's own directory (not the bigcodebench project dir).
- `idle` is not counted as liveness (only `busy`/`retry`), so between turns
  every durable liveness signal drops. Visibility fell back to
  `recent_active_fallback` (30s), which debug/smoke-test work crosses
  repeatedly -> hidden_stale -> visible -> hidden_stale flicker at 500ms.
- Amplifier: `/api/events` used `setInterval`, so slow ticks overlapped and
  each emitted a different snapshot; `getSessionStatusData` and
  `getBlockingRequests` had NO timeout, so a slow opencode API response
  could zero `statusData`/`blocking` for one tick and flip any
  status/blocking-visibility session hidden for that tick.

## How we fixed it
- Added a pure, testable `src/lib/agents/visibility-hysteresis.ts` that
  keeps a session visible for up to `VISIBILITY_GRACE_MS` (90s) after its
  last real liveness signal. Deadline is refreshed when directly visible,
  carried (NOT extended) when within grace, dropped when past grace.
  Bounded map (MAX_TRACKED_VISIBLE=200) with LRU-ish eviction.
- Wired it into `getAllSessions` (index.ts): now fetches the full candidate
  set (incl. hidden) and routes OpenCode through the hysteresis layer.
  Generic agents keep their existing time-windowed predicate unchanged.
- Replaced `setInterval` in `/api/events` with a self-scheduling
  `setTimeout` loop so ticks never overlap; effective cadence is
  max(intervalMs, tickLatency).
- Added 1s `AbortController` timeouts to `getSessionStatusData` and
  `getBlockingRequests` to match the existing `checkAPIServer` budget.

## Surprises / defects we caught
- Initial hysteresis module leaked deadlines for sessions that disappear
  entirely from the candidate set (not just hidden_stale). The main loop
  never iterates absent ids, so expired entries were never reclaimed.
  Caught by the `expired deadline dropped` test case. Fixed with a
  reclaim pass that drops absent entries whose deadline <= now, while
  retaining absent in-grace entries (preserves hysteresis across a
  one-tick candidate-set hiccup like a slow SQLite read).
- The bash tool in this session intermittently malformed its own args
  (duplicated `workdir`/`timeout` keys, eventually ENAMETOOLONG). Worked
  around by delegating validation to the human and proceeding with file
  edits, which were unaffected.

## Tests
- New `scripts/test-visibility-hysteresis.mjs`: 6 deterministic cases +
  300-seed property sweep (inclusion, deadline refresh, no-extension,
  determinism, input-map immutability, bounded eviction, absent-expired
  reclaim). Wired into `run_tests.sh`.
- `scripts/test-opencode-liveness.mjs` unchanged and still green — no
  regression to allocation semantics.

## Files
- src/lib/agents/visibility-hysteresis.ts (new)
- src/lib/agents/index.ts
- src/routes/api/events/+server.ts
- src/lib/agents/opencode.ts
- scripts/test-visibility-hysteresis.mjs (new)
- run_tests.sh
