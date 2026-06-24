# Code Review: Phase Emoji Display + Prefix Removal

## Verdict
REQUEST CHANGES

## Summary
- The change is well-scoped and the data flow (inference → opencode → frontend) is cleanly wired.
- There is one **blocker correctness bug** in `analyzeParts` for the API path that causes the phase to always reflect the **first** part of the most recent message, not the **last**.
- The prefix removal (`opencode - ` title) is correct and complete.
- Overall quality is high, but the API-path bug means phase emojis will be wrong for most multi-part sessions served via the API.

## Blocking findings

- [Severity: Blocker] `analyzeParts` picks the wrong part for equal-timestamp parts

  **Why this matters:** The `latestPartType` and `latestPartIsActiveTool` values determine which phase emoji is shown. If they are wrong, the dashboard shows a misleading signal (e.g., 🧠 when the agent is actually 🔧).

  **Evidence** (`src/lib/status/inference.ts:54-60`):

  All parts within a single API message share the same `time` value (`src/lib/agents/opencode.ts:497-505`).  The sort at line 54 is stable, so equal-time elements retain their original insertion order.  The original insertion order is chronological (the loop at line 498 iterates `message.parts` in sequential order), which means `ordered[0]` is the **first** part of the most recent message, not the **last** — but the last part is what the agent is *currently* doing.

  Example: a message with parts `[reasoning, text, tool(call)]` produces `latestPartType === 'reasoning'` and `latestPartIsActiveTool === false`. The phase becomes `'reasoning'` (🧠) instead of `'using_tool'` (🔧).

  The SQLite path is **not** affected because each part has a distinct `time_created`.

  **Recommended fix:**

  In `analyzeParts` (`src/lib/status/inference.ts`), replace the existing `latestPartType`/`latestPartIsActiveTool` computation (lines 57-60) with a backward scan through the max-time group:

  ```typescript
  // Most recent part of any type (for phase inference).
  // For equal-time parts (e.g., all parts of a single API message), the last one
  // in insertion order is chronologically the latest — walk backward from the end
  // to find it.
  let latestPartType: string | null = null;
  let latestPartIsActiveTool: boolean = false;
  if (ordered.length > 0) {
    const maxTime = ordered[0].time;
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (ordered[i].time !== maxTime) break;
      const p = ordered[i];
      latestPartType = p.type;
      latestPartIsActiveTool = p.type === 'tool'
        && (p.status === 'pending' || p.status === 'running');
      break;
    }
  }
  ```

  This preserves the existing constant names and maintains consistency with the existing `hasError` computation at line 106 (which also only looks at the latest tool).

## Non-blocking findings

- [Severity: Minor] `inferPhase` uses `status.startsWith('blocked')` instead of the `isBlocked()` helper

  **Why this matters:** `isBlocked()` in `types.ts` is the canonical list of blocked statuses. Writing a parallel `startsWith('blocked')` check creates a maintenance trap — if a future status like `'blocked_custom'` should *not* be treated as blocked by the phase logic, or if `isBlocked()` gains additional matching logic, the two paths can diverge.

  **Recommended fix:** Import `isBlocked` from types (it's already a type-only-import-context — `isBlocked` is a value, so this would add a non-type import, but `inference.ts` only has `import type` currently — the fix is trivial):

  ```typescript
  import { isBlocked } from '../agents/types';
  ```

  Then at line 200:
  ```typescript
  if (isBlocked(status) || status === 'error') return 'blocked';
  ```

  (Note: the import change from `import type` to `import` does not affect the existing property of being compilable standalone under plain `node` — `isBlocked` is a pure function that does not pull in any runtime side-effects.)

- [Severity: Minor] `error` status maps to phase `'blocked'`, but the UI never uses it

  **Evidence:** `inferPhase` returns `'blocked'` for `error` status (`inference.ts:200`). However, `showPhaseIcon` in `+page.svelte:258-261` only returns `true` for `working`/`retry`, and `showBlockedIcon` at lines 263-268 does not include `error`. So `error` sessions always fall through to `agentIcon`. The phase value is set but unused.

  **Why this matters:** While harmless today, it is confusing for debugging/logging — if someone inspects a session object and sees `phase: 'blocked'` alongside `status: 'error'`, they may reasonably assume the phase is driving some behavior when it isn't.

  **Recommended fix:** Either (a) remove the `status === 'error'` case from `inferPhase` and let it fall through to `'idle'` (since error is already well-represented by the ❌ badge), or (b) add a comment explaining that error→blocked is intentionally reserved for future UI use.

- [Severity: Minor] `showBlockedIcon` duplicates `isBlocked` logic

  **Evidence:** `+page.svelte:263-268` manually checks four `blocked*` variants. The exact same check exists as `isBlocked()` in `types.ts:23-30`, which is already imported at line 3.

  **Recommended fix:**
  ```typescript
  import { compareSessions, isBlocked, type AgentStatus } from '$lib/agents/types';
  ...
  function showBlockedIcon(session: Session): boolean {
    return isBlocked(session.status);
  }
  ```

## Simplicity and design notes (KISS/YAGNI/DRY/SOLID)

- **Good separation**: `inferPhase` is a pure function in `inference.ts`, keeping it unit-testable alongside `inferOpencodeStatus`. The data flows are consistently wired through both SQLite and API paths.
- **Good choice**: Making `phase` optional (`phase?` on both server-side `AgentSession` and frontend `Session`) means non-OpenCode agents naturally opt out — no dummy values needed.
- **Acceptable duplication**: The `isBlockingTool` check (`submit_plan` / `plan_exit` / `question`) appears in `inferOpencodeStatus` and again in `inferPhase`. This is intentional — the blocking-tool logic is used for different purposes (status inference vs. phase inference) and the phase function needs to exclude these from `using_tool`. The overlap is acceptable.
- **Minor scope creep**: The title prefix removal (goal 2) is bundled with the phase emoji changes (goal 1). This is fine for a single commit, but if either change needs reverting, the coupling is unnecessary.

## Test gaps

- No test suite exists in this project. If tests are added later:
  - `inferPhase` should be tested with every combination of `(status, latestPartType, latestPartIsActiveTool, latestTool)` — especially: blocked/error statuses always win, complete/idle always return idle, working with null parts returns idle, API multi-part messages produce correct latest part.
  - `analyzeParts` should be tested with equal-time parts (simulating a multi-part API message) to confirm the backward-scan fix is correct.

## Suggested next steps

1. Fix the blocker bug in `analyzeParts` (backward scan for equal-time parts).
2. Consider the three minor findings (non-blocking, can be follow-up).
3. Re-run `npm run check` and `npm run build`.
4. Restart the dashboard to confirm the fix.
