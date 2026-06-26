# Worklog: Fix TUI Process Liveness

## What we learned
- The dashboard is run inside a container via Podman. Inside rootless containers, security boundaries prevent tracing or reading `/proc/<pid>/cwd` of host processes, returning `Permission denied` even when sharing the PID namespace (`Pid=host`).
- This namespace isolation means the process poller is unable to map processes to their active session directories based on CWD.
- Local TUI-driven `opencode` processes do not communicate with the HTTP API server's `/session/status` endpoint (it returned `{}` for them), meaning `sessionStatus` is always `null`.
- As a result, TUI sessions were incorrectly classified as `idle` as soon as their inactivity exceeded the 10-second grace window, despite the agent processes actively running on the host.

## How we fixed it
- **Heuristic fallback mapping**: Updated the OpenCode session resolver (`src/lib/agents/opencode.ts`) to match unresolved TUI processes (PIDs where `sessionId` and `cwd` are both null inside the container) to the most recently active sessions that are not naturally stopped (`latestStepReason !== 'stop'`).
- **Liveness status propagation**: Propagated this process liveness state so that if a session has an active process mapped to it and isn't stopped, it is evaluated as `working` instead of falling back to `idle`.
- **Test runner compile fix**: Corrected `scripts/test-status-inference.mjs` to compile `types.ts` alongside `inference.ts` to prevent ESM import failures, and added the `.js` extension to the types import statement.
- **Quadlet configuration**: Shared host PID namespace for the dashboard container in `/home/jmckenzie/.config/containers/systemd/ai-agent-dashboard.container` via `PodmanArgs=--pid=host`.
