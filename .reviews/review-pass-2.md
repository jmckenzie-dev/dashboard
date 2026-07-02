# Code Review – Pass 2

## Verdict

**APPROVE** — no blockers, no non-blocking findings.

## Summary

The fix adds a single guard in `directReason()` (`opencode-liveness.ts:57`) that
refuses `active_tool` liveness for `blocked_review` sessions when
`hasProcessSessionId` is false. The candidate falls through to weaker checks
(`cwd_allocated`, `recent_active_fallback`, or `hidden_stale`). Four regression
tests cover the orphaned/live/recent/no-proc-working scenarios. Build and all
20 tests pass.

## Blocking findings

None.

## Non-blocking findings

None.

All four pass-1 deferred findings remain acceptable after re-examination:

1. **`cwd_allocated` for orphaned `blocked_review`** — The fallthrough to
   `cwd_allocated` is correct: it only activates when another TUI is actually
   running in the same directory, and is bounded by the directory process count.
   An orphaned session seen via cwd-proximity to a live TUI is a tolerable
   false positive.

2. **`recent_active_fallback` for orphaned `blocked_review`** — The 30 s window
   is negligible. By the next poll the session decays to `hidden_stale`. The
   90 s hysteresis layer already imposes comparable latency for genuine status
   transitions anyway.

3. **Stale-argv race during `/new`** — The `active_tool` check runs before the
   `process_session_id` stale-argv guard (`directReason` lines 53–62 vs.
   64–73), so a `blocked_review` session with a stale argv would still receive
   `active_tool` liveness. However, opencode terminalizes the old session's
   tool parts after `/new`, so `hasActiveTool` becomes false and the session
   decays naturally. No evidence of a real exploit path.

4. **Property sweep coverage** — `blocked_review` status is absent from the
   property sweep's random candidate generation. The four targeted regression
   tests cover the essential cases. Extending the property sweep to include
   `blocked_review` is deferred to future work (not a blocker).

## Simplicity and design notes

- The fix is minimal (4 lines of logic in one function) and follows the existing
  fallthrough pattern already used by the `ACTIVE_TOOL_LIVENESS_MAX_AGE_MS`
  staleness check.
- The guard is narrowly scoped to `blocked_review` — no other status is
  affected. The accompanying test (`working` + active tool + no process)
  confirms flagless TUI sessions (common for non-`-s` opencode invocations)
  still receive `active_tool` liveness.
- The `hidden_stale` verdict from `directReason()` correctly suppresses the
  `blocked_review` status-based visibility check in `isVisibleOpenCodeSession`
  (`index.ts:31` runs before `index.ts:38`). This cross-layer property is
  essential and is correctly preserved.

## Test gaps

- The property sweep (`test-opencode-liveness.mjs` lines 271–364) generates
  random candidates with `status: rand() < 0.18 ? 'error' : 'idle'` — it never
  produces `blocked_review`. Extending the status distribution to include
  `blocked_review` (and `working`, `blocked_permission`, `blocked_question`)
  would improve coverage, but the four targeted regressions are sufficient for
  this fix.
- There is no integration test that exercises the full pipeline (poller →
  liveness → visibility gate → API response). Such a test would be valuable
  but is out of scope for this targeted fix.

## Suggested next steps

1. Deploy and observe that orphaned `blocked_review` sessions (visible after
   TUI death) now decay to `cwd_allocated` or `hidden_stale` within one poll
   cycle.
2. Run `npm run dump:sessions -- --session <substr>` on a known orphaned
   session to confirm `livenessReason: "cwd_allocated"` (or `"hidden_stale"`)
   instead of `"active_tool"`.
3. (Optional) Extend the property sweep to include `blocked_review` and other
   statuses in the random candidate distribution for broader coverage.
