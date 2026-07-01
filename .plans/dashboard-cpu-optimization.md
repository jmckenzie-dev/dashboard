# Dashboard CPU Optimization Plan

## Goal

Reduce steady-state CPU usage for the AI agent dashboard without making status
inference brittle or losing visibility for active OpenCode sessions.

## Plan

1. Measure current Prometheus metrics and process CPU.
2. Eliminate per-SSE-client duplicated polling by sharing one snapshot across
   subscribers.
3. Reduce SQLite overhead with a persistent connection, dashboard-owned indexes,
   and a bounded part-scan set focused on newest/live sessions.
4. Reduce redundant part-cache lookups by parsing parts in one pass.
5. Make process scanning lazy/TTL-based rather than always-on.
6. Verify with `npm run check`, `npm run build`, `./run_tests.sh`, restart, and
   post-restart metrics.

## Measurement Summary

- Before second pass: db query averaged ~328ms per snapshot and Node CPU was
  ~12% with two SSE clients.
- After shared snapshots + query limiting/indexing: db query averages ~70ms and
  Node CPU settles around ~3.6%.
