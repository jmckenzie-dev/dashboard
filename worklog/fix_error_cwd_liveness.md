# Fix error cwd liveness

- Root-caused the qwen3.6 error session as a weak `cwd_allocated` false positive:
  a different opencode TUI in the same directory had no `-s` flag, leaving an
  unallocated cwd slot that selected the dead error session by recency.
- Added candidate status to OpenCode liveness decisions and made terminal
  `error` sessions ineligible for weak `cwd_allocated` and
  `recent_active_fallback` liveness while preserving direct liveness signals.
- Extended the existing OpenCode liveness self-test/property sweep to cover
  error-session cwd allocation, recent fallback suppression, and direct-signal
  behavior.
- Verified with the real dump pipeline that the qwen3.6 session now reports
  `hidden_stale` and `visible:false`, then ran full dashboard checks and
  restarted the service.

## Follow-up: current session missing from dashboard

- Found a second issue in API-first mode: the deployed dashboard service could
  not read `/proc/<pid>/cwd` for the current opencode process (`EACCES`), and
  the current session was absent from `/session`, so it was never selected as a
  SQLite live supplement.
- Fixed this by adding bounded recent SQLite supplements (10 minutes) in the
  API-first merge path. Recent local sessions are now evaluated even when proc
  cwd is unavailable, while old sessions are not blanket-included.
- Verified `/api/agents` includes `Debugging active error session display` and
  the old qwen error remains hidden under `/api/status/diagnose` with
  `hidden_stale`.
