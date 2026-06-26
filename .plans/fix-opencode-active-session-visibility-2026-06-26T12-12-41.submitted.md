---
submitted-at: "2026-06-26T12:12:41.516Z"
title: "Fix OpenCode Active Session Visibility"
auto-captured: true
---
# Fix OpenCode Active Session Visibility

## Goal
Goal: Make the dashboard show only currently open/active OpenCode sessions and stop active sessions from flickering to `Idle` during reasoning/tool-call handoffs.

## Current State
- The existing plan in `.plans/resolve-container-proc-cwd-access.md` focuses on `/proc/<pid>/cwd` access from the container, but that is not sufficient by itself: a single readable live cwd currently causes multiple old sessions in the same directory to be treated as live.
- Live diagnosis at `GET /api/status/diagnose` showed 8 visible OpenCode sessions: 3 stale `error` sessions from 15-17h ago, 3 stale `idle` sessions, 1 `blocked_review`, and 1 `working`. The stale sessions all share `/home/jmckenzie/src/ai/benchmarking/accuracy/wt_add_aider` and have `instanceAlive: true`.
- `src/lib/agents/opencode.ts:420-433` treats any matching live directory as proof that every session in that directory is alive.
- `src/lib/agents/index.ts:158-172` then keeps every `instanceAlive === true` session visible regardless of age/status, so old idle/error sessions bypass the normal recency windows.
- `src/lib/agents/opencode.ts:363-367` and `src/lib/agents/opencode.ts:383-418` treat a reachable serve instance’s `/session` roster as session liveness. That endpoint is a DB-backed roster, not proof a session is actively open.
- `src/lib/agents/opencode.ts:42-48` and `src/lib/agents/opencode.ts:601-613` ignore `part.time_updated`, so streaming reasoning/text/tool updates can look stale even while the active row is being updated.
- `src/lib/status/inference.ts:194-201` only keeps ambiguous activity as `working` for `WORKING_GRACE_MS`; it does not explicitly model recent `step-finish reason="tool-calls"` as a handoff state.
- `src/lib/process/poller.ts:31-45` silently maps `/proc/<pid>/cwd` failures to `null`, making container/user-namespace failures hard to distinguish from processes with no useful cwd.

## Assumptions
- “Actively open in OpenCode” means a session has a direct live signal (`/session/status`, live permission/question request, process argv session id, active durable tool) or is selected as the most likely live session for a cwd-backed OpenCode process.
- A cwd-only process can identify a directory, not an exact session. For that weak signal, select only the newest sessions up to the number of live processes observed for that directory.
- Old `idle`, `complete`, and `error` OpenCode sessions should not remain visible solely because another session in the same directory is currently open.
- If the backing OpenCode TUI instance is closed, its session should not show on the dashboard. This includes just-completed sessions unless the TUI is still live/directly attributable.
- `blocked_review` remains the correct status for an active `submit_plan`/`plan_exit` review; it should not decay to `idle` while the tool remains running.

## Decision
- Implement the software fix first. Do not rely on container namespace changes as the primary fix because better `/proc/<pid>/cwd` access would still only produce directory-level evidence and would still resurrect every old session in that directory under the current code.
- Keep container/user-namespace changes as a follow-up only if diagnostics still show active idle sessions with no cwd/direct signal after the liveness semantics are corrected.

## Recommended Plan
1. Replace blanket directory liveness with explicit liveness reasons.
   - Touch points: `src/lib/process/poller.ts`, `src/lib/agents/opencode.ts`, `src/lib/agents/types.ts` if a public diagnostic field is needed.
   - Extend process scan output to include per-directory process counts, direct session ids parsed from argv wherever they appear, and cwd read diagnostics (`permission denied`, missing `/proc`, timeout, etc.).
   - Stop using `/session` roster responses as positive liveness. Keep `/session/status`, live permission/question requests, process session ids, and active durable tools as direct signals.
   - Treat `/path` and process cwd matches as weak directory signals, not proof for every session in that directory.

2. Allocate weak cwd liveness after sessions are parsed.
   - Touch points: `src/lib/agents/opencode.ts`; optionally add a small pure helper module such as `src/lib/agents/opencode-liveness.ts` for testability.
   - Build SQLite/API session candidates first with `lastActivity`, `status`, `directory`, and direct-signal flags.
   - For each directory with `N` cwd-backed OpenCode processes and no exact session id, mark only the `N` newest root sessions in that directory as cwd-live.
   - Direct session-id/status/blocking/tool signals always override cwd allocation.
   - Add an internal `livenessReason`/`visibilityReason` value for diagnostics, e.g. `status_map`, `blocking_request`, `active_tool`, `process_session_id`, `cwd_allocated`, `recent_active_fallback`, `hidden_stale`.

