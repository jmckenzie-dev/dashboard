## Fix Process Liveness

- Diagnosed that the dashboard backend could see the reported session, but it
  was not marked live and would disappear after recency windows expired.
- Found the process scanner only matched bare `opencode` or wrapper-invoked
  `node|bun|deno .../opencode`; real processes use absolute binaries such as
  `/home/jmckenzie/.opencode/bin/opencode`.
- Fixed process scanning to include absolute opencode binary paths and to keep
  serve ports even when `/proc/<pid>/cwd` is inaccessible.
- Integrated process scan data into OpenCode liveness and added `/session`
  inventory as a positive live-session signal, so idle-but-live sessions remain
  visible.
- Verified inference tests, Svelte checks, and production build all pass.
- Dashboard restart from this container remains blocked because user systemd is
  inaccessible and `distrobox-host-exec` is not returning host command output.
