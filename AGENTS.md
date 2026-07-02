# AGENTS.md

Guidance for agentic coding assistants working in this repository.

## Project Snapshot

- App: AI Agent Dashboard
- Stack: SvelteKit 2 + Svelte 5 + TypeScript + Vite 6
- Runtime target: Node (via `@sveltejs/adapter-node`)
- Key backend integrations: local agent histories, OpenCode API/SQLite, local config files, basic auth
- Package manager in repo scripts: `npm`
- Optional local launcher script uses `bun`

## Repository Structure

- `src/routes`: SvelteKit pages and API endpoints
- `src/lib/agents`: per-agent session ingestion + message sending
- `src/lib/config.ts`: config load/save/merge and XDG paths
- `src/lib/auth.ts`: basic auth + bcrypt password hash checks
- `src/lib/llm/summarizer.ts`: LLM summary generation with cache/fallbacks
- `src/lib/notifications`: sound + skill hooks on status transitions
- `scripts/`: local shell/node helpers (`start-dashboard.sh`, cert generation, status-inference & liveness self-tests, `dump-sessions.mjs` debug dumper)

## Install And Run

- Install deps: `npm install`
- Dev server: `npm run dev`
- Build production bundle: `npm run build`
- Preview production bundle: `npm run preview`
- Start built server (HTTP): `npm run start`
- Start built server (HTTPS): `npm run start:https`
- Generate local certs: `npm run generate-certs`
- One-shot local startup helper: `bash scripts/start-dashboard.sh`

## Build, Lint, And Test Commands

- Primary project check (type/svelte diagnostics): `npm run check`
- Build verification: `npm run build`
- Session status debug dump: `npm run dump:sessions` (see "Debugging Session Status" below)
- There is no dedicated linter script (`lint`) configured in `package.json`.
- There is no test runner script (`test`) configured in `package.json`.

## Single-Test Guidance (Important)

- Current state: single-test execution is **not available** because no test framework is configured.
- Evidence:
  - no `test` script in `package.json`
  - no project-level Vitest/Jest/Playwright config files
  - no project test files outside `node_modules`
- If you add Vitest later, use:
  - run all: `npx vitest run`
  - run one file: `npx vitest run src/path/to/file.test.ts`
  - run one test name: `npx vitest run src/path/to/file.test.ts -t "test name"`

## Agent Workflow Expectations

- Prefer `npm run check` and `npm run build` after code changes.
- Always restart the dashboard service after making code or config changes.
- In this project, always run `./restart_dashboard.sh` after any change.
- If changing APIs, verify both route handlers and matching UI consumers.
- Keep edits small and consistent with existing file style.
- Do not introduce new tooling (eslint/prettier/test runner) unless explicitly requested.

## Debugging Session Status

