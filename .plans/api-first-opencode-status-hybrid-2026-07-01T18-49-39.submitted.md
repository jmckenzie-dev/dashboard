---
submitted-at: "2026-07-01T18:49:39.912Z"
title: "API-First OpenCode Status Hybrid"
auto-captured: true
---
# API-First OpenCode Status Hybrid

## Goal
- Goal: Replace broad per-tick SQLite status inference with an API-first status path, using SQLite only as narrow enrichment for non-API actionable states.

## Current State
- OpenCode API status provides only `idle`, `busy`, and `retry` per session.
- OpenCode API permission/question endpoints provide the two live request types that clearly require user action.
- SQLite currently adds `blocked_review`, `error`, `complete`, UI phase, recent messages, and fallback inference when the API is incomplete or unavailable.
- Current optimized SQLite polling is much faster than before, but still costs tens of milliseconds per snapshot.

## Assumptions
- The dashboard's primary job is to show whether a session needs attention or is actively working.
- `busy` without `/permission` or `/question` is sufficient for normal working status.
- `blocked_review` remains important because `submit_plan`/`plan_exit` requires human attention and is not represented by `/permission` or `/question`.
- It is acceptable to replace SQLite-derived `complete` with an in-memory transition-derived `complete` if needed.

## Recommended Plan
1. Make the normal status path API-first:
   - `/session` for session metadata,
   - `/session/status` for `idle | busy | retry`,
   - `/permission` for permission blocks,
   - `/question` for question blocks,
   - process scan only for liveness/visibility.
2. Compute core dashboard status from API signals:
   - permission request -> `blocked_permission`,
   - question request -> `blocked_question`,
   - retry -> `retry`,
   - busy -> `working`,
   - otherwise `idle`.
3. Preserve `blocked_review` with a narrow SQLite enrichment only for sessions that are `busy` and have no permission/question request:
   - query the latest small set of tool/step parts for that one session,
   - if active latest tool is `submit_plan` or `plan_exit`, mark `blocked_review`,
   - otherwise keep `working`.
4. Stop deriving normal working phase from SQLite parts:
   - drop reasoning/generating/using-tool phase as a status input,
   - optionally keep UI phase as `blocked`/`idle`/generic `working` only.
5. Replace SQLite-derived `complete` with an in-memory transition rule:
   - if a session transitions from `working`/`retry` to API `idle`, show `complete` for the existing complete freshness window,
   - then decay to `idle`.
6. Treat SQLite-derived `error` as optional diagnostics, not normal dashboard status:
   - do not scan broadly for tool errors per tick,
   - expose detailed error/tool history through diagnose/debug paths or lazy per-session hydration.
7. Keep SQLite fallback for degraded cases only:
   - API unavailable,
   - diagnostics endpoint,
   - expanded session details,
   - periodic low-frequency sanity refresh if desired.
8. Add metrics to prove the behavior:
   - API-first snapshots,
   - review-enrichment SQLite queries,
   - SQLite fallback snapshots,
   - status transition-derived completes.

## What We Lose
- Automatic per-tick detection of latest non-review tool errors as `error`.
- Fine-grained phase labels such as reasoning, generating, and using tool.
- SQLite-derived natural `complete` based on `step-finish reason=stop`; this is replaced by an in-memory working-to-idle transition heuristic.
- Durable fallback detection of `question` tool blocks when `/question` is unavailable, unless included in the same narrow enrichment query.
- Rich recent-message context for summaries on every tick; messages should be lazily hydrated or summarized only for visible/expanded/active sessions.
- Better behavior when the OpenCode API is down; this requires explicit SQLite fallback rather than being part of the normal path.

## What We Keep
- Permission and question blocking from authoritative live API endpoints.
- Busy/retry/idle from `/session/status`.
- Process/PID/cwd liveness for visibility decisions.
- `blocked_review` via tiny targeted SQLite checks for busy sessions.
- Diagnostic access to full SQLite-derived details when explicitly requested.

## Validation Plan
- Run `npm run check`.
- Run `npm run build`.
- Run `./run_tests.sh`.
- Add tests for API-only status priority, review enrichment, transition-derived complete, API-down fallback, and no-SQLite quiet ticks.
- Restart with `./restart_dashboard.sh`.
- Compare metrics and CPU over at least 60 seconds with two SSE clients.

## Risks and Mitigations
- Risk: `submit_plan` appears as `working` if enrichment misses it.
  Mitigation: targeted busy-session enrichment and tests for active `submit_plan`/`plan_exit` parts.
- Risk: true tool errors are less visible.
  Mitigation: surface errors in diagnostics/session detail, not global polling.
- Risk: `complete` heuristic differs from actual OpenCode stop event.
  Mitigation: make it explicitly transition-derived and time-bounded.
- Risk: API outage hides sessions.
  Mitigation: retain existing SQLite path as fallback when API is unavailable.

## Open Questions
- Should `error` remain a top-level status, or move to session detail only?
- Should we include `question` tool fallback in the narrow SQLite enrichment?
- Should `complete` be kept via transition heuristic or removed entirely?