---
submitted-at: "2026-07-02T14:05:41.895Z"
title: "Fix: Blocked Review Sessions Stay Visible After TUI Process Dies"
auto-captured: true
---
# Fix: Blocked Review Sessions Stay Visible After TUI Process Dies

## Goal
Prevent `blocked_review` sessions (awaiting plan review) from remaining visible
in the dashboard after the owning opencode TUI process has died, when the only
liveness signal is a stale `submit_plan`/`plan_exit` tool part stuck in
`pending` status.

## Current State

The previous fix (commit `043cc00`) added `ACTIVE_TOOL_LIVENESS_MAX_AGE_MS` (30
minutes) to `opencode-liveness.ts`, which prevents very old orphaned tools from
keeping sessions alive. However, a `blocked_review` session whose TUI died **8
minutes ago** is still well within the 30-minute window.

**Session evidence** (from `npm run dump:sessions -- --json`):

```
id:       opencode-ses_0dd29d52dffersJq0kysxIvAyV
title:    opencode TUI CPU usage investigation PID 2193281
status:   blocked_review
visible:  true
instanceAlive: true
livenessReason:  active_tool
visibilityReason: active_tool
lastActivity:    8m ago
hasProcessSessionId: false
hasActiveInstance: false
latestTool: { tool: "submit_plan", status: "pending", active: true, time: 8m ago }
```

**Root cause chain:**

1. TUI process (PID 2193281) died while `submit_plan` was `pending` — tool part
   never terminalized (no `completed`/`error` status, no `step-finish(reason=stop)`)
2. `analyzeParts` (inference.ts:48) → `latestTool.active = true` (pending +
   no terminal callID + no stop after it)
3. `inferOpencodeStatus` (inference.ts:170) → `blocked_review` (no staleness
   cutoff by design — reviews legitimately last up to 96h)
4. `directReason` (opencode-liveness.ts:53-57) → `active_tool` (age 8m < 30m
   `ACTIVE_TOOL_LIVENESS_MAX_AGE_MS`)
5. Session stays visible despite no backing process

**Why existing processes don't help:**
- `hasProcessSessionId: false` — PID 2193281 is confirmed dead (`ps` shows no
  such process)
- `hasActiveInstance: false` — session absent from API `/session/status`
- The current running opencode TUI (PID 2) is flagless (no `-s`), so it
  contributes no `hasProcessSessionId` for any session

## Assumptions

- `blocked_review` status is ONLY produced by `submit_plan`/`plan_exit` tools
  being active (inference.ts:170-172). No other code path produces it.
- `hasProcessSessionId` is reliable for detecting whether a TUI process with a
  given session ID is running. It comes from `ps -eo pid,args` parsing, which
  reads world-readable `/proc/<pid>/cmdline`.
- A `blocked_review` session without a backing TUI process is always orphaned
  — the user cannot review a plan without the TUI.
- The hysteresis layer (90s grace window in `visibility-hysteresis.ts`)
  protects against transient process scanner failures.

## Recommended Plan

**Approach: Option A** — Require `hasProcessSessionId` for `blocked_review`
`active_tool` liveness.

### Step 1: Modify `directReason` in `opencode-liveness.ts`

**File:** `src/lib/agents/opencode-liveness.ts`

**Change:** In the `hasActiveTool` branch of `directReason()`, after the age
check passes, add a guard: if the candidate's status is `blocked_review` AND
`hasProcessSessionId` is false, skip returning `active_tool`. The candidate
will fall through to subsequent liveness checks (`process_session_id`,
`status_map`, then `cwd_allocated` or `hidden_stale`).

**Before (lines 52-57):**
```typescript
if (candidate.hasActiveTool) {
    if (now - candidate.lastActivity.getTime() <= ACTIVE_TOOL_LIVENESS_MAX_AGE_MS) {
      return 'active_tool';
    }
  }
```

**After:**
```typescript
if (candidate.hasActiveTool) {
    if (now - candidate.lastActivity.getTime() <= ACTIVE_TOOL_LIVENESS_MAX_AGE_MS) {
      // blocked_review sessions (submit_plan/plan_exit) require process
      // confirmation — without a live TUI the tool part is orphaned.
      if (candidate.status === 'blocked_review' && !candidate.hasProcessSessionId) {
        // Orphaned: fall through to cwd_allocated / hidden_stale
      } else {
        return 'active_tool';
      }
    }
  }
```

**Rationale:** `blocked_review` means the TUI is displaying a plan and waiting
for user approval. If the TUI process is gone, the review can't happen and the
tool part is definitively orphaned. Other statuses with `hasActiveTool` (e.g.,
`working` with a `bash`/`read`/`write` tool) may legitimately have no
`hasProcessSessionId` (flagless TUI), so they keep the existing age-based
check.

