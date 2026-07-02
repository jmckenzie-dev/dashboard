# Repair OpenCode Status

- Found the API-primary path had regressed into using SQLite as the primary
  session list whenever `dbPath` was configured, which let stale same-directory
  history appear as live dashboard sessions.
- Fixed OpenCode API calls to use auth-only headers for global endpoints;
  `x-opencode-directory` is now applied only to per-session calls that need a
  concrete directory.
- Added a local API-base fallback from `host.containers.internal` to
  `127.0.0.1` so local diagnostic scripts and actions can work from both host
  and container contexts.
- Kept SQLite as enrichment/supplement data only: API sessions are primary, and
  SQLite can add missing sessions only when live status, blocking, or direct
  process-session evidence references them.
- Bounded weak cwd-only liveness to two hours so a live process directory cannot
  resurrect days-old idle/error sessions.
- Fixed `dump-sessions` to use a per-process build directory; parallel targeted
  dumps no longer delete each other's compiled temp files.
- Follow-up: changed pruning semantics to be process-backed instead of
  idle-age-backed. OpenCode TUI/process still open means its best cwd/session
  candidate remains visible as idle/error/working; closing the TUI removes the
  process signal and the dashboard prunes it after the visibility hysteresis
  window.
