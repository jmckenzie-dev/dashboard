# Fix: Errored sessions resurrected by `cwd_allocated` / `recent_active_fallback` liveness

## Problem

An errored opencode session stays visible indefinitely as `❌ Error` even
when no TUI is linked to it, because the liveness allocator awards
directory-proximity slots (`cwd_allocated`) to dead error sessions.

Concretely (live repro): session `ses_0e11728adffeqWp02SH6fjRN1A` ("Debug
q36d qwen3.6-27b") shows `instanceAlive: true, livenessReason:
'cwd_allocated'` while every direct liveness signal is false
(`hasStatusSignal`, `hasBlockingRequest`, `hasActiveTool`,
`hasProcessSessionId` all `false`). A different opencode TUI running in
the same directory without a `-s` flag leaves an unallocated slot that
falls to this errored session by recency. See
`.debug/error-session-cwd-allocated-stuck-2026-07-02.md`.

This is an uncovered variant of the bug class addressed in
`.plans/fix-stuck-error-session-after-new.md` (which fixed the direct
`process_session_id` path only).

## Goal

Terminal `error`-status sessions must NOT be kept visible by weak/allocated
liveness signals (`cwd_allocated`, `recent_active_fallback`). They should
decay to `hidden_stale` and be filtered out, exactly like dead idle
sessions.

Direct liveness signals (`blocking_request`, `active_tool`,
`process_session_id`, `status_map`) remain unchanged — they are already
structurally impossible for a true terminal error (tool not active, no
blocking request, absent from status map), so no suppression is needed
there. But we will NOT suppress them either, to keep behavior
conservative: if a future opencode version ever reports an error tool as
still active, we keep it visible.

## Changes

### 1. Thread error status into the liveness candidate

**File:** `src/lib/agents/opencode-liveness.ts`

Add a `status: AgentStatus` field to `OpenCodeLivenessCandidate` (L16-25):

```typescript
import type { AgentStatus } from './types';

export interface OpenCodeLivenessCandidate {
  id: string;
  parentId?: string | null;
  directory?: string;
  lastActivity: Date;
  hasStatusSignal: boolean;
  hasBlockingRequest: boolean;
  hasActiveTool: boolean;
  hasProcessSessionId: boolean;
  status: AgentStatus;            // NEW
}
```

In `allocateOpenCodeLiveness` (L71), skip error-status candidates in the
two weak-allocation loops:

- **`cwd_allocated` loop (L101-123):** add `&& candidate.status !== 'error'`
  to the `allocatable` filter predicate.
- **`recent_active_fallback` loop (L125-140):** add an early
  `if (candidate.status === 'error') { ...hidden_stale...; continue; }`.

Error candidates still fall through to the final `hidden_stale` assignment.

Add a doc comment explaining: *Errors are terminal. A dead error session
must not be resurrected by directory proximity (cwd_allocated) or a brief
recent-activity window (recent_active_fallback), because neither proves an
instance is bound to this session. Direct signals (process_session_id,
status_map, active_tool, blocking_request) remain authoritative when
present.*

### 2. Populate the new field at every candidate construction site

**File:** `src/lib/agents/opencode.ts`

Three candidate constructors exist (per the earlier grep):
- L871-880 (API status-first path)
- L1057-1060 (SQLite path)
- L1230-1233 (SQLite live-supplement path)

Each builds a `livenessCandidate` object from local vars where `status`
is already in scope (the inferred `AgentStatus`). Add `status,` to each.

Also propagate to the diagnostic capture blocks (L911-914, L1094-1097,
L1266-1269) so `npm run dump:sessions` and `/api/status/diagnose` report
the candidate status for future debugging. Add a `status:
livenessCandidate.status` line to each `livenessCandidate:` snapshot.

### 3. Add a focused unit test

**File:** `src/lib/status/opencode-liveness.test.ts` (new — compile-and-run
under plain node, matching the pattern in `src/lib/status/inference.ts`
header comment, since no test runner is configured per AGENTS.md)

Cover:
- Error-status candidate in a directory with an allocation slot →
  decision is `hidden_stale` (NOT `cwd_allocated`).
- Error-status candidate with very recent activity → decision is
  `hidden_stale` (NOT `recent_active_fallback`).
- Error-status candidate with a real direct signal (`hasProcessSessionId`)
  → still gets `process_session_id` (conservative: we do not suppress
  direct signals).
- Non-error idle candidate in the same directory → still gets
  `cwd_allocated` (regression guard: only error sessions are excluded).

### 4. Docs touch

**File:** `AGENTS.md` → "Debugging Session Status" section

Add a note that `cwd_allocated` no longer applies to `error`-status
sessions, so the "Common finding" guidance (submit_plan error latch) now
also covers the cwd_allocated resurrection path. Keep the existing
guidance intact.

## Validation

1. `npm run check` and `npm run build` — expect zero errors.
2. `node` the new self-contained test module — expect all cases pass.
3. Reproduce locally: with the separate vllm_nightly_wheel TUI still
   running, `npm run dump:sessions -- --json` and confirm the qwen3.6
   session now reports `visibilityReason: 'hidden_stale'`,
   `instanceAlive: null`, and is filtered from the default (non-hidden)
   dump.
4. Regression: run dump with `--no-hidden` and confirm working/idle
   sessions in shared directories are unaffected.
5. Restart dashboard (`./restart_dashboard.sh`) and confirm the session
   no longer appears in the UI status list.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A legitimately-alive session briefly reports error status and gets hidden | Low | User misses a transient error flash | Direct signals still override; once opencode clears the error (new turn), status flips and session reappears. Hysteresis layer (`computeVisibleSessions`) already smooths brief hidden gaps. |
| Suppression too broad if we also gate direct signals | N/A | N/A | We deliberately do NOT gate `process_session_id`/`status_map`/`active_tool`/`blocking_request` — only the two weak/allocated paths. |
| Test infra: no test runner configured | Low | Manual node run | Follow the `inference.ts` self-contained compile pattern; document the run command in the test file header. |

## Out of scope

- Adding an age cutoff to the `error` status latch itself in
  `inference.ts` (separate concern; the `cwd_allocated` fix resolves the
  reported symptom without touching status semantics).
- Changing `getDirectoryAllocationCounts` to subtract processes without a
  `-s` flag (would also fix this symptom but changes slot accounting for
  all sessions, broader blast radius — defer).
