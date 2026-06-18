# OpenCode Session Liveness — Phase 2 (OS Process Matching)

> **Status:** design only — not yet implemented. Phase 1 (`GET /path`
> directory match) is live; see `opencode-session-status.md` §Q6 and
> `src/lib/agents/opencode.ts` `getInstanceLiveness`.

## Why a Phase 2 is needed

Phase 1 can only *positively* confirm an instance is alive (busy in
`/session/status`, or directory matches a reachable `/path`). It **cannot
prove a session is dead**. `instanceAlive` is therefore only ever `true` or
`undefined`, so the dashboard never dims a card as "stale/dead" today. This
document describes how to close that gap with OS-level process inspection —
the only reliable method per `opencode-session-status.md` Truth #1.

## Goal

For a given session `S` with `S.directory`, determine with high confidence
whether an `opencode` executable is currently running with that directory as
its working directory (and, ideally, whether it knows about `S.id`).

## Approach (mirror the existing claude/codex/gemini adapters)

The dashboard already does exactly this pattern for the other agents
(`src/lib/agents/claude.ts:17-38`, `codex.ts:30-51`, `gemini.ts:13-34`):

1. Enumerate candidate PIDs: `pgrep -f opencode` (or scan `/proc/*/cmdline`).
2. For each PID, read `cmdline` and `cwd`:
   - `cat /proc/<pid>/cmdline` — confirm it is an `opencode` process.
   - `readlink -f /proc/<pid>/cwd` — its working directory.
3. Build `Map<cwd, pid>`. A session is alive iff its `directory` is a key in
   this map.

OpenCode-specific refinement (stronger than cwd alone):
- Match by **session id in argv** if present. OpenCode launched for a specific
  session may carry `ses_*` in its arguments (`/proc/<pid>/cmdline`), giving a
  definitive per-session match that cwd cannot.
- Also expose `pid` on the `AgentSession` (the field already exists in
  `types.ts`) so the UI can show it and the abort/resume actions can target it.

## Proposed implementation

New helper in `src/lib/agents/opencode.ts`:

```ts
function findOpenCodeProcesses(): Map<string, number> {
  // Returns Map<cwd, pid>, same shape as the other adapters.
  // Consider also a Map<sessionId, pid> from argv parsing.
}
```

Wire it into `getOpenCodeSessions` alongside the Phase-1 `/path` result:

```ts
// Pseudocode — merge with existing getInstanceLiveness path
const procDirs = process.platform === 'linux'
  ? findOpenCodeProcesses()
  : new Map<string, number>();

// instanceAlive becomes three-valued:
//   true  — busy, /path match, OR a live process matches directory/session
//   false — a process for this directory/session WAS expected but none found
//   undefined — cannot determine (non-linux, or no basis to expect one)
```

`false` (the new state) should only be set when we have a positive reason to
expect a live process and find none — e.g. a session with `state.status` of
`running` on a tool part (durable activity signal) but no matching process.
This avoids false "dead" flags on genuinely old/idle sessions.

## Container caveat (the hard part)

The current config uses `host.containers.internal:4096`, meaning the OpenCode
HTTP API is served from **inside a container**. Host-side `pgrep`/`/proc` will
not see those PIDs. Options, in order of preference:

1. **Run the process scan inside the container** via a small exec bridge the
   dashboard can call (e.g. an existing sidecar, or `podman exec`/`docker
   exec` if the dashboard host has permission). The container's `/proc` is the
   source of truth for its own opencode processes.
2. **Container host enumeration** if the dashboard runs on the same host as
   the container runtime and can read the container's PID namespace via
   `/proc/<container-init-pid>/root/proc/...` (complex, brittle).
3. **PID/owner columns in OpenCode itself** — upstream change. The cleanest
   long-term fix: persist owning PID/instance-id per session
   (`opencode-session-status.md` Truth #1). Out of our hands until landed.

Until one of these is in place, **Phase 2 only works reliably for host-run
opencode instances**, not containerized ones. The implementation should detect
the container case (apiBase host is `*.containers.internal`, or `/path` cwd
doesn't resolve on the host) and fall back to Phase-1 semantics (leave
`instanceAlive` undefined rather than wrongly reporting `false`).

## Testing

- Fixture: a fake `/proc` tree (mock `findOpenCodeProcesses`) covering: live
  match by cwd, live match by session id in argv, dead (no match), and the
  ambiguous multi-instance same-directory case.
- Regression: a session with a `running` tool part and no matching process
  must surface `instanceAlive: false` (Phase 2) without disturbing
  legitimately idle sessions.
- Container case: when apiBase is `*.containers.internal`, the scan must be
  skipped (not produce false `false`).

## Rollout

1. Land the helper + host scan behind a platform/container guard.
2. Set `instanceAlive: false` only in the strict "expected but missing" case.
3. The UI dimming rule already exists (`+page.svelte` `.dimmed`) and will
   activate automatically once `false` is produced; no frontend change needed.