When investigating why a session shows an unexpected status (e.g. an `error`
session that should be `idle`/`blocked`, or a stale session that won't hide),
run the dump script — it compiles and calls the **real** production pipeline
(`getOpenCodeSessionsWithDiagnostics` in `src/lib/agents/opencode.ts`) and prints
the per-session state the dashboard actually sees. It does NOT reimplement any
inference/liveness/parsing logic.

```bash
npm run dump:sessions                       # all sessions, human-readable
npm run dump:sessions -- --session <substr> # filter by raw id / opencode-<id> / title
npm run dump:sessions -- --json             # machine-readable (jq-friendly)
npm run dump:sessions -- --no-parts         # omit the raw parts block
npm run dump:sessions -- --no-hidden        # exclude hidden_stale sessions
```

Per session it shows: identity, API signals (`sessionStatus`,
`hasActiveInstance`, permission/question request ids), the exact inference
inputs (`latestTool` with tool/status/active, `hasError`, `latestStepReason`,
the full `inferenceInput` object), the inferred status/phase, the liveness
candidate + decision (`instanceAlive`/`livenessReason`/`visibilityReason`), and
the recent normalized parts. Output is tee'd to
`./logs/dump_sessions_<timestamp>.log`.

The same per-session inference data is also exposed by the authenticated
`GET /api/status/diagnose` endpoint (`src/routes/api/status/diagnose/+server.ts`)
when you cannot shell into the host running the dashboard. Reach for the script
first for local debugging; use the endpoint for remote/agent-driven inspection.

Common finding: an `error` session usually has
`latestTool={tool:'submit_plan'|'question', status:'error', active:false}` with
`hasError=true` — escaping a plan/question prompt terminalizes that tool part to
`error`, and `src/lib/status/inference.ts` latches `error` regardless of age.
Terminal `error` sessions are intentionally ineligible for weak
`cwd_allocated` and `recent_active_fallback` liveness; if one is visible, look
for a direct signal such as `process_session_id`, `status_map`,
`active_tool`, or `blocking_request`.

## OpenCode Session Architecture

The dashboard's view of OpenCode sessions is built from three layers
combined in a specific order. Understanding this order is essential when a
session is unexpectedly missing or stuck visible.

### Source resolution order (`getOpenCodeSessions`)

1. **API-first** (`getSessionsViaAPIStatusFirst`): when `apiBase` is
   reachable, `/session` is the roster of record. Each row is enriched
   with a bounded SQLite latest-parts read for status inference
   (`blocked_review` / top-level `error`). `complete` is intentionally
   NOT emitted in this path — sessions that finished naturally decay to
   `idle`, and visibility is governed entirely by the liveness layer.
2. **SQLite live supplements** (`getSQLiteLiveSupplements`): sessions
   absent from `/session` but referenced by live status/blocking/process
   signals, OR with activity within `RECENT_SQLITE_SUPPLEMENT_MS`
   (10 min), are merged back in. The recent window exists because the
   dashboard runs in a container that often cannot read host process
   cwd (see "Containerized deployment" below) — without it, an active
   local session whose proc cwd is unreadable would vanish from the
   dashboard between tool calls.
3. **SQLite full fallback** (`getSessionsViaSQLite`): only when the API
   roster is empty/unreachable. Full inference over `PARTS_PER_SESSION_LIMIT`
   most recent parts per session.
4. **API messages fallback** (`getSessionsViaAPI`): legacy per-message
   fetch, last resort.

`opencodeSnapshotMode{mode=...}` records which path produced each
snapshot (`api_first`, `sqlite_fallback`, `diagnostic_sqlite`,
`api_messages_fallback`).

### Liveness pipeline (`src/lib/agents/opencode-liveness.ts`)

Visibility = does an instance back this session? Decided in descending
reliability order inside `allocateOpenCodeLiveness`:

1. **Direct signals** (`directReason`, all can set `instanceAlive:true`):
   - `blocking_request` — pending `/permission` or `/question`
   - `active_tool` — running tool part, ≤ `ACTIVE_TOOL_LIVENESS_MAX_AGE_MS`
     (30 min). Older `running` parts are treated as orphaned (process
     died without terminalizing the tool).
   - `process_session_id` — process argv `-s` matches this session id.
     **Suppressed** when the candidate's directory already has a
     *different* session confirmed via `status_map`: opencode `/new`
     creates a new session id but Linux argv is immutable, so the old
     id lingers in `/proc/<pid>/cmdline`. See
     `.plans/fix-stuck-error-session-after-new.md`.
   - `status_map` — session present in `/session/status` (busy/retry).
2. **`cwd_allocated`** — weak directory-proximity signal. For each
   directory, the N most-recently-active root sessions (no parent) that
   lack any direct signal are marked alive, where N is
   `directoryAllocationCounts[dir]`.
3. **`recent_active_fallback`** — activity within
   `RECENT_ACTIVE_FALLBACK_MS` (30s) with no other signal.
4. **`hidden_stale`** — everything else; filtered from the default view.

**Error-status sessions are terminal.** They are deliberately ineligible
for `cwd_allocated` and `recent_active_fallback` (see
`.plans/fix-error-session-cwd-allocated-resurrection.md`). A dead error
session sharing a directory with a live TUI must NOT be resurrected by
cwd proximity. Direct signals still win if genuinely present.

### Directory allocation math (`getDirectoryAllocationCounts`)

`directoryProcessCounts` counts every detected opencode process per cwd.
Then, for each process that has **both** `cwd` and `sessionId` (i.e. a
`-s` flag), one slot is subtracted from its directory. Net result: a
directory with one flagged TUI leaves zero `cwd_allocated` slots; a
directory with a *flagless* TUI (`opencode` with no `-s`) leaves one
slot, which is why flagless TUIs are the common source of cwd-allocated
false positives.

### Visibility gate (`isVisibleOpenCodeSession` + hysteresis)

A session is directly visible when it has any non-`hidden_stale`
liveness/visibility reason, an active instance, a blocking request, a
blocked status, or `working`/`retry` status. `computeVisibleSessions`
adds 90s hysteresis (bounded to 200 sessions) so actively-worked
sessions don't flicker during brief `hidden_stale` gaps.

## Containerized Deployment

The dashboard runs in a rootless Podman container
(`ai-agent-dashboard.container` Quadlet). This shapes several behaviors:

### Bubble-wrapped opencode instances (bwrap)

OpenCode TUI launches are typically wrapped: `bwrap --args... --
/home/.../.opencode/bin/opencode [-s sessionId]`. The process poller
(`src/lib/process/poller.ts`) **rejects** the bwrap wrapper line and
instead attributes the real opencode **child** process (the bare
`opencode` invocation). This avoids double-counting. Do not "fix" the
poller to detect bwrap — see `scripts/test-process-poller.mjs`
("rejects bwrap wrapper to avoid double-counting its opencode child").

The child opencode process is what carries the `-s` session id and the
readable `/proc/<pid>/cwd`. The bwrap wrapper has neither reliably.

### Host PID namespace and proc access

The container runs with `--pid=host` so the poller can see host opencode
processes. **But** rootless container security boundaries still forbid
`readlink('/proc/<host-pid>/cwd')` for many host processes, returning
`EACCES`. This is why:
- TUI sessions frequently have `hasProcessSessionId:true` (argv is
  readable) but `cwd:null` and no `cwd_allocated` liveness.
- The API-first recent-SQLite supplement window exists: without it, an
  active local session with an unreadable cwd would disappear from the
  dashboard whenever it isn't in `/session/status`.
- `cwdReadDiagnostics` is surfaced in `/api/status/diagnose` — check it
  when a session is unexpectedly missing; a cluster of
  `permission_denied` entries explains cwd-based liveness gaps.

### API base resolution

`agentConfig.apiBase` may be `host.containers.internal` (from-container)
or `127.0.0.1` (host/dump script).
`resolveReachableOpenCodeApiBase` tries the configured base first, then
falls back to `127.0.0.1` if the hostname is `host.containers.internal`.
This lets the same config work for the running service and for local
scripts like `dump-sessions.mjs`.

### Auth header scoping

Global endpoints (`/session`, `/session/status`, `/permission`,
`/question`, `/path`) use **auth-only** headers — never
`x-opencode-directory`. The `x-opencode-directory` header is applied
only to per-session calls that require a concrete directory. Sending it
globally previously caused the API to scope its roster to one directory
and hide sessions from other directories (see
`worklog/repair_opencode_status.md`).

## Status Inference Semantics

`src/lib/status/inference.ts` is pure and I/O-free so it can be compiled
alone and unit-tested under plain `node` (see
`scripts/test-status-inference.mjs`).

- **Blocking states are checked first and are mutually exclusive.**
  Priority: `blocked_permission` > `blocked_question` > `blocked_review`.
- **`submit_plan`/`plan_exit`/`question`** park on a *running* tool part
  → `blocked_review`/`blocked_question`. No staleness cutoff is applied
  to `blocked_review` (plan reviews legitimately last up to 96h).
- **`error`** is latched when the latest tool part has `status:'error'`,
  with **no age cutoff**. Escaping a `submit_plan`/`question` prompt
  terminalizes that tool part to `error`, which then persists. This is
  intentional and is why the liveness layer — not the status layer — is
  responsible for hiding dead error sessions.
- **`complete`** is emitted only by the full SQLite/diagnostics path. In
  API-first mode, natural stops decay straight to `idle`; visibility is
  the liveness layer's job.
- **Turn scoping** (`analyzeParts`): a tool is `active` only when in
  flight, not terminalized by a later part with the same `callID`, and
  no natural `step-finish` (reason=stop) occurred after it. This is the
  core guard against stale-`running` false positives.

## Self-Test Suite

There is no Vitest/Jest runner. Instead, focused compile-and-run self-tests
live in `scripts/` and are wired into `run_tests.sh`:

- `scripts/test-status-inference.mjs` — `analyzeParts` + `inferOpencodeStatus`
  priority/mutual-exclusivity + property sweep.
- `scripts/test-opencode-liveness.mjs` — `allocateOpenCodeLiveness`
  regressions (incl. error-session cwd suppression) + 1695-check property sweep.
- `scripts/test-visibility-hysteresis.mjs` — hysteresis smoothing + eviction.
- `scripts/test-process-poller.mjs` — argv/session-id/port parsing, bwrap
  rejection.
- `scripts/test-optimize-poller.mjs` — DB consolidation, part cache, metrics,
  API-first supplement selection (`liveSupplementSessionIds`,
  `isRecentSQLiteSupplement`).
- `scripts/property-test-agents-api.mjs` — live `/api/agents` invariants
  against the running service.

Each compiles only the real `.ts` modules it needs (no reimplementations)
and runs them under plain `node`. When changing any of the above
subsystems, extend the matching self-test rather than asserting by hand.

## TypeScript And Svelte Standards

- TS config is strict (`"strict": true`).
- Keep exported function signatures explicit when useful for clarity.
- Prefer typed domain models/interfaces in `src/lib/agents/types.ts` style.
- Use Svelte 5 runes patterns already present (`$state`, `$effect`, `$props`).
- Serialize `Date` objects to ISO strings before returning JSON to clients.

## Import Conventions

- Use `import type` for type-only imports.
- In SvelteKit route files, prefer `$lib/...` aliases for internal modules.
- For Node built-ins, use `node:` specifiers (`node:fs`, `node:path`, etc.).
- Keep imports grouped logically:
  - framework/external packages
  - internal `$lib`/relative modules
  - type-only imports can be grouped at top or near related imports

## Formatting Conventions

- Use 2-space indentation.
- Use semicolons.
- Use single quotes for strings.
- Keep trailing commas in multiline arrays/objects/params where natural.
- Keep lines readable; avoid large inline expressions when a helper improves clarity.
- Match existing brace and spacing style in touched files.

## Naming Conventions

- `camelCase`: variables, functions, non-constant values.
- `PascalCase`: interfaces/types.
- `UPPER_SNAKE_CASE`: module-level constants (for config defaults/paths).
- Route and SvelteKit file naming must follow framework conventions (`+page.svelte`, `+server.ts`, etc.).
- Keep status/type unions narrow and explicit (e.g., `'working' | 'blocked' | 'complete' | 'idle'`).

## Error Handling Patterns

- Favor early returns for auth and validation failures.
- API endpoints should return structured JSON errors with status codes.
- Wrap external I/O (`fetch`, fs, child process) in `try/catch` where failure is expected.
- Log concise context for failures (`console.error('Context:', error)`).
- Provide safe fallbacks (e.g., summary fallback when LLM call fails).

## API Route Conventions

- Authenticate first when config has a password hash.
- Use `json(...)` responses for normal API payloads.
- Validate request body shape before acting.
- Return 400 for bad input, 404 for missing resources, 500 for execution failures.
- Keep handler functions short; extract shared logic to `src/lib`.

## Frontend Conventions

- Keep UI state local with Svelte runes unless shared state is necessary.
- Prefer derived display helpers (`formatTime`, `statusClass`, etc.) over in-template logic.
- Preserve mobile behavior (`@media` sections already exist in route styles).
- Reuse global CSS variables in `src/app.css`.

## Security And Safety Notes

- Auth uses HTTP Basic + bcrypt hash stored in config.
- Sanitize uploaded filenames before writing to disk.
- Be careful with shell execution paths and interpolation (`exec`, `execSync`).
- Avoid exposing absolute host paths in client-visible data unless necessary.

## Local Data And Config Paths

- Config dir: `${XDG_CONFIG_HOME:-~/.config}/ai-dashboard`
- Data dir: `${XDG_DATA_HOME:-~/.local/share}/ai-dashboard`
- Dashboard config file: `dashboard.toml`
- TLS certs generated by `scripts/generate-certs.sh`

## Cursor And Copilot Rules

- Checked for Cursor rules: `.cursor/rules/` and `.cursorrules` -> none found.
- Checked for Copilot instructions: `.github/copilot-instructions.md` -> none found.
- If these files are later added, treat them as high-priority repository instructions.

## Quick Pre-PR Checklist For Agents

- Run: `npm run check`
- Run: `npm run build`
- Confirm auth-sensitive routes still gate correctly.
- Confirm Svelte UI still renders dashboard + settings pages.
- Do not claim tests were run; no test suite exists yet unless you add one.

## TODO work
- Items to work on are available in TODO.md
- IMPORTANT: When you complete an item, ALWAYS move it under the # DONE heading with [x] marking it as completed.
- IMPORTANT: When you complete an item, ALWAYS move it under the # DONE heading with [x] marking it as completed.
