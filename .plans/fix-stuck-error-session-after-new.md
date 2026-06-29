# Fix: Defunct Error-Status Session Stuck Visible After `/new`

## Goal

Prevent an errored session that has been superseded by an opencode `/new`
session (same process, new session ID) from remaining stuck in the dashboard
with `❌ Error` status.

## Current State

### Session lifecycle & PID logic

Sessions are identified by their DB row ID (raw, e.g. `ses_abc123`). The
dashboard wraps them as `opencode-${id}`. The `AgentSession.pid` field is
**never set** in the opencode agent path — it is `undefined` for every opencode
session. There is no explicit dedup or replacement detection logic.

### Liveness pipeline

1. **`scanProcesses()`** (`src/lib/process/poller.ts:195`) — enumerates every
   running `opencode` process via `ps -eo pid,args`, parses the `-s` session-id
   flag from argv, and resolves the process cwd via `/proc/<pid>/cwd`. Outputs
   `directSessionIds` (from `-s` flags), `liveDirectories` (cwd values), and
   `directoryProcessCounts`.

2. **`getInstanceLiveness()`** (`src/lib/agents/opencode.ts:355`) — builds an
   `InstanceLiveness` object combining the process scan with the `GET /path`
   API result.

3. **`allocateOpenCodeLiveness()`** (`src/lib/agents/opencode-liveness.ts:48`)
   — for each session candidate, assigns a `(livenessReason, visibilityReason,
   instanceAlive?)` decision. Priority order in `directReason` (line 33):

       1. `blocking_request` — pending permission/question
       2. `active_tool` — running tool part, ≤30 min old
       3. `process_session_id` — process `-s` flag matches this session ID
       4. `status_map` — session ID present in `/session/status` (busy/retry)

   Sessions without any direct signal may still get `cwd_allocated` (directory
   match with available slots) or `recent_active_fallback` (≤30s window).
   Everything else gets `hidden_stale`.

4. **`applyLivenessDecisions()`** (`src/lib/agents/opencode.ts:389`) — merges
   decisions onto session objects. Hidden sessions are filtered out by
   `sessions.filter(s => s.visibilityReason !== 'hidden_stale')`.

5. **`isVisibleOpenCodeSession()`** (`src/lib/agents/index.ts:21`) — final
   visibility gate. `error` status alone is NOT a visibility signal here
   (unlike `isVisibleGenericSession` which does check error + 2h window).

### The bug scenario

1. Session A (`ses_abc123`, title "Integrate HumanEval benchmark setup") hits a
   tool error → dashboard infers `status: 'error'`.
