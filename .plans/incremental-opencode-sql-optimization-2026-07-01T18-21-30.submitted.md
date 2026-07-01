---
submitted-at: "2026-07-01T18:21:30.082Z"
title: "Incremental OpenCode SQL Optimization"
auto-captured: true
---
# Incremental OpenCode SQL Optimization

## Goal
- Goal: Evaluate and plan a safe timestamp-based SQL optimization for the OpenCode dashboard polling path.

## Current State
- Current hot query is in `src/lib/agents/opencode.ts:775`: fetch root session metadata, then fetch up to 80 recent part rows for newest/live session candidates.
- Status inference in `src/lib/status/inference.ts:48` needs recent context, not just the newest row: latest tool, terminal tool states, step-finish boundaries, and current errors.
- `part` has `time_created` and non-null `time_updated`; current rows use millisecond-like integer timestamps.
- Existing dashboard index helps per-session recent-part scans, but a global “changed rows since cursor” query would need an activity-leading index.

## Assumptions
- OpenCode mostly appends parts, but can update existing part rows.
- We can tolerate a periodic full-refresh safety net.
- We want to preserve current correctness for live/blocking/session visibility.

## Options and Tradeoffs
- Option A: Simple `WHERE updated > N` on the current recent-parts query.
  - Pros: small code diff; easy to reason about initially.
  - Cons: incorrect by itself because inference needs prior context; can miss old-row updates if cursor handling is naive; still scans selected sessions.
  - Risk: high.
- Option B: Stateful incremental cache with high-water cursor and per-session recent-part buffers.
  - Pros: biggest idle CPU reduction; preserves context; can handle updates by part id; works well with safety full refresh.
  - Cons: more state and tests; needs fallback paths.
  - Risk: medium.
- Option C: Event-driven DB file watching plus incremental SQL.
  - Pros: closest to near-zero idle work.
  - Cons: more moving parts; watcher reliability varies; still needs safety polling.
  - Risk: medium-high.

## Recommended Plan
1. Implement Option B first, without file watching.
2. Add `dashboard_part_activity_idx` on `COALESCE(time_updated, time_created), id` for global incremental scans.
3. Maintain an in-memory per-DB-path snapshot cache:
   - root session metadata map,
   - per-session recent-part ring buffers capped at 80,
   - part-id update tracking,
   - high-water cursor `{ activity, id }`,
   - last full refresh timestamp.
4. Bootstrap with the current full query.
5. On normal ticks, query changed parts newer than the cursor, ordered ascending by activity/id, merge rows into buffers, and mark affected sessions dirty.
6. Recompute parsing/inference only for dirty sessions and sessions affected by API/blocking/liveness signals.
7. Keep cheap session metadata refresh each tick at first; only incrementalize sessions later if needed.
8. Full-refresh periodically and on any cache inconsistency or high delta volume.
9. Add metrics: incremental rows fetched, dirty sessions, full refresh count, cache reuse count, fallback count.

## Validation Plan
- Run `npm run check`.
- Run `npm run build`.
- Run `./run_tests.sh`.
- Add tests for append, update existing part id, equal timestamps, out-of-order changes, DB path change, and full-refresh fallback.
- Restart with `./restart_dashboard.sh`.
- Compare metrics over at least 60s: `db_query`, snapshot duration, process CPU, full/incremental counters.

## Risks and Mitigations
- Missed rows due to equal timestamps: use `(activity, id)` cursor, not timestamp alone.
- Lost inference context: recompute from cached recent-part buffer, not only delta rows.
- Deleted/archived rows: keep session metadata refresh and periodic full refresh.
- Cache bugs: clear cache and full refresh on errors or DB path changes.

## Open Questions
- Preferred full-refresh safety interval: 30s, 60s, or 120s?
- Should diagnostic endpoints keep using full refresh while the SSE path uses incremental state?