# Code Review: Fix idle during text generation (Pass 2)

## Verdict
REQUEST CHANGES

## Summary
- The two findings from Pass 1 are **confirmed fixed**: the `!cached &&` guard is removed from `recentlyActive` (line 858), and the pipeline now calls `computeApiFirstLastActivityMs` (line 871) instead of using inline code.
- One **new finding** undermines the core enrichment-refresh fix: `recentlyActive` still uses session-row-only time, so a session streaming for >2 minutes without a session-row update will stop getting enriched, and the stale-cache fallback will deliver an outdated `lastPartTime`, allowing the 10s grace window to expire.
- Test quality is good for a small pure function but has a weak trivially-true assertion and one meaningful missing edge case (exact boundary of `WORKING_GRACE_MS`).
- The `dump-sessions.mjs` endpoint mode is cleanly implemented and well-scoped to the diff.
- No KISS/YAGNI violations — the changes are proportional to the problem.

## Blocking findings
(none)

## Non-blocking findings

- [Severity: Major] **`recentlyActive` enrichment guard uses session-row time only**

  **Why this matters:** The core of this fix (Step 3) is meant to keep SQLite enrichment current for sessions that are actively generating but whose session row (`time.updated`) isn't advancing per-token. However, the `recentlyActive` guard at line 856 uses only `sessionActivityMs` (derived from the session-row timestamp), which has the **same blind spot** as `changedSinceEnrichment` — if the session row freezes for >2 minutes, neither guard fires.

  **Concrete scenario that still flips to idle:**
  1. Session generates text continuously for 3+ minutes with no session-row `time.updated` advancement.
  2. Session was already cached (enriched during a previous tick's active window).
  3. At the enrichment-target gate: `busyWithoutApiBlock=false`, `changedSinceEnrichment=false`, `needsBootstrap=false` (cached), `(cached=false && hasDirectLiveSignal)=false`, `recentlyActive=false` (3min > 2min window) → **no enrichment**.
  4. Line 868 falls through to the cache's stale `parsed.lastPartTime` → `computeApiFirstLastActivityMs` returns a large delta → grace window expires → `idle`.

  This directly undermines the stated goal of the fix.

  **Evidence:** `src/lib/agents/opencode.ts:856` — `recentlyActive` uses only `sessionActivityMs`; the cache's `parsed.lastPartTime` is available but unused.

  **Recommended fix:** Use the max of session-row time and **cached part-level time** for the recently-active check. This is safe because the cache is always read on line 868 when fresh enrichment is absent, so keeping enrichment current when the cache shows recent part activity is strictly additive:

  ```typescript
  const cachedPartActivityMs = cached ? toEpochMs(cached.parsed.lastPartTime ?? 0) : 0;
  const bestActivityMs = Math.max(sessionActivityMs, cachedPartActivityMs);
  const recentlyActive = Date.now() - bestActivityMs < RECENT_ENRICHMENT_WINDOW_MS;
  ```

- [Severity: Minor] **Weak test assertion for all-zero input**

  Test #7 (`both zero -> non-negative`) asserts `delta >= 0`, which is always true because `Math.max(0, 0) = 0` and `now - 0 = now` (≈ 1e12). This would pass even with a bug in the clamping logic. Should assert the exact value:

  ```typescript
  assertEqual(computeApiFirstLastActivityMs(0, 0, NOW), NOW,
    'both zero returns now as delta');
  ```

  **Evidence:** `scripts/test-api-first-activity.mjs:137-140`.

- [Severity: Minor] **Missing boundary tests for `WORKING_GRACE_MS`**

  No test verifies behavior exactly at the `WORKING_GRACE_MS` boundary (10s). A regression that shifts the window by 1ms would go undetected. Add:

  ```typescript
  // boundary: exactly at WORKING_GRACE_MS
  assertEqual(computeApiFirstLastActivityMs(NOW - WORKING_GRACE_MS, 0, NOW), WORKING_GRACE_MS,
    'exactly at grace boundary returns WORKING_GRACE_MS');
  ```

  **Evidence:** `scripts/test-api-first-activity.mjs:78-80` — 10_000 is in scope but never exercised as a boundary value.

## Simplicity and design notes (KISS/YAGNI/DRY/SOLID)

- **KISS/YAGNI upheld.** The `computeApiFirstLastActivityMs` helper is a trivially simple pure function. The enrichment refresh window is a single constant plus 5 new LOC. No speculative abstraction.
- **DRY improved.** The helper extraction (Pass 1 fix) eliminated the inline-vs-helper divergence. The pipeline at line 871 now calls the same function the tests cover.
- **Single Responsibility is maintained.** `computeApiFirstLastActivityMs` does one thing (combine two timestamps). Enrichment targeting is separate from enrichment execution. The liveness/status/visibility pipeline boundaries are respected.
- **One design concern:** the enrichment-target gate (lines 844–860) now has 5 boolean conditions joined by `||`. This is approaching the readability threshold. A comment or extracted helper (`needsEnrichment(session, cached, statusData, ...)`) would reduce cognitive load, but not worth blocking over.

## Test gaps

1. **`recentlyActive` enrichment refresh not tested.** There is no test that verifies a cached session with frozen session row but advancing part time gets re-enriched. This is an integration concern, but the property-test in `test-optimize-poller.mjs` could plausibly cover it, or a new focused subtest.
2. **Weak zero-input assertion** (flagged above).
3. **Missing `WORKING_GRACE_MS` boundary test** (flagged above).
4. **Missing equal-timestamps edge case:** `computeApiFirstLastActivityMs(t, t, t)` should return 0. Currently untested.
5. **No test for the combined enrichment-target logic end-to-end** — but this is acceptable for a script-level self-test suite; integration is covered by `npm run check` and the production pipeline.

## Suggested next steps

1. Fix the `recentlyActive` enrichment guard to use max of session-row time and cached part-level time. Three-line change in `src/lib/agents/opencode.ts:855-856`.
2. Strengthen test assertion at line 139–140 of `test-api-first-activity.mjs` to check the exact value.
3. Add `WORKING_GRACE_MS` boundary test and equal-timestamps test to `test-api-first-activity.mjs` (~6 new lines).
4. Verify all previous validation passes still hold: `npm run check`, `npm run build`, `bash run_tests.sh`.
