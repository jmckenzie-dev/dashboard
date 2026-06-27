---
submitted-at: "2026-06-26T17:16:15.250Z"
title: "Fix: Stale Blocked (awaiting review) Sessions Persisting in Dashboard"
auto-captured: true
---
# Fix: Stale Blocked (awaiting review) Sessions Persisting in Dashboard

## Goal
Remove old, closed, defunct opencode sessions from the dashboard that show as
"Blocked (awaiting review)" or "Working" even though the owning opencode instance
has been dead for days. The sessions that the user specifically called out are
from June 22-24, 2026.

## Root Cause

The opencode `submit_plan` (and `plan_exit`) tool can get **stuck in `running`
state** when the opencode instance dies or is killed mid-tool. The tool's
`state.status` is set to `"running"` during execution but is never terminalized
to `"completed"` or `"error"` because the owning process is gone.

This causes a cascade in the dashboard's liveness logic:

1. **`analyzeParts`** (src/lib/status/inference.ts:48) sees the tool part with
   `status === "running"`, no terminal part with the same `callID`, and no
   `step-finish` / `reason=stop` after it → `latestTool.active = true`.

2. **`inferOpencodeStatus`** (src/lib/status/inference.ts:170-171) sees
   `toolName === "submit_plan" && toolActive` → returns `"blocked_review"`.

3. **`allocateOpenCodeLiveness`** (src/lib/agents/opencode-liveness.ts:29)
   sees `hasActiveTool === true` → returns `directReason = "active_tool"`
   with `visibilityReason = "active_tool"`.

4. **`applyLivenessDecisions`** (src/lib/agents/opencode.ts:389) does NOT
   filter the session because `visibilityReason !== "hidden_stale"`.

5. **`isVisibleOpenCodeSession`** (src/lib/agents/index.ts:22-24) sees
   `reason = "active_tool"` which is truthy and not `"hidden_stale"` → returns
   `true`.

**Result**: 15 sessions with stuck tools (12 × `submit_plan`, 3 × `plan_exit`)
appear forever in the dashboard as "Blocked (awaiting review)".

### Evidence

- SQLite shows 12 sessions with `submit_plan` stuck at `state.status = "running"`,
  and 3 with `plan_exit` stuck at `"running"`.
- The opencode server's `/session/status` returns `{}` (no currently active
  sessions), confirming these are all dead.
- The opencode `/permission` and `/question` endpoints return `[]` (no pending
  blocks).
- The dashboard container cannot see host processes, so `hasProcessSessionId`
  is always `false` for all sessions, making `hasActiveTool` the only direct
  liveness signal that can keep a stale session visible.

### Affected Sessions (Partial List, by `time_updated`)

| Date       | Session                                                      | Status  |
|------------|--------------------------------------------------------------|---------|
| Jun 25     | 2nd opinion mode execution and OpenCode session error fixes  | running |
| Jun 25     | Testing plan submission pipeline                             | running |
| Jun 23     | Submit dummy test plan for bridge testing                    | running |
| Jun 22     | LiveCodeBench failure debugging and canonical benchmark setup| running |
| Jun 19     | Dashboard performance profiling and CPU load reduction       | running |
| Jun 11     | Submit dummy draft test plan                                 | running |
| Jun 10     | New session - 2026-06-10T13:41:30.121Z                      | running |
| May 12     | nvfp4-toolkit.sh fp8 activation update (*plan_exit*)         | running |

## Current State

The `allocateOpenCodeLiveness` function in `src/lib/agents/opencode-liveness.ts`
evaluates each session's liveness using four direct checks (status signal,
blocking request, active tool, process session ID). The `hasActiveTool` check
has **no time cutoff** — a tool part from 4 days ago with `status: "running"`
is treated as equal evidence of liveness as a tool that started 5 seconds ago.

## Assumptions

- **The dashboard runs inside a container** (`ai-agent-dashboard` podman
  container). Host OS processes are invisible to `scanProcesses()`, so
  `hasProcessSessionId` is always `false` for the opencode sessions whose
  instances run on the host.
- The opencode server (`opencode serve --port 4096`) is a separate process on
  the host; the dashboard accesses it via `host.containers.internal:4096`.
- A tool part with `status: "running"` that is more than 30 minutes old is
  *not* evidence of a live instance. The threshold is generous: plan reviews
  can take minutes, but not days, and if the opencode process were alive it
  would terminalize the tool or produce newer parts.

## Recommended Plan

The smallest, safest change: **add a staleness bound for the `hasActiveTool`
liveness signal** in `allocateOpenCodeLiveness`. If the session's
`lastActivity` is older than a fixed threshold, do not treat `hasActiveTool`
as a direct liveness signal. The session will still fall through to the
`hidden_stale` path and be filtered out normally.

### Step 1: Add staleness constant in `opencode-liveness.ts`

File: `src/lib/agents/opencode-liveness.ts`

Add a new exported constant after `RECENT_ACTIVE_FALLBACK_MS`:

```typescript
// Maximum age of an active-tool signal to count as evidence of liveness.
// Tools stuck in 'running' for longer than this are assumed orphaned
// (owning process died without terminalizing the tool).
export const ACTIVE_TOOL_LIVENESS_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
```

### Step 2: Add age check in `directReason`

File: `src/lib/agents/opencode-liveness.ts`

Modify the `directReason` function to accept an optional `now` parameter and
check `lastActivity` age when evaluating `hasActiveTool`:

