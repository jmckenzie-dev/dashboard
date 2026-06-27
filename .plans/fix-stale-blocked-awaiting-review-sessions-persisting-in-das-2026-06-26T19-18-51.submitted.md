---
submitted-at: "2026-06-26T19:18:51.827Z"
title: "Fix: Stale Blocked (awaiting review) Sessions Persisting in Dashboard"
auto-captured: true
---
# Fix: Stale Blocked (awaiting review) Sessions Persisting in Dashboard

## Goal
Remove old, closed, defunct opencode sessions from the dashboard that show as
"Blocked (awaiting review)" or "Working" even though the owning opencode instance
has been dead for days. The sessions that the user specifically called out are
from June 22-24, 2026:
- 4 sessions showing "Blocked (awaiting review)"
- 1 session ("Modify vLLM PR for venv 5_8 install") showing "Working"

Additionally, ensure that ALL currently running opencode TUI sessions are
visible in the dashboard (even those launched inside bwrap sandboxes).

## Root Cause (Dual Problem)

### Problem 1: Stuck submit_plan/plan_exit tools

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

**Result**: 15 sessions SQL-wide have stuck tools (12 × `submit_plan`, 3 ×
`plan_exit`). Only 5 of these appear in the dashboard because the SQL query has
`LIMIT 200` ordered by `time_updated DESC`. The 5 visible ones are:

| Rank | Date       | Session                                                     |
|------|------------|-------------------------------------------------------------|
| 25   | Jun 25     | 2nd opinion mode execution and OpenCode session error fixes |
| 28   | Jun 25     | Testing plan submission pipeline                            |
| 51   | Jun 23     | Submit dummy test plan for bridge testing                   |
| 126  | Jun 22     | LiveCodeBench failure debugging and canonical benchmark set.|
| 192  | Jun 19     | Dashboard performance profiling and CPU load reduction      |

The remaining 10 stuck sessions (ranks 292-1101) fall outside the LIMIT 200,
so the dashboard never fetches them. The user sees 4 of these 5 (rank 192 may
also appear but is older).

### Problem 2: `scanProcesses()` misses bwrap-sandboxed opencode TUI sessions

The dashboard container already has `--pid=host` in its systemd unit file. It
CAN see all host processes. However, `scanProcesses()` (src/lib/process/poller.ts)
cannot detect opencode TUI sessions launched inside bwrap sandboxes because:

- `openCodeArgIndex()` only checks `args[0]` (for `opencode` binary) and
  `args[1]` (for node/bun/deno launchers). It does not recognize `bwrap`.
- All real opencode TUI sessions are wrapped in `bwrap --unshare-user --unshare-pid
  ... -- /path/to/opencode`, with `opencode` at arg index 116-119.
- Bare `opencode` processes (child of the bwrap PID namespace) show without
  session flags, so no session ID can be extracted.

This means `hasProcessSessionId` is always `false` for all sessions, and the
only liveness signal that can keep a dead session visible is `hasActiveTool`.

### Why the "Modify vLLM PR" session shows as "Working" (needs investigation)

This session (`ses_1f750b19dffeQfAVShN1uCS1wO`) has:
- Parts from May 8, 2026, `time_updated` = June 22, 2026
- Latest tool: `task` with status `completed` (active=false)
- No `submit_plan`/`plan_exit` tools
- Rank 138 in SQL query (within LIMIT 200)

Tracing through the logic, this session should get `status=idle`,
`visibilityReason=hidden_stale`, and be filtered out. Yet the user reports it
as "Working." Possible explanations:
1. The `time_updated` on the session row was updated by an external process
   (opencode server maintenance), making `lastActivity = June 22`, and some
   signal not yet identified keeps it visible.
2. The user may be recalling a different session with a similar title.
3. A transient state existed at the time of viewing.

This specific session will be addressed by the same fixes below (process-based
liveness + staleness bound), but further investigation may be needed if it
persists.

## Assumptions

- **The container `--pid=host` is already configured** and working. Host
  processes are accessible from within the container via `/proc`.
- `bwrap` is the only sandboxing mechanism wrapping opencode processes. No
  other unrecognized launchers exist.
- Opencode TUI sessions launched with `-s SESSION_ID` (or `--session`) will
  have that flag in the args after `--` in the bwrap command line, or in the
  bare child opencode process args.

