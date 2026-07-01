# Worklog: CPU Polling Optimization & Prometheus Metrics

## What We Learned
- Standard on-demand process scanning (`ps` + `readlinkSync`) on every single SSE check-in creates huge CPU overhead when multiple clients poll frequently.
- SQLite queries inside loops scale $O(N)$ with the number of sessions, causing substantial DB lock contention and serialization overhead.
- Parsing identical immutable part JSON payloads multiple times (twice per loop, and repeatedly across poll ticks) wastes precious CPU cycles.

## What Failed & How We Fixed It
- **Issue**: Standard `tsc` compilation inside automated tests failed when compiling `prom-client` and `better-sqlite3` imports due to the absence of the `--esModuleInterop` option.
  - *Fix*: Changed the import format in `src/lib/metrics.ts` to `import * as client from 'prom-client'` and added the `--esModuleInterop` flag to the `tsc` invocation inside `scripts/test-optimize-poller.mjs`.
- **Issue**: Mocking module-internal functions (like `resolveOpenCodeDbPath`) on the module export object in CommonJS doesn't intercept local scopes.
  - *Fix*: Instead of stubbing `resolveOpenCodeDbPath`, we mocked the shared export of `loadConfig` in the `config` module. This naturally forced the production code paths to safely redirect database interactions to a dedicated in-memory test database.

## Key Changes
- **Process Polling**: Replaced on-demand process scanning with a background interval (5s) scan. Resolves CWD only for new PIDs, caches them, and automatically evicts exited PIDs.
- **SQLite Performance**: Consolidated $N$ queries on the `part` table into a single window function query (`ROW_NUMBER() OVER (PARTITION BY session_id ...)`) fetching at most 80 parts per active session.
- **Part Cache**: Caches parsed parts using an in-memory size-bounded cache Map. Reuses parsed message bodies and inference tokens, eliminating double JSON parsing.
- **Metrics**: Added Prometheus metrics for SSE active client counts, poll step durations, part cache hit rates, and status count tracking. Exposed under GET `/api/metrics` with basic auth.
