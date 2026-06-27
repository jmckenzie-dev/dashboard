# Code Review

## Verdict
**APPROVE**

## Summary
A disciplined, minimal fix addressing two distinct failure modes: bwrap-containerized opencode processes missed by the process scanner, and orphaned `active_tool` signals from dead processes. Both hunks are correct, self-contained, and match the existing code style. No blocking issues.

## Blocking findings
None.

## Non-blocking findings

### Major
None.

### Minor
1. **`openCodeArgIndex()` — bwrap path could handle edge cases more defensively**
   - `src/lib/process/poller.ts:102-110`
   - **Observation:** The check `basename(args[0]!) === 'bwrap'` assumes `args[0]` is defined (the `!` non-null assertion is safe after the `args.length === 0` early return at line 93, so this is fine). However, the function does not handle the case where `args[0]` itself is a path like `/usr/bin/bwrap`. While `basename('/usr/bin/bwrap')` correctly yields `'bwrap'`, the `!` assertion on `args[0]` could be omitted since the length check already guarantees it's defined. The existing code in the `node`/`bun`/`deno` branch uses `args[0]!` too, so this is consistent. **Non-blocking;** existing pattern is preserved.
   - **Recommendation (nit):** Drop the `!` on `args[0]` since the guard already guarantees it — but this is a style nit that applies to the pre-existing code too, not a change worth making here.

2. **`lastActivity` as staleness basis instead of tool-specific `time`**
   - `src/lib/agents/opencode-liveness.ts:39`
   - **Observation:** The staleness check uses `candidate.lastActivity`, which is the session-wide last-updated timestamp (`session.time.updated`), not the tool-specific `LatestToolInfo.time`. The `LatestToolInfo` type (defined in `src/lib/status/inference.ts:19`) already carries a `time: number` field. In the common case these timestamps converge because a dead process stops updating both. But in the pathological case where something keeps `session.time.updated` ticking but the tool is genuinely orphaned (unlikely given the current architecture), the staleness bound could miss.
   - **Risk:** Extremely low. The session-updated timestamp is derived from the same TUI process that runs the tool. If that process dies, neither timestamp advances. If it lives, the session shouldn't be hidden. The current approach is correct.
   - **Recommendation:** None needed. If a future refactor decouples tool state from session-updated time, revisit to use `LatestToolInfo.time` directly.

### Nits
1. **`ACTIVE_TOOL_LIVENESS_MAX_AGE_MS`** — The name is verbose but aligns with the existing `RECENT_ACTIVE_FALLBACK_MS` convention. Consistent and correct.

## Simplicity and design notes
- The bwrap branch is a clean extension of the existing `openCodeArgIndex` pattern. It scans for `--` (bwrap's command delimiter) and then looks for `opencode` after it. This mirrors how `ps` presents bwrap commands: `bwrap --args ... -- opencode ...`. Minimal and correct.
- The staleness check is a single `if` guard inside the existing `directReason` pipeline. No new loops, no state, no call-site changes beyond threading `now` through. This is an exemplary KISS implementation.
- The default 30-minute bound is conservative enough to avoid false positives on long-running tool calls (builds, tests, migrations) while aggressive enough to hide sessions orphaned for a meaningful duration.
- The `now` parameter was already available at the call site (`allocateOpenCodeLiveness` default `now = Date.now()`); the diff merely threads it through. Good API ergonomics — no new coupling.

## Test gaps
- **No test coverage for `openCodeArgIndex` bwrap path.** There is no test suite in this project, so this is not a regression. If tests are added later, the bwrap path (`args = ['bwrap', '--ro-bind', '/', '/', '--', 'opencode', '-s', 'abc123']`) is a prime candidate for a parametrized unit test.
- **No test coverage for `directReason` staleness.** A simple unit test with a `candidate` whose `lastActivity` is 31 minutes in the past and `hasActiveTool: true` should return `null` (not `'active_tool'`). Another with `lastActivity` 15 minutes ago should return `'active_tool'`.

## Suggested next steps
1. **Consider adding a test harness** for `.ts` modules (e.g., Vitest) since the liveness and process-scanner logic is highly unit-testable and has had two rounds of bug fixes now.
2. **Monitor the 30-minute bound** in production. If users report false-positive hiding of legitimately long-running tool sessions (e.g., multi-hour build processes), expose this as a config knob or increase the bound to 60 minutes.
3. **Audit for other sandbox runtimes** if the team uses `nsenter`, `docker run`, or `podman` — those may need similar `--`-aware scanning or alternative detection.
