# Code Review (Second Pass)

**Reviewing:** Second-pass review of the stale `process_session_id` / `hasActiveTool` staleness fix  
**Previous review:** `.reviews/review-pass-1.md` (1 Blocker? 0 | Major: 1 | Minor: 1)

## Verdict

**APPROVE**

## Summary

- The sole [Major] finding from pass 1 (property test invariant broken by PSID suppression) is **correctly resolved**.
- Test fix is minimal — 7 lines of targeted exemption logic — and covers all edge cases of the stale-PSID suppression scenario.
- All 200 random seeds pass (1735 property checks, 0 failures). Production checks (`npm run check`, `npm run build`) pass cleanly.
- No new issues, regressions, or style drift introduced by the test fix.

## Blocking findings

None.

## Non-blocking findings

None new. The [Minor] finding from pass 1 (same-session both-signal `livenessReason` change) remains acknowledged and acceptable — the JSDoc on `directReason` adequately documents the behavior.

## Test fix correctness analysis

The exemption at `scripts/test-opencode-liveness.mjs:192-200` was carefully reviewed for every combination:

| PSID | hasStatusSignal | directory | Other session hasStatusSignal in same dir | Exemption triggers? | Expected behavior | Correct? |
|------|----------------|-----------|------------------------------------------|---------------------|-------------------|----------|
| true | false | truthy | true | **yes** — PSID suppressed, assertion skipped | Suppression is correct; test correctly exempts | ✅ |
| true | false | truthy | false | **no** — no conflict, PSID stays live | Assertion runs, `instanceAlive === true` | ✅ |
| true | false | falsy | N/A | **no** — `!direct.directory` is false | No suppression (prod line 61 short-circuits on `!candidate.directory`) | ✅ |
| true | true | any | any | **no** — `!direct.hasStatusSignal` is false | Candidate gets `status_map` liveness; assertion checks `instanceAlive === true` | ✅ |
| false | any | any | any | **no** — first condition fails | Normal assertion path | ✅ |

The exemption is precise: it only skips the invariant assertion for the exact scenario where production code suppresses a PSID signal. No other paths are affected.

## Simplicity and design notes (KISS/YAGNI/DRY/SOLID)

- The test fix matches the production code's behavior exactly — not broader, not narrower. No speculative exemption.
- The implementation reuses existing primitives (`candidates.some`, `c.id !== direct.id`) rather than adding test-only utilities. Minimal diff.
- `hasDirectSignal()` in the test remains unchanged — still includes `hasProcessSessionId` — which is correct because PSID *is* a direct signal in general; only the assertion loop needs an exemption for the suppression case. Removing PSID from `hasDirectSignal` would have broken other invariants (cwd allocation ordering).

## Test gaps

None in scope. The deterministic tests and property sweep both pass cleanly. The three deterministic test gaps noted in pass 1 (no dedicated staleness-guard test cases) remain but are acceptable — the property sweep exercises the interaction across 200 scenarios.

## Suggested next steps

1. No further changes needed on this branch. The pass-1 finding is fully resolved.
2. If test coverage is a priority for future work, add dedicated deterministic test cases for the PSID-staleness-guard scenarios (stale PSID suppressed → `hidden_stale`, same-session both signals → `status_map`, null directory PSID not suppressed).
