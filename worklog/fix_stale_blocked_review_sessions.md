# Fix stale blocked review sessions

## What we changed
Added two fixes for stale "Blocked (awaiting review)" / "Working" sessions from dead
opencode instances persisting in the dashboard:

1. **`src/lib/process/poller.ts`**: Added bwrap sandbox detection to `openCodeArgIndex()`.
   The function now recognizes `bwrap --args... -- opencode ...` by scanning for the `--`
   separator and finding `opencode` after it. This fixes `hasProcessSessionId` being
   always false for bwrap-wrapped TUI sessions.

2. **`src/lib/agents/opencode-liveness.ts`**: Added `ACTIVE_TOOL_LIVENESS_MAX_AGE_MS`
   (30 min) staleness bound. Tools stuck in `running` for longer than 30 minutes are
   assumed orphaned (owning process died without terminalizing the tool) and no longer
   keep sessions visible.

## What we learned
- The `--pid=host` container flag already enables host process visibility; only the
  arg-parsing logic was missing bwrap awareness (open code is at arg index ~116-119
  inside bwrap wrappers).
- The staleness fix alone (Option B from the plan) would fix the blocked_review sessions
  but wouldn't make live TUI sessions visible. Both fixes are needed to properly solve
  the dual problem.
- Two review passes both returned APPROVE with no blocking findings.
- Plan's Step 3 (archive 15 stuck sessions in SQLite) and Step 4 (debug logging for
  specific session) are operational steps to be run separately after deployment.

## Key decisions
- 30-minute staleness bound is conservative enough to avoid false positives on long
  tool calls (builds, tests) while aggressive enough to hide orphaned sessions.
- The `now` parameter was already available at the call site (`allocateOpenCodeLiveness`
  default `now = Date.now()`); we just threaded it through. No new coupling.