## Options and Tradeoffs

### Option A: Add bwrap support to scanProcesses + staleness bound (Recommended)

Fix `scanProcesses()` to detect bwrap-wrapped opencode processes AND add a
time-based staleness bound for `hasActiveTool` liveness.

**Pros:**
- Direct PID-to-session mapping for all live TUI instances
- Dead sessions with stuck tools are filtered by staleness
- No deployment model change needed (container stays)
- All currently running TUIs become visible
- `--pid=host` already works; just needs code fix

**Cons:**
- Need to verify session-ID arg parsing actually works for bwrap children
- Two changes instead of one

### Option B: Staleness bound only

Only add the time-based cutoff for `hasActiveTool`. No process scanning fix.

**Pros:**
- Simplest change
- Fixes the blocked_review sessions

**Cons:**
- `hasProcessSessionId` still always false (no PID mapping)
- Dashboard cannot distinguish "genuinely blocked on Plannotator" from
  "dead session with stuck tool" for recent sessions
- All opencode TUI sessions are invisible to the process scanner

### Option C: Move dashboard to userspace (no container)

Run the dashboard directly on the host as a systemd user service, removing the
container layer.

**Pros:**
- Full unrestricted access to host processes, filesystem, etc.
- Simpler debugging (no exec needed)
- No need for `--pid=host` or any container mount tricks

**Cons:**
- Requires significant deployment changes (Containerfile, restart script,
  systemd unit, dependency management)
- Loses container isolation benefits
- More complex node version/dependency management
- Not strictly necessary since `--pid=host` already works

## Recommended Plan

**Approach: Option A** — Fix `scanProcesses()` for bwrap + add staleness bound
for `hasActiveTool`. The container already has host PID visibility; the code
just needs to recognize bwrap-wrapped opencode processes.

### Step 1: Add `bwrap` to recognized launchers in `poller.ts`

File: `src/lib/process/poller.ts`

Modify `openCodeArgIndex` to also scan for `opencode` in args after `bwrap`:

```typescript
function openCodeArgIndex(args: string[]): number {
  if (args.length === 0) return -1;
  if (isOpenCodeExecutable(args[0]!)) return 0;
  if (
    ['node', 'bun', 'deno'].includes(basename(args[0]!))
    && args[1]
    && isOpenCodeExecutable(args[1])
  ) {
    return 1;
  }
  // bwrap: find the first '--' separator, then look for opencode after it
  if (basename(args[0]!) === 'bwrap') {
    const dashDash = args.indexOf('--');
    if (dashDash !== -1) {
      for (let i = dashDash + 1; i < args.length; i++) {
        if (isOpenCodeExecutable(args[i]!)) return i;
      }
    }
  }
  return -1;
}
```

This scans for `--` in bwrap args and finds the `opencode` binary after it.
The `sessionIdFromArgs` function already extracts session flags from the
remaining args after the binary position, so it will pick up any `-s` or
`--session` flags.

**Risk**: The bwrap arg line is extremely long (~120 args). `sessionIdFromArgs`
scans ALL remaining args for `-s`, `--session`, `--session-id` patterns. This
is O(n) but the arg list is short enough that it won't impact poll performance
(the poll runs every 500ms already).

### Step 2: Add staleness bound for `hasActiveTool` in `opencode-liveness.ts`

File: `src/lib/agents/opencode-liveness.ts`

Add a new exported constant after `RECENT_ACTIVE_FALLBACK_MS`:

```typescript
// Maximum age of an active-tool signal to count as evidence of liveness.
// Tools stuck in 'running' for longer than this are assumed orphaned
// (owning process died without terminalizing the tool).
export const ACTIVE_TOOL_LIVENESS_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
```

Modify `directReason` to accept a `now` parameter and check age:

```typescript
function directReason(
  candidate: OpenCodeLivenessCandidate,
  now: number,
): OpenCodeSessionReason | null {
  if (candidate.hasBlockingRequest) return 'blocking_request';
  if (candidate.hasActiveTool) {
    if (now - candidate.lastActivity.getTime() <= ACTIVE_TOOL_LIVENESS_MAX_AGE_MS) {
      return 'active_tool';
    }
  }
  if (candidate.hasProcessSessionId) return 'process_session_id';
  if (candidate.hasStatusSignal) return 'status_map';
  return null;
}
```

