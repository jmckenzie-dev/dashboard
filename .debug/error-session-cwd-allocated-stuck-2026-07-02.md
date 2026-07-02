# Debug: Errored qwen3.6 session stuck visible via `cwd_allocated`

**Date:** 2026-07-02
**Session:** `opencode-ses_0e11728adffeqWp02SH6fjRN1A`
        "Debug q36d qwen3.6-27b run failure in vllm"
**Directory:** `/home/jmckenzie/src/ai/inference/vllm/vllm_nightly_wheel`
**Symptom:** Session shows as `❌ Error` / active in dashboard ~5h after the
agent died, with no opencode TUI linked to it.

## Evidence chain (from `npm run dump:sessions -- --json`)

Per-session diagnostic for the stuck session:

```jsonc
{
  "status": "error",
  "phase": "blocked",
  "visible": true,
  "instanceAlive": true,
  "livenessReason": "cwd_allocated",      // <-- the smoking gun
  "visibilityReason": "cwd_allocated",
  "lastActivityAgeMs": 19498628,          // ~5.4 hours ago
  "diagnostic": {
    "sessionStatus": null,
    "hasActiveInstance": false,           // no live instance claims it
    "latestTool": {
      "tool": "submit_plan",
      "status": "error",                  // terminalized by escaping plan prompt
      "active": false
    },
    "hasError": true,
    "livenessCandidate": {
      "hasStatusSignal": false,           // not in /session/status
      "hasBlockingRequest": false,        // no perm/question pending
      "hasActiveTool": false,             // tool is terminal, not in flight
      "hasProcessSessionId": false        // no live process -s matches it
    }
  }
}
```

ALL four direct liveness signals are `false`. Yet `instanceAlive: true`.

## Root cause

Two independent design gaps compound:

### 1. Error status latched forever (status layer)

`src/lib/status/inference.ts`:
- L125: `const hasError = latestTool?.status === 'error';`
- L178: `if (hasError) return 'error';`

Unlike `blocked_review` (96h cutoff), `complete` (5-min fresh window), or
`working` (10s grace), the `error` branch has **no age/staleness cutoff**. An
`error` tool part is latched indefinitely. Here the latest tool is
`submit_plan` terminalized to `error` (user escaped the plan prompt), so
`hasError` is true forever.

This matches the "Common finding" in AGENTS.md.

### 2. `cwd_allocated` liveness resurrects dead error sessions (visibility layer)

`src/lib/agents/opencode-liveness.ts:101-123` allocates directory liveness
slots to the N most-recently-active root sessions in a directory. It filters
only on `directory`, `parentId`, and "not already directly live." It has
**no awareness of `error` status** — `OpenCodeLivenessCandidate`
(opencode-liveness.ts:16-25) carries no `hasError`/`status` field, and the
candidate construction in opencode.ts:871-880 never populates one.

A **separate** opencode TUI is running in the same directory:

```
PID 2193281: /home/jmckenzie/.opencode/bin/opencode
  (bwrap PID 2193270 binds --bind /home/jmckenzie/src/ai/inference/vllm/vllm_nightly_wheel)
  cmdline has NO `-s` flag → no sessionId
```

In `getDirectoryAllocationCounts` (opencode.ts:645-657):

```typescript
const counts = { ...processScan.directoryProcessCounts }; // vllm_nightly_wheel = 1
for (const process of processScan.processes) {
  if (!process.cwd || !process.sessionId) continue;        // PID 2193281 skipped
  counts[process.cwd] = Math.max((counts[process.cwd] ?? 0) - 1, 0);
}
```

Because the live instance has no `-s` flag, the slot is **not subtracted**,
leaving `counts[vllm_nightly_wheel] = 1`. That slot is then awarded to the
most-recently-active root session in the directory — the errored qwen3.6
session (5h ago beats the other idle sessions which are 8+ days old).

### Visibility gate confirms

`isVisibleOpenCodeSession` (index.ts:28-42): any non-`hidden_stale` reason
returns true. `error` status is never inspected here. So `cwd_allocated` →
visible.

## Why the prior fix didn't catch this

`.plans/fix-stuck-error-session-after-new.md` fixed the **direct**
`process_session_id` signal path (the `/new` scenario where the old session's
id lingers in argv). That fix added the `directoriesWithStatusSignal` guard
in `directReason` (opencode-liveness.ts:46-69).

But that plan's "Why this works" section explicitly hand-waved the
`cwd_allocated` path:

> It may still get `cwd_allocated` if directory slots remain, but the
> subtraction logic in `getDirectoryAllocationCounts` typically leaves zero
> slots for a single-process directory.

That assumption fails here: the live instance has **no `-s` flag**, so it
isn't subtracted, leaving a phantom slot. This is a distinct variant of the
same bug class — indirect/allocated liveness on an errored session — that
the prior fix's "Open Questions" #1 explicitly flagged but did not resolve.

## Answers to the user's questions

**Q: Why is it still showing active?**
`cwd_allocated` liveness: a different opencode TUI runs in the same
directory without a `-s` flag, leaving an unallocated directory slot that
gets handed to the most-recently-active (but dead, errored) root session.

**Q: What's our logic around pruning "Error" sessions?**
There is none. Errors are latched forever in status inference, and error
sessions are fully eligible for every liveness signal including
`cwd_allocated` and `recent_active_fallback`. The only "prune" is
`hidden_stale`, which requires NO liveness signal AND age > 30s — but
`cwd_allocated` counts as a liveness signal.

**Q: Shouldn't it be purged since no TUI is linked?**
Yes. The user is correct. The session has all four direct signals false;
the only thing keeping it visible is the weak `cwd_allocated` heuristic
matching on a shared directory. Errors are terminal — a dead error session
should not be resurrected as "alive" by directory proximity.

## Proposed fix direction

Make `error`-status sessions ineligible for allocated/weak liveness
(`cwd_allocated`, `recent_active_fallback`), so they fall through to
`hidden_stale`. Direct liveness (`blocking_request`, `active_tool`,
`process_session_id`, `status_map`) is already impossible for a true
terminal error (tool is not active, no blocking req, not in status map).

Concretely: add `status: AgentStatus` (or `hasError: boolean`) to
`OpenCodeLivenessCandidate`, populate it at candidate construction, and
skip error-status candidates in the `cwd_allocated` and
`recent_active_fallback` loops in `allocateOpenCodeLiveness`.
