# Code Review

## Verdict
REQUEST CHANGES

## Blocking gaps
- [Severity: Major] `/path`-only liveness can still surface a stale idle session forever.
  - Evidence: `/path` directory was promoted into `directoryAllocationCounts`, allowing allocation without process-backed evidence.
  - Recommended fix: preserve `/path` as diagnostic context only; do not feed it into cwd liveness allocation unless paired with process-backed evidence.

## Non-blocking improvements
- [Severity: Minor] `getSessionsFromPort` and `getStatusFromPort` are dead helpers after removing serve-port roster liveness.
  - Recommended fix: remove them to keep liveness semantics narrow and easier to reason about.

## Remediation applied
- Removed `/path` promotion into `directoryAllocationCounts`.
- Added `/path`-only stale regression coverage in `scripts/test-opencode-liveness.mjs`.
- Removed unused serve-port session/status helper exports from `src/lib/process/poller.ts`.

## Validation after remediation
- `./run_tests.sh` passed after remediation and dashboard rebuild.