3. Tighten OpenCode visibility filtering.
   - Touch point: `src/lib/agents/index.ts`.
   - For OpenCode sessions, keep only:
     - direct-live sessions;
     - cwd-allocated sessions;
     - sessions with active durable work/blocking signals;
     - very recent activity fallback for cwd-inaccessible sessions only while they still have active work/blocking evidence.
   - Hide OpenCode sessions whose TUI has closed, including `idle`, `complete`, and `error` sessions; do not keep them purely via broad recency/error windows.
   - Preserve existing generic-agent behavior for Claude/Codex/Gemini unless explicitly changing those adapters.

4. Fix activity ordering and handoff status inference.
   - Touch points: `src/lib/agents/opencode.ts`, `src/lib/status/inference.ts`, `scripts/test-status-inference.mjs`.
   - Add `time_updated` to `OpenCodePartRow` and SQLite queries.
   - Use `max(time_created, time_updated)` for status ordering and `lastActivity` so streaming reasoning/text/tool rows stay fresh.
   - Order parts deterministically with `ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC`.
   - Add inference coverage for recent `step-finish reason="tool-calls"` / active handoff states so active sessions do not fall through to `idle` between model completion and tool execution.
   - Keep stale historical running tools inactive when a later terminal part or natural stop exists.

5. Improve diagnostics for this class of bug.
   - Touch point: `src/routes/api/status/diagnose/+server.ts`.
   - Preserve unknown liveness as `null` instead of coercing it to `false`.
   - Include `livenessReason`, `visibilityReason`, per-directory process counts, and cwd read errors.
   - Ensure the diagnostic endpoint can explain why each visible session is visible and why stale candidates were hidden.

6. Add regression/property checks.
   - Touch points: `scripts/test-status-inference.mjs`, `scripts/property-test-agents-api.mjs`, new `scripts/test-opencode-liveness.mjs` if a pure helper is added, `run_tests.sh`.
   - Add deterministic fixtures for:
     - a long-running `submit_plan` staying `blocked_review`;
     - recent reasoning/text updates using `time_updated` staying active;
     - recent `tool-calls` handoff staying `working` briefly;
     - stale same-directory `error`/`idle` sessions being hidden while the newest same-directory session remains visible.
   - Add property checks that cwd allocation never marks more sessions live than observed cwd-backed process count and always prefers newest sessions unless a direct session signal exists.
   - Update `scripts/property-test-agents-api.mjs` to include `error` in the accepted status set.

7. Restart and verify against the live dashboard.
   - Run the validation commands below.
   - Run `./restart_dashboard.sh` after implementation, per repository workflow.
   - Re-check `GET /api/status/diagnose` and the UI.

## Validation Plan
- Static/build checks:
  - `npm run check` passes.
  - `npm run build` passes.
- Regression checks:
  - `node scripts/test-status-inference.mjs` passes with the new `time_updated` and `tool-calls` fixtures.
  - `node scripts/test-opencode-liveness.mjs` passes if added.
  - `node scripts/property-test-agents-api.mjs` passes against the running dashboard.
  - `./run_tests.sh` passes end-to-end.
- Runtime checks after `./restart_dashboard.sh`:
  - `GET /api/status/diagnose` no longer lists the 15-17h stale `error` sessions after their backing TUI instances are closed.
  - `GET /api/status/diagnose` no longer lists the 6/24 stale `idle` sessions after their backing TUI instances are closed or solely because another process shares their directory.
  - Just-completed OpenCode sessions disappear once their backing TUI closes; they remain visible only while direct/cwd liveness still identifies the open TUI.
  - The active `Aider benchmark*` session remains `working` or `blocked_review` as appropriate and does not flicker to `idle` during reasoning/tool handoffs across at least 5 polling intervals.
  - Diagnostics show cwd access failures explicitly instead of silently reporting `cwd: null`.

## Risks and Mitigations
- Multiple open idle OpenCode sessions in the same directory cannot be perfectly identified from cwd alone. Mitigation: allocate up to the observed process count and prefer direct session-id/status signals when available.
- Container `/proc/<pid>/cwd` access may remain unavailable for some host processes. Mitigation: preserve recent active fallback, expose cwd errors, and only revisit `UserNS=keep-id`/`CAP_SYS_PTRACE` after code-level liveness semantics are fixed.
- Over-tight filtering could hide an open but completely idle session with no direct signal and no readable cwd. Mitigation: make visibility reasons diagnostic; if this occurs, fix process/cwd attribution rather than keeping closed sessions visible by age.
- Too-long handoff grace can resurrect stale sessions. Mitigation: use `time_updated`, keep the grace short, and require either recency or liveness for handoff-based `working`.

## Finalized Decisions
- Closed OpenCode TUI means hidden from the dashboard. Period.
- For multiple idle sessions in the same directory, use newest-N cwd allocation based on observed process count.
- Plan artifact: `.plans/fix-opencode-active-session-visibility.md`.