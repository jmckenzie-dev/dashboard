# Fix: Blocked Review Sessions Stay Visible After TUI Process Dies

## What
Prevent `blocked_review` sessions from remaining visible via `active_tool`
liveness when the owning TUI process has died.

## Root Cause
A `blocked_review` session whose TUI process died while `submit_plan` was
`pending` had its tool part never terminalized. `analyzeParts` saw an active
tool, `inferOpencodeStatus` returned `blocked_review` (no staleness cutoff by
design), and `directReason` returned `active_tool` liveness because the age was
within the 30-minute `ACTIVE_TOOL_LIVENESS_MAX_AGE_MS` window. Result: the
session stayed visible despite no backing process.

## Fix
In `directReason()` (`src/lib/agents/opencode-liveness.ts`), added a guard in
the `hasActiveTool` branch: if the candidate's status is `blocked_review` AND
`hasProcessSessionId` is false, skip returning `active_tool`. The candidate
falls through to weaker liveness checks (`cwd_allocated`, `hidden_stale`).

This is correct because:
- `blocked_review` only comes from `submit_plan`/`plan_exit` tools (inference.ts)
- A plan review cannot happen without the TUI process
- Other statuses with `hasActiveTool` (e.g., `working` with a `bash`/`task` tool)
  can legitimately lack `hasProcessSessionId` (flagless TUI)

## Tests Added
4 new regression tests in `scripts/test-opencode-liveness.mjs`:
1. `blocked_review` without process → `hidden_stale`
2. `blocked_review` WITH process → `active_tool` (still works)
3. `blocked_review` without process even when very recent → `hidden_stale`
4. `working` with active tool but no process → `active_tool` (flagless TUI preserved)

## Verification
- All 20 tests pass (16 existing + 4 new + 1695 property checks)
- `npm run check`: 0 errors, 0 warnings
- `npm run build`: clean production build
- Dump confirmed: orphaned `blocked_review` session now shows
  `livenessReason: "cwd_allocated"` instead of `"active_tool"`