Pass `now` from `allocateOpenCodeLiveness` (already has it as a parameter):

```typescript
for (const candidate of candidates) {
  const reason = directReason(candidate, now);  // ← was just (candidate)
  ...
}
```

### Step 3: One-time archive of known stuck sessions

Run this SQL on the opencode database to archive the 5 visible stuck sessions
(plus any others) so they disappear immediately regardless of the code fix:

```sql
UPDATE session SET time_archived = 1782493267000
WHERE id IN (
  'ses_104c2e528ffe0Fcg6w2DRPnZqF',
  'ses_104cbec86ffe1bGBCv70Ye5Oyq',
  'ses_109d33162ffeMhM1J0vZ4VqIin',
  'ses_10ee92106ffe5oCIKf6D4SttKQ',
  'ses_12711255effeIpai31U4Rnrefp'
);
```

These 5 are the only stuck sessions within the SQL query's LIMIT 200. After
archiving, the dashboard query (`WHERE time_archived IS NULL`) will skip them.

### Step 4: Investigate "Modify vLLM PR" session if it persists

If after Steps 1-3 the "Modify vLLM PR" session still shows as "Working", add
debug logging to `getSessionsViaSQLite` to capture the inferred status and
liveness decision for this specific session. The session ID is
`ses_1f750b19dffeQfAVShN1uCS1wO`. Temporarily add:

```typescript
if (session.id === 'ses_1f750b19dffeQfAVShN1uCS1wO') {
  console.log('DEBUG session:', {
    status, phase, lastActivity, lastActivityMs,
    latestTool, latestStepReason, visibilityReason, livenessReason
  });
}
```

This will reveal exactly why the session passes through the filter.

## Validation Plan

1. **TypeScript check**: `npm run check` — must pass with no new errors.

2. **Build**: `npm run build` — must produce a working production bundle.

3. **Restart**: `./restart_dashboard.sh` — must restart the container cleanly.

4. **Dashboard inspection** (after restart + SQL archive):
   - The 4 "Blocked (awaiting review)" sessions from June 22-24 must be gone.
   - The "Modify vLLM PR" session should no longer appear.
   - Any genuinely active opencode TUI sessions (currently running instances)
     should appear with correct status.
   - The `opencode serve` process should NOT appear as a session (it has no
     session ID).

5. **Process scan verification**: From inside the container, verify that
   running opencode TUI instances are detected:
   ```
   podman exec ai-agent-dashboard node -e "
     const { scanProcesses } = require('./build/lib/process/poller.js');
     console.log(JSON.stringify(scanProcesses(), null, 2));
   "
   ```
   Expected: live TUIs appear with their session IDs extracted.

6. **API confirmation**: Verify `/session/status` returns `{}` (confirming no
   sessions are active from the API's perspective — the dashboard's process
   scan will independently detect live sessions).

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `bwrap` detection misidentifies non-opencode processes that happen to have `opencode` in their args after `--` | Low — `isOpenCodeExecutable` checks `basename(arg) === 'opencode'`, which is very specific | No false positives expected; opencode binary is the only file named `opencode` in the PATH. |
| A genuinely blocked session (active Plannotator review) has lastActivity > 30 min and briefly disappears | Very low — if the process is alive it produces parts or updates. Plannotator reviews resolve in <5 min. | The process scan fixes this too: a live TUI process will have `hasProcessSessionId = true`, keeping the session visible regardless of tool staleness. |
| Arg parsing performance impact from scanning 120+ bwrap args every 500ms | Negligible — `indexOf` and a short loop over ~120 strings is sub-microsecond. | No mitigation needed. |
| The "Modify vLLM PR" session root cause remains unknown | Medium | Step 4 adds targeted debug logging if it persists. The session's parts show no active tool, so both the staleness bound AND the process fix should hide it. |

## Open Questions

- Should we also archive the remaining 10 stuck sessions (ranks 292-1101) that
  are outside the LIMIT 200? Not strictly necessary but good hygiene.
- Could the `bwrap` args structure change between versions? The `--` separator
  convention is standard for bwrap and unlikely to change.