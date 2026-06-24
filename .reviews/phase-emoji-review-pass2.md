# Code Review — Pass 2

## Verdict

APPROVE

## Summary

- The blocker from pass 1 (equal-timestamp part ordering) is fixed for the API
  path, with a backward-scan that correctly picks the *last* (newest) part in the
  max-time bucket when parts are in insertion order.
- The backward scan has a subtle asymmetry for the SQLite path (see non-blocking
  finding), but this is an edge case of an edge case and does not block.
- Data flow is clean: `AgentPhase` propagates through both session-fetch paths,
  flows through the `AgentSession` interface, and is consumed via SSE without
  any changes to the event system or server routes.
- The title-line prefix removal (`opencode - `) is straightforward and correct.
- `npm run check` and `npm run build` both pass with 0 errors.

## Blocking findings

None.

## Non-blocking findings

- [Severity: Minor] Backward-scan input-ordering assumption does not hold for
  the SQLite path.

  **Why this matters:** The backward scan in `inference.ts:70-78` walks from
  the end of `ordered` to find the *last* element at `maxTime`. It relies on
  stable sort preserving the original insertion order within each time bucket.
  This is correct for the API path (parts built in ascending/insertion order →
  last match = newest part). But the SQLite path builds `normalized` from a
  query with `ORDER BY time_created DESC`, so parts at the same timestamp are
  newest-first. The backward scan therefore picks the *oldest* part in that
  bucket for SQLite sessions.

  **Impact:** When multiple parts of a single message have the *exact same*
  `time_created` (in practice, they often differ by ms), the phase inference
  for SQLite-only sessions could show an earlier part's type instead of the
  latest. This is cosmetic (wrong emoji) and only affects sessions read from
  the SQLite fallback path when the API is unavailable.

  **Evidence:** `src/lib/status/inference.ts:70-78`, contrasted with the
  SQLite query at `src/lib/agents/opencode.ts:605` (`ORDER BY time_created
  DESC`).

  **Recommended fix:** Normalize the `parts` argument to a consistent order
  inside `analyzeParts` before the stable sort, so `ordered[0]` always yields
  the newest part regardless of source:

  ```
  const partsAsc = [...parts].sort((a, b) => a.time - b.time || 1);
  const ordered = partsAsc.reverse();
  ```

  This gives DESC order with ascending-time-order guaranteed within each time
  bucket. `ordered[0]` is then always the newest part at maxTime for both
  paths.

- [Severity: Minor] Pure-module contract weakened in `inference.ts`

  The file header states it has "only type-only imports, which `tsc` erases"
  and should be compilable under plain `node` for unit testing. The new
  `import { isBlocked }` is a value import that pulls in a runtime dependency
  on `types.ts`. The embedded comment acknowledges this, and it causes no
  build issues, but a test harness would need to bundle `types.ts` too.

  If unit-testing `inferPhase` becomes important, extracting the
  `isBlocked`-equivalent check or re-exporting `isBlocked` from `inference.ts`
  would restore the stand-alone property.

- [Severity: Minor] `error → blocked` semantic stretch

  `inferPhase` maps `status === 'error'` to `'blocked'`. The frontend does not
  use `phase` for error sessions (drives icon via `showBlockedIcon`, which
  gates on `isBlocked()` only, not `error`), so this has no current impact. If
  a future consumer uses `phase === 'blocked'` to mean "waiting for user
  input", error sessions would be incorrectly classified. Worth reconsidering
  if `error` should map to `'idle'` or a new `'error'` phase value instead.

## Simplicity and design notes (KISS/YAGNI/DRY/SOLID)

- **YAGNI obeyed**: No speculative extension points. Phase inference is
  minimal and directly consumed.
- **DRY respected**: The two icon blocks (root + child sessions) in
  `+page.svelte` are cleanly extracted into `showPhaseIcon` and
  `showBlockedIcon` helpers rather than duplicating inline logic.
- **DRY concern**: `+page.svelte:183` retains a pre-existing `isBlockedStatus`
  local function that is semantically equivalent to the imported `isBlocked`
  from `types.ts`. It appears unused (no call sites in the template). This was
  pre-existing and not introduced by this change, but would be a trivial
  cleanup.
- **SOLID — Single Responsibility**: `inferPhase` is a pure function with a
  clear contract: status + part signals → phase. It does not reach into I/O or
  state. Good.
- The frontend correctly separates *icon display* (status-driven via
  `showBlockedIcon`, or phase-driven via `showPhaseIcon`+`phaseEmoji`) from
  *badge/dot display* (status-driven). No mixed concerns.

## Test gaps

No test framework is configured in this project. No tests were expected. If
tests are added later (`inferPhase` is a pure function and trivially testable):

- `working + reasoning → 'reasoning'`
- `working + text → 'generating'`
- `working + active non-blocking tool → 'using_tool'`
- `blocked_* + any parts → 'blocked'`
- `error + any parts → 'blocked'` (or re-decided per finding above)
- `complete + any parts → 'idle'`
- `idle + any parts → 'idle'`
- `working + empty parts → 'idle'`
- `working + submit_plan active tool → 'blocked'` (status takes priority)
- `working + no parts → 'idle'`

## Suggested next steps

1. **(Optional, low priority)** Apply the input-ordering normalization in
   `analyzeParts` described in the minor finding above, so the backward-scan
   is correct for both paths without conditionals.
2. **(Optional, low priority)** Remove the unused `isBlockedStatus` local
   function from `+page.svelte` unless it is called outside the rendered view
   I can see.