```typescript
function directReason(
  candidate: OpenCodeLivenessCandidate,
  now: number,
): OpenCodeSessionReason | null {
  if (candidate.hasBlockingRequest) return 'blocking_request';
  if (candidate.hasActiveTool) {
    // Only count as live if the activity is recent enough.
    if (now - candidate.lastActivity.getTime() <= ACTIVE_TOOL_LIVENESS_MAX_AGE_MS) {
      return 'active_tool';
    }
  }
  if (candidate.hasProcessSessionId) return 'process_session_id';
  if (candidate.hasStatusSignal) return 'status_map';
  return null;
}
```

### Step 3: Pass `now` through `allocateOpenCodeLiveness`

File: `src/lib/agents/opencode-liveness.ts`

The existing `now` parameter is already the third argument (defaults to
`Date.now()`). The call site in `directReason` invocation needs updating:

```typescript
// In allocateOpenCodeLiveness, change the loop:
for (const candidate of candidates) {
  const reason = directReason(candidate, now);  // ← pass now
  if (!reason) continue;
  ...
}
```

### Step 4: Verify no other callers need `now`

The `allocateOpenCodeLiveness` function is called from exactly one place:
`applyLivenessDecisions` in `src/lib/agents/opencode.ts:394`. That call does
NOT pass `now`, so the default (`Date.now()`) is used — which is correct.

File: `src/lib/agents/opencode.ts:394`
```
const decisions = allocateOpenCodeLiveness(
  candidates.map((candidate) => candidate.liveness),
  liveness.directoryAllocationCounts,
  // now defaults to Date.now() ← correct
);
```

### Step 5 (Optional but recommended): Re-archive old stuck sessions

As a one-time cleanup, archive the 15 known stuck sessions in the SQLite DB so
they stop being queried entirely. This is safe because the sessions are dead —
the opencode `serve` process does not hold them open.

```sql
UPDATE session SET time_archived = 1782493267000
WHERE id IN (
  'ses_104c2e528ffe0Fcg6w2DRPnZqF',
  'ses_104cbec86ffe1bGBCv70Ye5Oyq',
  'ses_109d33162ffeMhM1J0vZ4VqIin',
  'ses_10ee92106ffe5oCIKf6D4SttKQ',
  'ses_12711255effeIpai31U4Rnrefp',
  'ses_13f6cb637ffeAFox5CdP0fq2L1',
  'ses_137d914baffeyDKA1bwX7qBAMA',
  'ses_13f56b806ffeTi2hxLxob0nEbf',
  'ses_148c49354ffe3YFJIIef8s78Ol',
  'ses_1493e5701ffemEyTzKGx48RFRN',
  'ses_14d8c57b0ffeQM1fvmkS7GGu15',
  'ses_14e3bbc76ffejJhpXR3Tqddhnv',
  'ses_2c08172ffffeVgWUG3DvXutq4h',
  'ses_270e1dd0affeQoLK3DPXmZtfIW',
  'ses_270defa33fferTB18edgRNDGuB'
);
```

These are the root sessions (no parent). After archiving, the dashboard's SQL
query (`WHERE time_archived IS NULL`) will skip them entirely.

Alternatively, skip Step 5 — the liveness fix alone prevents them from
appearing, and archiving is a manual cleanup that doesn't affect correctness.

## Validation Plan

1. **TypeScript check**: `npm run check` — must pass with no new errors.

2. **Build**: `npm run build` — must produce a working production bundle.

3. **Restart**: `./restart_dashboard.sh` — must restart the container cleanly.

4. **Dashboard inspection**: After restart, open the dashboard and verify:
   - No sessions show as "Blocked (awaiting review)" unless there is an
     actively running opencode instance blocked on Plannotator.
   - The stale sessions from June 22-24 are no longer visible.
   - Any genuinely active sessions (if any are running) still appear.

5. **API confirmation**: Confirm `/session/status` returns `{}` and
   `/session` still lists sessions as expected:
   ```
   curl -u 'jmckenzie:<password>' \
     -H 'x-opencode-directory: /' \
     http://host.containers.internal:4096/session/status
   ```

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| A genuinely blocked session (active Plannotator review) has lastActivity > 30 min and briefly disappears from the dashboard | Very low — if the process is alive it produces parts or status updates | The threshold is generous (30 min); Plannotator reviews typically resolve in <5 min or trigger a status update. If this does happen, refreshing or waiting for the next poll tick (every 500ms) will show the session again if it produces new activity. |
| The `now` parameter drift causes inconsistent behavior between test and production | Negligible | `now` defaults to `Date.now()` in both `allocateOpenCodeLiveness` and (after the fix) in `directReason`. The single call site in `opencode.ts` doesn't pass `now`, so the default applies uniformly. |
| The fix doesn't address sessions that appear as "working" or "idle" from the same era | Low | Those sessions get `hidden_stale` through the normal path (no direct signals) and are already filtered. Only `blocked_review` sessions with stuck tools bypass the filter. |

## Open Questions

- Should the 30-minute threshold be configurable via `dashboard.toml`?
  Answer: Not for v1. Hard-code it; the user can open an issue if they need
  tunability.
- Should we also archive sessions with `submit_plan` / `plan_exit` tools in
  `error` or `completed` state that are very old (>7 days)?
  Answer: Not in scope for this fix — those sessions aren't causing a visible
  problem.
