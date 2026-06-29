# Code Review

**File:** `src/lib/agents/opencode-liveness.ts`
**Change:** Staleness guard for `process_session_id` liveness signal

## Verdict

**APPROVE** — with non-blocking findings.

## Summary

- Correctness is sound: the guard only suppresses `process_session_id` when a different session is confirmed alive in the same directory via `/session/status`.
- All 8 edge cases verified via standalone test (normal path, stale suppression, same-session both-signal, API unreachable, cross-directory isolation, multi-PSID, stale-to-hidden, null directory).
- Production type-check (`npm run check`) and build (`npm run build`) both pass cleanly.
- One area of concern: the existing property-based test has a stale invariant that needs updating, and the test script has a pre-existing compilation failure unrelated to this change.

---

## Blocking findings

None.

---

## Non-blocking findings

### [Major] Property-based test invariant broken by new suppression logic

- **Evidence:** `scripts/test-opencode-liveness.mjs:154-158` defines `hasDirectSignal()` which includes `hasProcessSessionId`. Lines 192-201 assert: if `hasDirectSignal(candidate)` is true, then `instanceAlive` must be `true`. This is no longer guaranteed — a candidate with `hasProcessSessionId: true` in a directory where a *different* candidate has `hasStatusSignal: true` will have its PSID signal suppressed and may land in `hidden_stale` (if no allocation slot and too old for fallback), leaving `instanceAlive: undefined`.
- **Impact:** The property sweep (seeds 1-200) will produce false failures whenever the random generation produces the stale-PSID scenario. This masks the test's ability to detect regressions.
- **Fix:** Update `hasDirectSignal()` (or the assertion loop at line 192) to exclude `hasProcessSessionId` from the direct-signal invariant when the candidate's directory also contains a `hasStatusSignal` candidate. Alternatively, broaden the assertion to also accept `cwd_allocated`, `recent_active_fallback`, or `hidden_stale` as valid outcomes for PSID-only candidates.
- **Note:** The test script also has a pre-existing tsc compilation failure (`--noEmitOnError false` flag issue + tsconfig project resolution). This change should not be blocked on it, but it should be fixed separately.

### [Minor] Same-session both-signal case changes `livenessReason` from `process_session_id` to `status_map`

- **Evidence:** When a candidate has both `hasProcessSessionId: true` and `hasStatusSignal: true`, the PSID guard now suppresses `process_session_id` and execution falls through to line 67 (`if (candidate.hasStatusSignal) return 'status_map'`). Before the change, it would return `'process_session_id'` (checked first at line 51 of the old code, hit before `hasStatusSignal` at line 61).
- **Impact:** `livenessReason` is different for this case. While `status_map` is actually a more reliable signal, this behavioral change is undocumented in the PR description and could affect downstream consumers that inspect `livenessReason` for metrics, logging, or UI display.
- **Fix:** Either (a) document this in the JSDoc, or (b) add an explicit early return for `hasStatusSignal` before the PSID guard if you want to preserve the signal priority unchanged. Neither is urgent — this is a harmless quality improvement in the signal reported.

---

## Simplicity and design notes

The change is minimal and well-scoped. The three changes (compute set, pass parameter, add guard) are clearly motivated by the documented staleness scenario. The JSDoc on `directReason` accurately explains why Linux process argv immutability creates the problem and how the guard resolves it.

The pre-computation of `directoriesWithStatusSignal` (lines 83-88) is appropriate — O(n) upfront, avoids repeating Set lookups inside the loop for every candidate. The negative check (`!candidate.directory || !directoriesWithStatusSignal.has(candidate.directory)`) correctly short-circuits on falsy directory to avoid false matches.

---

## Test gaps

1. **No test coverage for the new staleness guard.** The deterministic tests in `scripts/test-opencode-liveness.mjs` (lines 111-142) cover normal PSID, cwd allocation, child-session skip, and path-only-stale scenarios but none test the `process_session_id` + `status_map` interaction. Add at minimum:
   - Stale PSID suppressed by different-session status_map → falls to `hidden_stale` or `cwd_allocated`.
   - Same-session both signals → `status_map`.
   - Null/absent directory with PSID → not suppressed.
2. **Property test invariant needs updating** (see Major finding above).
3. Both test gaps are in the test file, not production code.

---

## Suggested next steps

1. Address the property test invariant in `scripts/test-opencode-liveness.mjs` before merging — the broken invariant will cause CI noise.
2. Optionally document the `livenessReason` change for the same-session both-signal case.
3. The test script's pre-existing tsc failure should be investigated and fixed as a separate task so the test suite actually runs.