2. User runs `/new` inside opencode → session B (`ses_def456`, title "Build:
   Integrate HumanEval Benchmark") is created. **Same process, same PID.**
3. The process argv still has `-s ses_abc123` — Linux does not update argv
   after `exec()`. The dashboard's `scanProcesses()` therefore puts
   `"ses_abc123"` in `directSessionIds`.
4. Session A gains `hasProcessSessionId: true` → `directReason` returns
   `'process_session_id'` → `instanceAlive: true` → visible despite error
   status.
5. Session B may also be visible (via `status_map` from `/session/status`), but
   Session A never decays to `hidden_stale` because `process_session_id` is
   checked unconditionally regardless of whether the process has moved on.

### Root cause

**`process_session_id` is treated as an unconditional liveness signal.**
Because argv is immutable after process start, a session ID lingering in
`/proc/<pid>/cmdline` is NOT proof that the process still considers that
session active. When `/session/status` confirms a *different* session is now
busy in the same directory, the old session's `process_session_id` signal is
stale.

### Why title does not matter directly

The session title is purely decorative — it appears in the `AgentSession.name`
field but is never used in liveness, matching, or dedup logic. The user's
intuition about "title interaction" is actually about a *different* session
existing with a new title, which the code should use as evidence of replacement
but currently does not.

## Assumptions

- The opencode process does not update its own argv after `exec()`.
- `/session/status` correctly reflects which session the process considers
  active (busy/retry entries only).
- Both the old (errored) and new (post-`/new`) sessions share the same
  `directory` value.
- The dashboard reads from SQLite (primary path) rather than the API for the
  full session roster.

## Recommended Plan

### Step 1: Detect replaced sessions in `allocateOpenCodeLiveness`

**File:** `src/lib/agents/opencode-liveness.ts`

Modify `allocateOpenCodeLiveness()` to compute the set of directories that
contain at least one session with `hasStatusSignal === true`. Then, in
`directReason()`, when a candidate would receive `'process_session_id'`, first
check whether that candidate's directory already has a different session with
`hasStatusSignal`. If so, the `process_session_id` signal is stale — do not
return it.

Concretely:

```typescript
// Before directReason loop, compute:
const directoriesWithStatusSignal = new Set<string>();
for (const candidate of candidates) {
  if (candidate.hasStatusSignal && candidate.directory) {
    directoriesWithStatusSignal.add(candidate.directory);
  }
}
```

Change `directReason` to accept an additional parameter and add the guard:

```typescript
function directReason(
  candidate: OpenCodeLivenessCandidate,
  now: number,
  directoriesWithStatusSignal: Set<string>,
): OpenCodeSessionReason | null {
  // ... blocking_request, active_tool unchanged ...

  if (candidate.hasProcessSessionId) {
    // If this directory already has a session confirmed alive via
    // /session/status, the process_session_id signal is stale (the
    // process's argv still references an old session ID after /new).
    if (!candidate.directory || !directoriesWithStatusSignal.has(candidate.directory)) {
      return 'process_session_id';
    }
    // Fall through: the candidate can still get liveness via
    // status_map (if it has one) or cwd_allocated / fallback.
  }

  if (candidate.hasStatusSignal) return 'status_map';
  return null;
}
```

**Why this works:** When session A (errored, no status signal) and session B
(busy, in `/session/status`) share a directory, `directoriesWithStatusSignal`
contains that directory. Session A's `process_session_id` is suppressed. Session
A then falls through: no `status_map` (absent from API), so `directReason`
returns `null`. It may still get `cwd_allocated` if directory slots remain, but
the subtraction logic in `getDirectoryAllocationCounts` typically leaves zero
slots for a single-process directory. Fallback → `hidden_stale`. Session A is
filtered out.

Session B retains `status_map` liveness (unchanged).

### Step 2: (Defensive) Add `process_session_id` suppression documentation

**File:** `src/lib/agents/opencode-liveness.ts`

Add a comment block above `directReason` explaining the `process_session_id`
staleness guard and the scenario it fixes:

```typescript
/**
 * Determine whether a candidate has a direct (non-allocated) liveness signal.
 *
 * Signals are checked in descending reliability order. The `process_session_id`
 * signal (process argv `-s` flag) is suppressed when the candidate's directory
 * already has a different session confirmed alive by `/session/status`
 * (`status_map`). Rationale: opencode `/new` creates a new session ID but the
 * process argv is immutable on Linux — the old session ID lingers in
 * /proc/<pid>/cmdline even though the process has moved on.
 *
 * Without this guard, an errored session superseded by `/new` stays visible
 * indefinitely via the stale `process_session_id` signal.
 */
```

### Step 3: Update type signature if needed

If `directReason` is currently a module-private function (it is — no `export`),
its signature change is internal. No external consumers exist. Verify no other
callers reference it.

### No changes needed outside `opencode-liveness.ts`

The fix is entirely contained in the liveness allocation step:
- `isVisibleOpenCodeSession` (visibility gate) is correct — `error` alone is
  not a visibility signal.
- `isVisibleGenericSession` is not relevant (opencode-only scenario).
- `applyLivenessDecisions` requires no change.
- Frontend (`+page.svelte`, `+page.server.ts`, `events/+server.ts`) requires
  no change.

## Validation Plan

### 1. Compile & type-check

```bash
npm run check
npm run build
```

Expect: zero errors.

### 2. Manual verification via diagnose API

Open the diagnose endpoint (`/api/status/diagnose`) after reproducing the
scenario:

1. Start an opencode session, let it hit an error.
2. Run `/new` inside the same process.
3. Wait one poll cycle (≈config `polling.intervalMs`).
4. Fetch `GET /api/status/diagnose`.

Verify for the errored session (`session.status === 'error'`):
- `visibilityReason` is `'hidden_stale'` (not `'process_session_id'`)
- `instanceAlive` is `null`/`undefined` (not `true`)
- The session appears in `hidden_sessions[]` (or is absent), not in `sessions[]`

Verify for the new session:
- `visibilityReason` is `'status_map'`
- `instanceAlive` is `true`
- The session appears in `sessions[]`

### 3. Regression: normal process-session-id liveness

Ensure a session that is the ONLY session for its directory AND has
`hasProcessSessionId: true` still gets `'process_session_id'` liveness. This
covers the common case where a single session is alive and referenced by a
process.

### 4. Regression: multiple processes in same directory

If two separate opencode processes run in the same directory with different
session IDs, and neither session is in `/session/status`, both should still
receive `'process_session_id'` liveness (the guard only triggers when a
*different* session has `status_map`).

### 5. Regression: API unreachable

When `/session/status` is unreachable (`statusData` is empty), no candidate has
`hasStatusSignal`. `directoriesWithStatusSignal` will be empty, and
`process_session_id` will never be suppressed. All existing behavior is
preserved.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| False positive: legitimate session with `process_session_id` gets suppressed because a transient session (e.g., child) has `status_map` in the same directory | Low | Session is briefly hidden despite being alive | The guard only suppresses when a DIFFERENT session (by id) has `status_map` in the same directory. The suppressed session can still get `cwd_allocated` liveness or `recent_active_fallback`. If it's genuinely active, it will also appear in `/session/status` next poll and get `status_map`. |
| `/session/status` returns stale data for a session that is no longer active | Low | Might suppress `process_session_id` for a legitimate but absent-from-status session | The guard is conservative — it only fires when AT LEAST one session in the directory has `status_map`. If `status_map` is wrong, the new session is also wrong. |
| Performance: computing `directoriesWithStatusSignal` adds O(n) iteration | None | ~500 candidates max, trivial | One extra pass over the candidates array. |

## Open Questions

1. **Should the suppression also apply when the candidate has error status
   specifically?** Current design suppresses `process_session_id` for ANY status
   when a conflicting `status_map` exists, which is more general. If we later
   want to limit it to `error`-status sessions only, add a
   `candidate.status === 'error'` check — but the general version handles
   idle/complete superseded sessions too, which seems desirable.
