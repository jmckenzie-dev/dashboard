---
submitted-at: "2026-06-30T15:20:40.050Z"
title: "Add: Node Script to Dump Per-Session Dashboard State for Debugging"
auto-captured: true
---
# Add: Node Script to Dump Per-Session Dashboard State for Debugging

## Goal

Goal: Add a standalone Node script (`scripts/dump-sessions.mjs`) that dumps, per
OpenCode session, the full set of data the dashboard currently knows — including
the *inputs* to status inference — so we can diagnose why a session shows a given
status (e.g. an "Error" session that we'd expect to be `idle`/`blocked_question`).

## Current State

### Status pipeline (what determines "Error")

- `getAllSessions()` → `getOpenCodeSessions()` (`src/lib/agents/index.ts:169`,
  `src/lib/agents/opencode.ts:666`).
- SQLite path: `getSessionsViaSQLite()` (`src/lib/agents/opencode.ts:569`) reads
  the `session` + `part` tables, calls `parsePartData()` (`opencode.ts:136`),
  then `inferOpencodeStatus()` (`src/lib/status/inference.ts:151`).
- The `error` status is produced at `src/lib/status/inference.ts:178`:
  `if (hasError) return 'error';` where `hasError = latestTool?.status === 'error'`
  (`inference.ts:125`). This is checked **after** blocking states but **before**
  `retry`/`busy`/natural-stop. A tool part whose latest status is `error` latches
  the session as `error` regardless of age — there is no decay.
- Escaping a `question`/`submit_plan` prompt typically terminalizes that tool part
  with `status: 'error'`; with no later natural `step-finish (reason=stop)`, the
  session stays `error` indefinitely.
- Visibility (why an errored session still shows) is governed by liveness
  allocation in `src/lib/agents/opencode-liveness.ts` (see prior plan
  `.plans/fix-defunct-error-status-session-stuck-visible-after-new-...`).

### Existing introspection

- `src/routes/api/status/diagnose/+server.ts` returns session outputs (status,
  blockReason, liveness/visibility reasons, process inventory) but does **not**
  expose the inference *inputs* (latestTool, hasError, parts, sessionStatus). It
  also requires the running server + auth.
- Existing `scripts/*.mjs` test scripts compile single self-contained TS modules
  with `tsc` into `./tmp/`, then `require()` them and exercise the real
  algorithms (see `scripts/test-status-inference.mjs`, `scripts/test-opencode-
  liveness.mjs`). They log to `./logs/` with datetime-stamped names.

### Compilable modules (no SvelteKit/$lib aliases)

These source modules import only node builtins, `toml`, `better-sqlite3`
(type-only), and each other via relative paths — they compile cleanly under plain
`tsc` + `node` (the established pattern):
- `src/lib/status/inference.ts` — `analyzeParts`, `inferOpencodeStatus`,
  `inferPhase`, `COMPLETE_FRESH_MS`, `WORKING_GRACE_MS`.
- `src/lib/agents/opencode-liveness.ts` — `allocateOpenCodeLiveness`,
  `hasOpenCodeStatusLiveness`, `RECENT_ACTIVE_FALLBACK_MS`.
- `src/lib/process/poller.ts` — `scanProcesses` (node builtins only).
- `src/lib/config.ts` — `loadConfig` (needs `toml`, present in deps).
- `src/lib/agents/types.ts` — pure types/helpers.

`opencode.ts` itself is NOT compiled: `getSessionsViaSQLite`/`parsePartData` are
not exported, and compiling the whole file adds risk for no algorithmic gain. The
script exercises the **real algorithms** (inference + liveness) and replicates
only the I/O wiring (SQL queries, `fetch` calls), which is plumbing, not logic.
`parsePartData`'s normalization step is mirrored faithfully in the script and
clearly labelled as such.

## Assumptions

- `npm install` has been run (`toml`, `better-sqlite3`, `typescript` present).
- The OpenCode SQLite DB path and API base come from `dashboard.toml` via the
  real `loadConfig()` — same config the dashboard uses.
- `better-sqlite3` is opened read-only with `fileMustExist: true`, matching
  `getSessionsViaSQLite` (`opencode.ts:581`).
- The script runs on the same host as the dashboard/opencode (needs access to
  `~/.local/share/opencode/opencode.db` and the opencode API port).
- Platform is Linux (matches current dev/deploy target).

## Recommended Plan

### Step 1 — Create `scripts/dump-sessions.mjs`

New file. Structure follows `scripts/test-status-inference.mjs`:

1. **Logging setup** (AGENTS.md style): `mkdirSync('./logs')`, open a
   datetime-stamped `logs/dump_sessions_<ts>.log` write stream, tee all
   `console.log`/`console.error` to file + stdout.
2. **Compile real modules** with one `tsc` invocation into
   `./tmp/dump-sessions-build/` (CommonJS, target es2022, moduleResolution node,
   skipLibCheck, noEmitOnError false), then write a `package.json`
   `{"type":"commonjs"}` and `require()`:
   - `src/lib/status/inference.ts`
   - `src/lib/agents/opencode-liveness.ts`
   - `src/lib/process/poller.ts`
   - `src/lib/config.ts`
   - `src/lib/agents/types.ts`

   Pull out: `loadConfig`, `scanProcesses`, `analyzeParts`, `inferOpencodeStatus`,
   `inferPhase`, `allocateOpenCodeLiveness`, `hasOpenCodeStatusLiveness`,
   `COMPLETE_FRESH_MS`, `WORKING_GRACE_MS`, `RECENT_ACTIVE_FALLBACK_MS`.
3. **Parse argv**: `--session <id-substring>` (filter; matches raw `ses_…` id or
   `opencode-…` wrapper or title), `--hidden` (include hidden_stale sessions,
   default true since this is a debug tool), `--json` (machine-readable output,
   no log teeing), `--no-parts` (omit raw parts dump), `--api-timeout <ms>`
   (default 1500).
4. **Load config + scan processes** (real `loadConfig()`, real `scanProcesses()`).
   Resolve DB path via the same `resolveOpenCodeDbPath` logic
   (`opencode.ts:239`) — replicate the container-path fallback inline.
5. **Replicate API gathering** (faithful to `opencode.ts`):
   - `checkAPIServer`-equivalent: `GET /session` with AbortController timeout.
   - `getSessionStatusData`-equivalent: `GET /session/status` →
     `Record<id, {type}>`.
   - `getBlockingRequests`-equivalent: parallel `GET /permission` and
     `GET /question`, each `.catch(() => null)`, bucket by `sessionID ?? sessionId`.
   - Build headers via the same rules as `getOpenCodeAPIOptions`
     (`opencode.ts:225`): `x-opencode-directory`, optional Basic auth from
     `config.agents.opencode.username/password` or
     `OPENCODE_SERVER_USERNAME/PASSWORD` env.
6. **Open SQLite read-only**, run the identical queries from
   `getSessionsViaSQLite` (`opencode.ts:587` and `:599`):
   - sessions: `WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY …
     LIMIT 200`.
   - parts per session: `WHERE session_id = ? ORDER BY … LIMIT 80`.
7. **Per session, mirror `parsePartData` + the inference pipeline** and capture
   every intermediate value into a dump object:
   - `partActivityTime = max(time_created, time_updated)` (`opencode.ts:132`).
   - Build `NormalizedPart[]` exactly as `parsePartData` does
     (`opencode.ts:144-160`): `{type, tool, callID: data.callID ?? data.call_id,
     status: data.state?.status, reason: data.reason, time}`.
   - Call real `analyzeParts(normalized)` → `latestTool`, `latestStepReason`,
     `hasError`, `latestPartType`, `latestPartIsActiveTool`.
   - Compute `lastActivityMs = Date.now() - lastActivity`.
   - `sessionStatus = statusData[id]?.type ?? null`;
     `hasActiveInstance = Object.prototype.hasOwnProperty.call(statusData, id)`.
   - `permIds`, `questIds` from the blocking maps.
   - Build the exact `OpencodeStatusInput` and call real `inferOpencodeStatus()`
     → `status`. Call real `inferPhase(...)`. Derive `blockReason` via the same
     `statusBlockReason` switch (replicate inline — it's a 4-line switch on
     `status`).
   - Build the liveness candidate
     `{id, parentId, directory, lastActivity, hasStatusSignal, hasBlockingRequest,
     hasActiveTool, hasProcessSessionId}` and call real
     `allocateOpenCodeLiveness(candidates, directoryAllocationCounts, now)` to
     get `{instanceAlive, livenessReason, visibilityReason}`.
   - `isVisible` verdict: replicate `isVisibleOpenCodeSession`
     (`index.ts:21`) using `visibilityReason ?? livenessReason`, then the
     fallback signals.
8. **Dump format** (human mode): one block per session, ordered by
   `compareSessions` rank (replicate `getStatusRank` from `types.ts:149`), each:
   ```
   === opencode-<id>  [status]  visible=<bool>  age=<humanized>
     title      : ...
     directory  : ...
     parentId   : ...
     created/updated : <iso>
     --- API signals ---
     apiReachable      : true
     sessionStatus     : 'busy' | 'retry' | null
     hasActiveInstance : true
     permIds           : [...]
     questIds          : [...]
     --- inference inputs (OpencodeStatusInput) ---
     latestTool        : { tool, callID, status, active, time } | null
     latestStepReason  : 'stop' | 'tool-calls' | null
     hasError          : false
     lastActivityMs    : 12345
     --- inference outputs ---
     inferredStatus : error
     phase          : blocked
     blockReason    : null
     --- liveness ---
     candidate : { hasStatusSignal, hasBlockingRequest, hasActiveTool, hasProcessSessionId }
     decision  : { instanceAlive, livenessReason, visibilityReason }
     --- last N parts (newest first) ---
     [t=<ms>] tool submit_plan status=error callID=per_abc
     [t=<ms>] step-finish reason=tool-calls
     ...
   ```
   A final summary line: counts per status, total visible, total hidden, API
   reachable, DB path used.
   `--json` mode emits the same data as one JSON object on stdout (no log file
   tee) for piping to `jq`/an agent.
9. **Cleanup**: `rmSync('./tmp/dump-sessions-build', {recursive, force})`;
   `logStream.end()`; `process.exit(0)`.

### Step 2 — Add npm script

**File:** `package.json`

Add to `"scripts"`:
```json
"dump:sessions": "node scripts/dump-sessions.mjs"
```
No new dependencies required.

### Step 3 — Document usage

**File:** `README.md` (and a one-line pointer in `AGENTS.md` "Repository
Structure" under `scripts/`).

Add a short "Debugging session status" subsection: how to run
`npm run dump:sessions`, `--session <substr>`, `--json`, and how to read the
inference-inputs block to answer "why is this session X?".

## Validation Plan

1. **Build/typecheck:** `npm run check` then `npm run build` — expect zero errors
   (script is plain `.mjs`, no TS changes, but confirms no repo breakage).
2. **Compile sanity:** run `node scripts/dump-sessions.mjs --help` (or no args) —
   expect the `tsc` step to succeed and a usage/summary to print; confirm
   `./logs/dump_sessions_<ts>.log` is written.
3. **Live run against current state:** `npm run dump:sessions` — confirm it
   enumerates sessions matching the dashboard. Locate the "Debug bigcodebench
   smoke test failures…" session via `--session bigcodebench`; the dump should
   show, for that session, the exact `latestTool` (expected:
   `tool='question'|'submit_plan'`, `status='error'`, `active=false`),
   `hasError=true`, `inferredStatus='error'`, and the raw part that
   terminalized to `error` — directly explaining the symptom.
4. **Cross-check with diagnose API:** compare the script's per-session
   `inferredStatus`/`visibilityReason` against `GET /api/status/diagnose` for the
   same ids — expect identical status + visibility (validates the script's wiring
   faithfully mirrors the live pipeline).
5. **Filter flags:** `--session <id>` returns only matching sessions;
   `--json | jq '.sessions[].status'` works; `--no-parts` omits the parts block.
6. **Resilience:** with the opencode API down, the script must still run (SQLite
   only), reporting `apiReachable: false` and `sessionStatus: null` everywhere.

Pass = steps 1–4 all succeed and the cross-check in step 4 matches.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `parsePartData` normalization drifts from `opencode.ts` over time | Medium | Script reports a slightly different `latestTool`/`hasError` than the dashboard | Keep the normalization block a near-verbatim copy with a `// MIRRORS opencode.ts:parsePartData` comment and a line-range citation; cross-check (validation step 4) catches drift. |
| `tsc` compile fails (e.g. a new runtime import lands in one of the modules) | Low | Script can't start | The compiled set is deliberately the self-contained algorithm modules; the script fails fast with the tsc stderr. Re-scope the compiled file list if needed. |
| `better-sqlite3` native load issue under the script's cwd | Low | DB unreadable | Use absolute resolved path; open `{readonly:true, fileMustExist:true}` exactly like the dashboard. Surface a clear error if the DB is missing. |
| Output too verbose with many sessions | Low | Unusable dump | Default ordering puts non-idle/errored first; `--session` filter + `--no-parts` keep it focused; `--json` for programmatic use. |

## Open Questions

1. Should the script also dump the generic (claude/codex/gemini) agents? Current
   plan is OpenCode-only (matching the live dashboard, which disables the others
   in `getAllSessions`). Recommend OpenCode-only for now; extend later if needed.
2. Do we want a companion enhancement to the `/api/status/diagnose` endpoint to
   also emit inference inputs (so agents can hit one authenticated URL)? Out of
   scope here; the standalone script is the requested deliverable.
