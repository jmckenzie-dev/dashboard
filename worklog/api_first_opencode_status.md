# API-First OpenCode Status

- Switched normal OpenCode status calculation to API-first signals:
  `/session/status`, `/permission`, and `/question`.
- Kept SQLite only for cheap root-session metadata and latest-12 part
  enrichment for `blocked_review` / top-level `error`.
- Removed normal OpenCode `complete` emission; idle now means no longer
  working, while liveness controls visibility.
- Preserved full SQLite inference for diagnostics and API-unavailable fallback.
- Fixed an API-first false-idle regression: when `/session/status` omits a busy
  signal for the active local session, latest-12 enrichment now marks a session
  as `working` if it has an active non-blocking tool or very recent activity.
- Final observed metrics with two SSE clients: snapshot average around 31ms,
  session metadata around 2ms, enrichment only a few times after startup, and
  Node CPU under ~1% of one core in the sampled window.
