# Plan: Fix submit_plan Sessions Incorrectly Showing Error

## Goal

Goal: classify an active `submit_plan` review as `blocked_review` even when older
tool parts in the same session contain `state.status = 'error'`.

## Current State

- Live diagnosis shows `Dashboard performance profiling and CPU load reduction`
  as `status: "error"`, `blockReason: null`, and not blocked.
- OpenCode DB evidence for session `ses_12711255effeIpai31U4Rnrefp`:
  - Latest assistant message `msg_edfcce2fe0015FEZzXn4wtzxsm` has
    `submit_plan` part `prt_edfd01a24001XcPl6aMaXeoIe5` with
    `status: "running"` and `completed: null`.
  - Older assistant message `msg_edb8da694001xVMA9TB5i813qk` has a
    `submit_plan` part `prt_edb901182001g6IMSQLWEz68uH` with
    `status: "error"`.
- `src/lib/agents/opencode.ts:591-599` reads the latest 80 parts across the whole
  session and passes them into `parsePartData()`.
- `src/lib/status/inference.ts:79-82` computes `hasError` as any error tool part
  in that broad part window.
- `src/lib/status/inference.ts:139-146` returns `error` before checking active
  `submit_plan`, so the older error masks the latest active plan review.

## Assumptions

- `blocked_review` should outrank stale or older tool errors when the latest turn
  is waiting on an active `submit_plan`.
- First-class `error` status should represent current/latest-turn failures, not
  any historical error in the last N parts.
- The dashboard should preserve existing stale-running protection: a running tool
  should only count as active if no later terminal part for the same `callID` and
  no later natural stop boundary invalidates it.

## Recommended Plan

1. Change `analyzeParts()` error scoping in `src/lib/status/inference.ts`.
   - Replace the broad `ordered.some(tool.status === 'error')` check with a
     turn-scoped/latest-message-compatible check.
   - Minimal safe rule:
     - `hasError = latestTool?.status === 'error'`, or
     - if keeping broader support, only count an error part when it is newer than
       the most recent active blocking tool.
   - Preferred rule for simplicity and reference alignment:
     - derive error from the latest relevant tool part only.

2. Reorder status priority in `inferOpencodeStatus()`.
   - Check live/manual blocking first:
     1. `hasPermission` => `blocked_permission`
     2. `hasQuestion` => `blocked_question`
     3. active `submit_plan` or active `plan_exit` => `blocked_review`
     4. active `question` => `blocked_question`
   - Then check `hasError` => `error`.
   - This matches reference behavior: needs-input states outrank tool errors.

3. Support both plan-review tool names.
   - Treat active `submit_plan` and active `plan_exit` as `blocked_review`.
   - This closes the documented plan-review tool-name mismatch risk.

4. Add deterministic tests in `scripts/test-status-inference.mjs`.
   - Case A: older `submit_plan:error`, newer `submit_plan:running` =>
     `blocked_review`.
   - Case B: latest tool error with no active blocking tool => `error`.
   - Case C: permission/question still outrank error.
   - Case D: stale running `submit_plan` after natural stop remains non-blocking.

5. Validate against the real session after implementation.
   - Run the inference self-test.
   - Run `npm run check` and `npm run build`.
   - Restart dashboard.
   - Query:
     `GET /api/status/diagnose`
   - Expected for `Dashboard performance profiling and CPU load reduction`:
     - `status: "blocked_review"`
     - `blockReason: "review"`
     - `isBlocked: true`

## Validation Plan

- `node scripts/test-status-inference.mjs`
  - Expected: all tests pass, including new mixed error/submit_plan fixtures.
- `npm run check`
  - Expected: 0 Svelte/TypeScript diagnostics.
- `npm run build`
  - Expected: production build succeeds.
- Runtime API check after restart:
  - `/api/status/diagnose` should report the target session as
    `blocked_review`, not `error`.

## Risks and Mitigations

- Risk: real current tool failures stop surfacing as `error`.
  - Mitigation: keep/latest-tool error test so latest terminal error still maps
    to `error`.
- Risk: stale `submit_plan` running parts produce false blocked states.
  - Mitigation: preserve existing `active` computation with terminal callID and
    natural-stop guards.
- Risk: changing priority hides simultaneous permission/question errors.
  - Mitigation: blocking states are actionable and should be surfaced first;
    tests should assert this priority.

## Open Questions

- None blocking. The live DB evidence directly reproduces the bug.
