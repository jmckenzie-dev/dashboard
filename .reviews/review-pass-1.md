# Code Review

## Verdict
APPROVE

## Summary
The fix correctly prevents orphaned `blocked_review` sessions from staying visible via a stale `active_tool` signal after the owning TUI process dies. The change is minimal (3 lines of logic + 1 comment in `directReason()`), precisely targeted, and well-tested with 4 new regression tests that cover the happy path, the orphaned path, the recent-orphan path, and the unaffected-non-blocked_review path. No blockers.

## Blocking findings
None.

## Non-blocking findings

### Major: `blocked_review` sessions remain eligible for `cwd_allocated` liveness
`opencode-liveness.ts:114-119` — the `cwd_allocated` filter only excludes `error` status sessions from weak directory-proximity allocation. An orphaned `blocked_review` session (no process, no direct signal after this fix) whose directory has an allocation slot can still be kept visible via `cwd_allocated`.

**Scenario:** TUI dies in `/repo/a`, leaving `s1` in `blocked_review`. User restarts opencode in `/repo/a` without `-s` (flagless TUI). `s1` has `hasActiveTool=true`, `hasProcessSessionId=false`, `status='blocked_review'`. This fix correctly suppresses `active_tool`. But `directoryAllocationCounts['/repo/a'] = 1`, and `s1` is not `error` status, so it gets `cwd_allocated` liveness anyway.

This is lower risk than the original bug because `cwd_allocated` requires a live TUI in the same directory, and the session will be naturally pushed down the sort order as the new TUI creates activity. But if the intent is "no orphaned blocked_review session visible after its TUI dies regardless of directory proximity" (as the PR title implies), then `blocked_review` should join `error` in the exclusion filter on line 119.

**Suggestion:** Add `&& candidate.status !== 'blocked_review'` to the `cwd_allocated` filter, or — better — add a `isBlockedReviewOrphan` helper that centralizes the "this session is dead but was blocked_review" logic, since it may also need to apply to `recent_active_fallback` below (see next finding).

### Minor: `blocked_review` sessions are eligible for `recent_active_fallback`
`opencode-liveness.ts:149` — `recent_active_fallback` also has no exclusion for `blocked_review`. The window is only 30s so the blast radius is tiny, but an orphaned `blocked_review` session could flicker back into visibility within 30s of its last activity if both direct signals and cwd allocation are absent.

**Suggestion:** Add the same guard here. Low priority given the 30s window, but semantically consistent with the PR goal.

### Major: Stale process argv can still grant `active_tool` to superseded `blocked_review` sessions
`opencode-liveness.ts:53-61` — the `hasProcessSessionId` check on line 57 guards against the orphaned case correctly *when the process is fully dead*. But there is a subtler case: session `s1` is `blocked_review` with an in-flight `submit_plan`, the user calls `/new` to create `s2` in the same directory, the process argv still references `s1`'s ID. Now `s1` has `hasActiveTool=true` and `hasProcessSessionId=true`. Line 57's guard (`!candidate.hasProcessSessionId` = false) does not suppress `active_tool`. The stale-argv guard at lines 64-73 (`directoriesWithStatusSignal`) is never reached because we already returned `active_tool`.

**Blast radius:** The `/new` flow in opencode likely terminalizes the old `submit_plan` part, so `hasActiveTool` would be false and this path isn't reached. If the dashboard runs its own SQLite/API scan *during* the `/new` transition (before the old part is terminalized but after `s2` appears in `/session/status`), false positive is possible.

**Suggestion:** The `directReason` function should apply the stale-argv guard (`directoriesWithStatusSignal`) *before* the `active_tool` return for `blocked_review` sessions. This is an unlikely race but would be a correct defense.

## Simplicity and design notes

- The change is exemplary in its minimalism: one additional condition in an existing guard, zero new abstractions.
- The comment "blocked_review sessions (submit_plan/plan_exit) require process confirmation — without a live TUI the tool part is orphaned" accurately describes the WHAT. It could optionally add a brief WHY note: other tools (bash, write) are short-lived so the 30min age cutoff works, but `submit_plan`/`plan_exit` park intentionally for up to 96h, so an age-based cutoff is insufficient.
- The naming `hasProcessSessionId` is slightly misleading in context: it means the process's argv had a `-s` flag matching this session — NOT that the process is alive. If the process died but the poller has a stale `/proc` entry, the ID could still match. In practice this is not a concern because the poller reads `/proc/<pid>/cmdline` and a dead process has no `/proc` entry.
- The `directoriesWithStatusSignal` set construction (lines 90-95) iterates all candidates every call. This is O(n) per liveness cycle and acceptable for typical session counts.

## Test gaps

### Gap: `blocked_review` not covered in property sweep
`test-opencode-liveness.mjs:288` — the property sweep only generates `status: 'error'` (18% probability) or `'idle'` (default). `blocked_review` is never exercised. The 4 dedicated regression tests cover the direct logic, but the property sweep would miss interaction bugs where blocked_review + allocation math produces unexpected results.

**Suggestion:** Add `'blocked_review'` to the random status distribution in the property sweep (e.g., split the 82% non-error chance into 10% blocked_review, 72% idle). This would catch cwd_allocated/recent_active_fallback interaction regressions.

### Gap: No cwd_allocated interaction test for orphaned blocked_review
There is no test that creates an orphaned `blocked_review` session in a directory with an allocation slot and verifies it does NOT get `cwd_allocated` (or, if that was intentional, documents why).

### Gap: No stale-argv + blocked_review interaction test
As described above, the case where `blocked_review` has `hasProcessSessionId=true` but the session was superseded by `/new` is untested. This is the rarest edge case but the hardest to debug.

## Suggested next steps

1. **Add `blocked_review` to the `cwd_allocated` exclusion filter** (line 119) if the goal is truly "no orphaned blocked_review visible after TUI death regardless of directory state." If it is intentionally left eligible for `cwd_allocated`, add a comment explaining why (e.g., "blocked_review is intentionally eligible for cwd_allocated: a live TUI in the same directory makes the plan review relevant to the user").
2. **Add `blocked_review` to the property sweep status distribution** (even if #1 is declined, to catch future regressions).
3. **Consider the stale-argv + blocked_review interaction** documented above. The most robust fix would be to check `directoriesWithStatusSignal` in the `blocked_review && hasProcessSessionId` path. Worth a separate follow-up if /new transition timing can be validated.
4. Accept as-is if the risk assessment is that cwd_allocated for orphaned blocked_review is acceptable and the stale-argv race is too unlikely.
