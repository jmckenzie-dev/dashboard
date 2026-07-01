# Dashboard CPU Optimization

- Found the remaining hot path in Prometheus metrics: SQLite part queries were
  dominating at ~328ms per snapshot while parsing was only ~9ms.
- Replaced per-client SSE polling with a shared snapshot manager so multiple
  dashboard tabs no longer multiply the expensive OpenCode session scan.
- Added persistent SQLite handles and dashboard-owned indexes for session/part
  activity lookups.
- Limited expensive part reads to newest/live sessions while preserving broad
  session metadata for liveness/hysteresis.
- Converted part parsing to a single pass and updated optimization tests.
- Made process scanning lazy with a 10s TTL instead of an always-on background
  interval.
- Final observed Node CPU settled around ~3.6% of one core with two SSE clients;
  db query time is now ~70ms per snapshot.
