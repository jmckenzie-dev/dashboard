---
submitted-at: "2026-07-01T18:56:58.827Z"
title: "API-First OpenCode Status Hybrid"
auto-captured: true
---
# API-First OpenCode Status Hybrid

## Goal
- Goal: Replace broad per-tick SQLite status inference with an API-first status path, using SQLite only as narrow enrichment for non-API actionable states.

## Current State
- OpenCode API status provides only `idle`, `busy`, and `retry` per session.
- OpenCode API permission/question endpoints provide the two live request types that clearly require user action.
- `/session/status` does **not** expose `error` or `complete`; those are not API-native states. Tool errors currently come from SQLite part JSON, while `complete` is purely dashboard-derived from `step-finish reason=stop`.
- SQLite currently adds `blocked_review`, `error`, UI phase, recent messages, and fallback inference when the API is incomplete or unavailable.
- Current optimized SQLite polling is much faster than before, but still costs tens of milliseconds per snapshot.

## Assumptions
- The dashboard's primary job is to show whether a session needs attention or is actively working.
- `busy` without `/permission` or `/question` is sufficient for normal working status.
- `blocked_review` remains important because `submit_plan`/`plan_exit` requires human attention and is not represented by `/permission` or `/question`.
- `error` should remain top-level because it may require human intervention.
- `complete` should be removed entirely; `idle` is sufficient to mean the agent is no longer working.

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
3. Preserve non-API actionable states with narrow SQLite enrichment only for sessions that need it:
   - `busy` sessions with no permission/question request,
   - sessions whose API metadata `time_updated` advanced since the previous snapshot,
   - live/visible sessions without enough cached enrichment state.
4. For each enriched session, query a tiny recent tool/step context window:
   - if active latest tool is `submit_plan` or `plan_exit`, mark `blocked_review`,
   - if latest relevant tool state is `error`, mark top-level `error`,
   - otherwise keep the API-derived status.
5. Stop deriving normal working phase from SQLite parts:
   - drop reasoning/generating/using-tool phase as a status input,
   - optionally keep UI phase as `blocked`/`idle`/generic `working` only.
6. Remove dashboard `complete` from normal status inference:
   - if API status is `idle`, display `idle`,
   - keep the session visible while process/API liveness says it is live,
   - hide/close it out when liveness expires or OpenCode no longer reports it.
7. Keep SQLite fallback for degraded cases only:
   - API unavailable,
   - diagnostics endpoint,
   - expanded session details,
   - periodic low-frequency sanity refresh if desired.
8. Add metrics to prove the behavior:
   - API-first snapshots,
   - review/error enrichment SQLite queries,
   - SQLite fallback snapshots,
   - sessions skipped because API-only status was sufficient.

## What We Lose
- Fine-grained phase labels such as reasoning, generating, and using tool.
- `complete` as a distinct status; `idle` becomes the terminal non-working state.
- Rich recent-message context for summaries on every tick; messages should be lazily hydrated or summarized only for visible/expanded/active sessions.
- Better behavior when the OpenCode API is down; this requires explicit SQLite fallback rather than being part of the normal path.

## What We Keep
- Permission and question blocking from authoritative live API endpoints.
- Busy/retry/idle from `/session/status`.
- Process/PID/cwd liveness for visibility decisions.
- `blocked_review` via tiny targeted SQLite checks for busy sessions.
- Top-level `error` via tiny targeted SQLite checks for changed/live sessions.
- Diagnostic access to full SQLite-derived details when explicitly requested.

## Validation Plan
- Run `npm run check`.
- Run `npm run build`.
- Run `./run_tests.sh`.
- Add tests for API-only status priority, review enrichment, error enrichment, removal of complete, API-down fallback, and no-SQLite quiet ticks.
- Restart with `./restart_dashboard.sh`.
- Compare metrics and CPU over at least 60 seconds with two SSE clients.

## Risks and Mitigations
- Risk: `submit_plan` appears as `working` if enrichment misses it.
  Mitigation: targeted busy-session enrichment and tests for active `submit_plan`/`plan_exit` parts.
- Risk: true tool errors are missed if enrichment is too narrow.
  Mitigation: enrich sessions whose API `time_updated` changed, plus live/busy sessions, and retain previous top-level error until newer session activity.
- Risk: users miss the old `complete` signal.
  Mitigation: simplify the model intentionally: `idle` means no longer working, and liveness/visibility determines whether the card remains shown.
- Risk: API outage hides sessions.
  Mitigation: retain existing SQLite path as fallback when API is unavailable.

## Open Questions
- How small should the review/error enrichment window be: latest 8, 12, or 20 tool/step parts?