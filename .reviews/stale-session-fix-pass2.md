# Code Review (Second Pass)

## Verdict
**APPROVE**

## Summary
- ~20 lines of additive, well-scoped changes across two files
- Both changes are correct and directly address the stated goal (orphaned session cleanup + bwrap visibility)
- No new bugs, no regressions in existing paths, no style drift from surrounding code

## Blocking findings
None.

## Non-blocking findings

- [Minor] `lastActivity` vs tool-specific staleness — already acknowledged in first pass. The current check uses `candidate.lastActivity` (session-level) as a proxy for tool last-started time. If a session has other activity (e.g., periodic status pings) while a tool is orphaned, this could delay cleanup. This is an inherent limitation of the data model, not a bug in this change. Follow-up could track per-tool start time.

## Simplicity and design notes (KISS/YAGNI/DRY/SOLID)
- Bwrap detection is a ~9 line addition to the existing `openCodeArgIndex()` — no new functions, no indirection. Matches the existing `node`/`bun`/`deno` guard above it. Good.
- Liveness staleness adds one conditional inside `directReason()` — minimal diff, no new abstractions. Correct.
- The constant `ACTIVE_TOOL_LIVENESS_MAX_AGE_MS` is exported with a clear comment, making it testable and overridable without coupling.

## Test gaps
- No test suite exists (confirmed by AGENTS.md). No action required in this change.

## Suggested next steps
1. Merge as-is — both changes are correct, simple, and solve the stated problem.