### Step 2: Add regression tests in `scripts/test-opencode-liveness.mjs`

**File:** `scripts/test-opencode-liveness.mjs`

Add the following test cases before the property sweep section:

```javascript
// blocked_review without process → hidden_stale (orphaned submit_plan)
decisions = allocateOpenCodeLiveness([
  candidate('a-blocked-review-no-proc', {
    offset: 8 * 60 * 1000,  // 8 min ago
    status: 'blocked_review',
    hasActiveTool: true,
    hasProcessSessionId: false,
  }),
], {}, NOW);
assertEqual(
  decisions.get('a-blocked-review-no-proc').visibilityReason,
  'hidden_stale',
  'blocked_review without process session is hidden_stale',
);

// blocked_review WITH process → active_tool (legitimate review)
decisions = allocateOpenCodeLiveness([
  candidate('a-blocked-review-with-proc', {
    offset: 8 * 60 * 1000,  // 8 min ago
    status: 'blocked_review',
    hasActiveTool: true,
    hasProcessSessionId: true,
  }),
], {}, NOW);
assertEqual(
  decisions.get('a-blocked-review-with-proc').visibilityReason,
  'active_tool',
  'blocked_review with process session keeps active_tool liveness',
);

// blocked_review without process but within age bound → hidden_stale
decisions = allocateOpenCodeLiveness([
  candidate('a-blocked-review-recent-no-proc', {
    offset: 60_000,  // 1 min ago (well within 30 min bound)
    status: 'blocked_review',
    hasActiveTool: true,
    hasProcessSessionId: false,
  }),
], {}, NOW);
assertEqual(
  decisions.get('a-blocked-review-recent-no-proc').visibilityReason,
  'hidden_stale',
  'blocked_review without process is hidden_stale even when very recent',
);

// working with active tool but no process → active_tool (flagless TUI)
decisions = allocateOpenCodeLiveness([
  candidate('a-working-no-proc', {
    offset: 60_000,
    status: 'working',
    hasActiveTool: true,
    hasProcessSessionId: false,
  }),
], {}, NOW);
assertEqual(
  decisions.get('a-working-no-proc').visibilityReason,
  'active_tool',
  'working with active tool keeps active_tool even without process session',
);
```

### Step 3: Verify with `npm run check` and `npm run build`

Run the standard project checks to ensure no type errors or build failures.

## Validation Plan

1. **Run existing tests:** `node scripts/test-opencode-liveness.mjs` — all 16
   existing tests must still pass.

2. **Run new tests:** After adding the 4 new test cases, run the test file
   again — all 20 tests must pass (16 existing + 4 new).

3. **TypeScript check:** `npm run check` — must pass with no new errors.

4. **Build:** `npm run build` — must produce a working production bundle.

5. **Restart dashboard:** `./restart_dashboard.sh` — must restart cleanly.

6. **Dashboard inspection** (after restart):
   - The "opencode TUI CPU usage investigation PID 2193281" session should no
     longer be visible (it has no backing process).
   - Any genuinely active sessions with `blocked_review` status (from a running
     TUI) should remain visible.
   - All currently running opencode TUI sessions should appear with correct
     status.

7. **Dump verification:** Run `npm run dump:sessions -- --no-hidden --no-parts`
   and confirm the orphaned `blocked_review` session either doesn't appear or
   shows `visibilityReason: hidden_stale`.

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Process scanner transiently fails, causing legitimate `blocked_review` sessions to lose liveness | Low — scanner uses `ps` which is reliable; failure returns empty set | Hysteresis layer (90s grace window) keeps sessions visible during transient gaps |
| A future code path produces `blocked_review` without `submit_plan`/`plan_exit` | Very low — only inference.ts:170-172 produces `blocked_review` | If this changes, the liveness check must be updated to match |
| Flagless TUI with `blocked_review` status (TUI launched without `-s`) | N/A — a flagless TUI can't have `blocked_review` because it has no session ID to associate with a `submit_plan` part | No action needed; this scenario is impossible |
| `hasProcessSessionId` false due to bwrap sandbox (process scanner misses the child) | Low — bwrap support was added in commit `043cc00`; the scanner now finds `opencode` after `--` in bwrap args | The child opencode process (visible in `ps`) carries the `-s` flag; both bwrap wrapper and child are detected |

## Open Questions

- None. The root cause is fully understood, the fix is targeted and testable,
  and the existing infrastructure supports it.
