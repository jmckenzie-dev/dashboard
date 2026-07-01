---
submitted-at: "2026-07-01T18:28:04.986Z"
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
- API-vs-DB split today: OpenCode API supplies live/control signals (`/session/status`, `/permission`, `/question`, `/path`), while SQLite supplies broad session/message history. The API can return messages for one session, but using it for all visible sessions would be N HTTP calls per snapshot and would not replace DB access for historical/offline sessions.

## Assumptions
- OpenCode mostly appends parts, but can update existing part rows.
- We can tolerate a periodic full-refresh safety net.
- We want to preserve current correctness for live/blocking/session visibility.

## Options and Tradeoffs
- Option A: Simple `WHERE updated > N` on the current recent-parts query.
  - Pros: small code diff; easy to reason about initially.
  - Cons: incomplete by itself because inference needs prior context; useful only if paired with cached context or follow-up hydration queries.
  - Risk: high if standalone, medium if used as a trigger.
- Option B: Two-stage incremental SQL: query changed rows first, then selectively hydrate context only for sessions that need it.
  - Pros: matches your suggestion; quiet ticks become tiny; active ticks only do heavier per-session queries for affected/live sessions; avoids over-fetching all recent parts.
  - Cons: more state than the current full snapshot; needs careful cursor, cache, and fallback logic.
  - Risk: medium.
- Option C: Stateful incremental cache with periodic full refresh but no selective hydration.
  - Pros: lowest number of queries on quiet ticks; preserves context in memory.
  - Cons: harder to recover if a session enters view without a warm buffer; would need broad bootstrapping.
  - Risk: medium.
- Option D: Lean more on OpenCode API for message context.
  - Pros: simple for one live session; API naturally reflects live server state.
  - Cons: per-session HTTP calls scale poorly, API is not the source for archived/offline history, and DB is already local/in-process.
  - Risk: medium-high.

## Recommended Plan
1. Implement Option B: two-stage incremental SQL without file watching.
2. Add `dashboard_part_activity_idx` on `COALESCE(time_updated, time_created), id` for global delta scans.
3. Maintain an in-memory per-DB-path snapshot cache:
   - root session metadata map,
   - per-session recent-part ring buffers capped at 80,
   - part-id update tracking,
   - high-water cursor `{ activity, id }`,
   - last full refresh timestamp.
4. Bootstrap with the current full query.
5. On normal ticks, run a small global delta query for rows newer than the high-water cursor, ordered ascending by `(activity, id)`.
6. Merge delta rows into per-session buffers and mark affected sessions dirty.
7. Selectively hydrate context with a per-session “latest 80 parts” query only when needed:
   - changed session has no warm buffer,
   - changed rows are ambiguous without prior context,
   - session has live API/blocking/process-liveness signals but no buffer,
   - session newly enters the displayed candidate set.
8. Recompute parsing/inference only for dirty/hydrated/live sessions; reuse cached parsed state for unchanged sessions.
9. Keep cheap root session metadata refresh each tick initially; incrementalize session metadata only if metrics show it matters.
10. Full-refresh periodically and on cache inconsistency, DB path change, SQLite error, or very large delta volume.
11. Add metrics: incremental rows fetched, hydrated sessions, dirty sessions, reused session count, full refresh count, and fallback count.

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