# Plan: Dashboard Polling CPU Optimization & Prometheus Instrumentation

This plan details optimizations to eliminate the high CPU usage on the dashboard server caused by process scanning, database queries, and redundant JSON parsing during polling check-ins. It also adds lightweight performance instrumentation using `prom-client` and a metrics endpoint (`/api/metrics`) to introspect on compute time.

---

## User Review Required

- **SQLite Window Functions**: We verified that SvelteKit's bundled `better-sqlite3` database driver uses SQLite version **3.49.2**. This is fully compatible, as window functions (`ROW_NUMBER() OVER (...)`) have been supported since SQLite 3.25.0.
- **External Dependencies**: We will add the standard `prom-client` NPM package to `package.json` for managing the Prometheus registry, gauges, counters, and histograms. This package is highly optimized, ensuring negligible compute overhead.
- **Worktree & Branch Constraint**: All changes will be restricted solely to the active optimization worktree (`/home/jmckenzie/src/ai/services/projects/dashboard/wt_optimize_dashboard`) and its specific git branch. No modifications will be made directly to `main`.

---

## Proposed Changes

### Dependencies

#### [MODIFY] [package.json](file:///home/jmckenzie/src/ai/services/projects/dashboard/package.json)
- Add `"prom-client": "^15.0.0"` to dependencies.

---

### Dashboard Process Scanner

#### [MODIFY] [poller.ts](file:///home/jmckenzie/src/ai/services/projects/dashboard/src/lib/process/poller.ts)
- **Implement Background Process Polling**:
  - Run the `ps -eo pid,args` scanning in a self-scheduling loop (e.g., every 5 seconds) rather than on-demand in the request path.
  - Store the latest `ProcessScanResult` in a global cached variable.
- **Implement CWD Caching by PID**:
  - Maintain a cache Map of `pid -> cwdPath`.
  - On each background scan, only resolve the CWD via `readlinkSync` (or `lsof`) for new PIDs that aren't already in the cache.
  - Evict PIDs from the CWD cache when they are no longer present in the scanned process list.
- **Fast-Path `scanProcesses`**:
  - Refactor `scanProcesses()` to immediately return the globally cached result.

---

### Dashboard SQLite Database Layer

#### [MODIFY] [opencode.ts](file:///home/jmckenzie/src/ai/services/projects/dashboard/src/lib/agents/opencode.ts)
- **Consolidate Part Query**:
  - Replace the loop executing $N$ queries (one query per session) with a single query using SQLite's window functions:
    ```sql
    WITH ranked_parts AS (
      SELECT id, session_id, message_id, time_created, time_updated, data,
             ROW_NUMBER() OVER (
               PARTITION BY session_id
               ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
             ) as rn
      FROM part
      WHERE session_id IN (
        SELECT id FROM session WHERE time_archived IS NULL AND parent_id IS NULL
        ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
        LIMIT 200
      )
    )
    SELECT id, session_id, message_id, time_created, time_updated, data
    FROM ranked_parts
    WHERE rn <= 80
    ```
  - Map the returned flat array of parts to their corresponding sessions in memory in $O(M)$ time.
- **Implement Part Parsing Cache**:
  - Maintain an in-memory cache (e.g. size-bounded Map or LRU) for parsed parts keyed by the immutable `part.id`.
  - Reuse cached messages and analysis findings when the same `part.id` is queried again.
- **Eliminate Double Parsing**:
  - Ensure that `JSON.parse(part.data)` is only called once per part (caching the resulting object in memory for use in both forward and reverse analysis passes).

---

### Dashboard Server Routes & Instrumentation

#### [NEW] [metrics.ts](file:///home/jmckenzie/src/ai/services/projects/dashboard/src/lib/metrics.ts)
- **Create Metrics Registry**:
  - Initialize the `prom-client` registry.
  - Define metrics:
    - `dashboard_poll_duration_seconds` (Histogram/Gauge) with label `step` (e.g., `process_scan`, `db_query`, `parse_inference`, `total`).
    - `dashboard_part_cache_hits_total` (Counter) with label `result` (`hit` or `miss`).
    - `dashboard_sse_clients_active` (Gauge).
    - `dashboard_sessions_total` (Gauge) with label `status`.

#### [MODIFY] [events/+server.ts](file:///home/jmckenzie/src/ai/services/projects/dashboard/src/routes/api/events/+server.ts)
- Record duration metrics for every tick in `pollOnce()` and track active connection count.

#### [NEW] [+server.ts (Metrics Route)](file:///home/jmckenzie/src/ai/services/projects/dashboard/src/routes/api/metrics/+server.ts)
- **Implement `/api/metrics` GET endpoint**:
  - Expose current metrics via the `prom-client` registry output format.

---

## Verification Plan

### Automated Tests
- Run existing dashboard tests to ensure no regressions:
  ```bash
  bun test
  ```
- **New Unit & Integration Tests**:
  - Create a new test suite file [test-optimize-poller.mjs](file:///home/jmckenzie/src/ai/services/projects/dashboard/scripts/test-optimize-poller.mjs) that compiles and tests:
    - **Single consolidation query** mapping in-memory (using a temporary mock SQLite database populated with multiple sessions and parts).
    - **Part caching**: Validate cache hit rates and verify `JSON.parse` is only triggered on cache misses.
    - **Background process poller**: Verify PID caching, exit eviction, and fast-path retrieval of cached scans.
    - **Metrics registration**: Validate that the metrics endpoint correctly reports metrics to Prometheus.
  - Integrate `scripts/test-optimize-poller.mjs` into [run_tests.sh](file:///home/jmckenzie/src/ai/services/projects/dashboard/run_tests.sh).

### Manual Verification
- Manual deployment, verification of metrics outputs, and CPU usage logging will be handled directly by the user.
