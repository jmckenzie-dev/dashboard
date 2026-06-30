## Add Session Status Debug Dump Tooling

- Added `scripts/dump-sessions.mjs`, a standalone Node script that compiles the
  real `src/lib/agents/opencode.ts` via `tsc` (with `--esModuleInterop` for the
  `better-sqlite3` default import) and calls the production
  `getOpenCodeSessionsWithDiagnostics()` — no duplicated inference/liveness
  logic. Supports `--json`, `--session <substr>`, `--no-parts`, `--no-hidden`.
- Threaded a `captureDiagnostics` opt-in through `getOpenCodeSessions` (SQLite
  + API paths) that attaches a `diagnostic` object to each session exposing the
  raw API signals, exact inference inputs (`latestTool`, `hasError`,
  `latestStepReason`, full `inferenceInput`), liveness decision, and recent
  normalized parts.
- Exported `getOpenCodeSessionsWithDiagnostics()` and added the
  `SessionDiagnostic` / `DiagnosticAgentSession` types; `parsePartData` now
  returns `normalizedParts`.
- Enriched the authenticated `GET /api/status/diagnose` endpoint to emit the
  per-session `diagnostic` block via `describeDiagnostic()` for remote/agent
  inspection.
- Added the `"dump:sessions"` npm script and documented the script, endpoint,
  and root-cause pattern in `AGENTS.md` + `README.md`.
- Diagnostics are opt-in only; normal polling/API paths are unaffected.
- `npm run check` passes (0 errors, 0 warnings).
- The script confirmed the standing root cause: an escaped
  `submit_plan`/`question` prompt terminalizes that tool part to `error`, and
  `src/lib/status/inference.ts:178` (`if (hasError) return 'error'`) latches
  `error` with no age-based decay. Fixing the latch is a separate follow-up.
