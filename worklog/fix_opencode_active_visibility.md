# Fix OpenCode Active Visibility

- Replaced broad same-directory liveness with explicit OpenCode visibility reasons and newest-N cwd allocation.
- Learned `/session` and `/path` are roster/context signals, not proof that a specific TUI session is currently open.
- Fixed `time_updated` handling so streaming reasoning/text/tool updates refresh activity ordering.
- Review caught two stale-session paths: idle `/session/status` entries and `/path`-only directory allocation.
- Added deterministic and property checks for status inference, liveness allocation, and process parser attribution.
- Dashboard restart initially failed in this environment due unavailable user systemd; the user rebuilt the service externally and post-rebuild API validation passed.
