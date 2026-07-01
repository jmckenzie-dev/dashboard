# Incremental OpenCode SQL Plan

## Goal

Goal: Reduce dashboard SQLite polling cost further by fetching only changed
OpenCode rows between snapshots while preserving correct status inference and
visibility behavior.

## Current State

- The dashboard currently fetches root session metadata for up to 200 sessions,
  then fetches up to 80 recent `part` rows for the newest/live subset.
- The remaining measured hot path is the SQLite part query at roughly 70ms per
  snapshot after indexes and query limiting.
- `part` has `time_created` and non-null `time_updated` integer columns; current
  recent rows show millisecond-like values.
- Existing dashboard index `dashboard_part_session_activity_idx` supports
  per-session recent-part lookups, but a global timestamp change-feed query
  should use an activity-leading expression index.
- The dashboard currently relies on the OpenCode API for live-only signals
  (`/session/status`, `/permission`, `/question`, `/path`) and on SQLite for
  broad session/message history. The API can return messages for a specific
  session, but using it for all visible sessions would mean multiple HTTP calls
  per snapshot and would not replace the DB for historical/offline sessions.

## Assumptions

- OpenCode part rows are append-heavy, but existing part rows can receive
  `time_updated` changes.
- Full correctness requires keeping enough recent part context per active
  session because status inference depends on recent tools, terminal tool parts,
  and natural `step-finish` boundaries.
- Occasional full refreshes are acceptable as a safety net.

## Recommended Plan

1. Add an activity-leading index for incremental part scans in `opencode.ts`:
   `dashboard_part_activity_idx` on `COALESCE(time_updated, time_created), id`.
2. Introduce an in-memory per-DB-path snapshot cache containing:
   - latest root session metadata map,
   - per-session recent part ring buffers capped at `PARTS_PER_SESSION_LIMIT`,
   - part id to cached row/update timestamp mapping,
   - high-water cursor `{ activity, id }`,
   - last full refresh timestamp.
3. Keep the current full snapshot query as the bootstrap path and periodic
   safety refresh path, e.g. every 60 seconds or on cache invalidation.
4. On normal ticks, run a small global incremental part query:
   - fetch rows where activity is newer than the high-water cursor,
   - order ascending by activity/id for deterministic cursor advancement,
   - merge changed rows into session buffers by part id,
   - mark affected sessions dirty.
5. Hydrate context only for sessions that need it:
   - if a changed session is missing a buffer, query its latest 80 parts,
   - if a changed row is ambiguous without prior context, query that session's
     latest 80 parts,
   - if a live/API/blocking session is not buffered, query that session's latest
     80 parts,
   - otherwise recompute from the existing ring buffer plus delta rows.
6. Continue refreshing root session metadata cheaply each tick, or incrementalize
   it separately only after the part cache is proven stable.
7. Recompute `parsePartData` only for dirty sessions plus sessions with live API,
   blocking, or process-liveness signals; reuse cached parsed session state for
   unchanged sessions.
8. Add guardrails:
   - if incremental query returns more than a threshold, fall back to full
     refresh,
   - if the DB path changes, clear the cache,
   - if any SQLite error occurs, clear cache and full refresh next tick,
   - periodically full refresh to recover from missed/deleted/archived rows.
9. Add metrics for incremental rows fetched, hydrated sessions, dirty sessions,
   full refresh count,
   cache hit count, and fallback count.
10. Extend tests to cover append, update of existing part id, equal timestamps,
   out-of-order rows, DB path change, and full-refresh fallback.

## Validation Plan

- Run `npm run check`.
- Run `npm run build`.
- Run `./run_tests.sh`.
- Use the profiler to compare current full part query timing with incremental
  timing under quiet and active sessions.
- Restart with `./restart_dashboard.sh` and compare Prometheus metrics:
  `dashboard_poll_duration_seconds{step="db_query"}`,
  snapshot duration, part cache counters, and process CPU over at least 60s.

## Risks and Mitigations

- Risk: stale status if an incremental cursor misses an updated old row.
  Mitigation: use `(activity, id)` cursor, merge by part id, and periodic full
  refresh.
- Risk: losing inference context when only new rows are fetched.
  Mitigation: maintain per-session recent part ring buffers and recompute from
  buffer, not just the delta rows.
- Risk: equal timestamps causing skipped rows.
  Mitigation: cursor includes id tie-breaker and query uses lexicographic
  comparison.
- Risk: deleted/archived rows are not visible through a parts-only delta.
  Mitigation: keep session metadata refresh and periodic full refresh.

## Open Questions

- What full-refresh interval is acceptable: 30s, 60s, or 120s?
- Should incremental caching apply only to SSE snapshots first, leaving
  diagnostic endpoints on full refresh for easier debugging?
