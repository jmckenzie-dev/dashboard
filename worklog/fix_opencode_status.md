# Fix opencode session status determinism

Bridged the gap between `docs/opencode-session-status.md` (the authoritative
reference) and the dashboard's status surfacing. The core problem: OpenCode
(the only agent with real blocking signals) **never** returned `'blocked'`, so
every blocked-aware UI affordance (red badge, reply box, blocked count,
blocked notification) was dead code for it, and the inference flickered
because it used wall-clock staleness as a status proxy and never queried
`/permission` or `/question`.

## What changed

- **New status union** (`src/lib/agents/types.ts`): added
  `blocked_permission` / `blocked_question` / `blocked_review` (OpenCode),
  kept generic `blocked` for the regex agents, kept `retry` as a distinct
  data-model state (folded under `working` in the UI). Added `isBlocked`,
  `blockReasonOf`, and optional `blockReason` / `instanceAlive` /
  `blockingRequestIds` session fields.
- **Pure algorithm extracted** to `src/lib/status/inference.ts`
  (`analyzeParts` + `inferOpencodeStatus`). This is the single source of
  truth — `opencode.ts` imports it. Separating it made it unit-testable.
- **`src/lib/agents/opencode.ts`**: now fetches `/permission` + `/question`
  (live-API-only blocking signals, doc §0 truth #3) and `/path` (Phase-1
  liveness) once per refresh, shared across both data paths. Latest-tool
  detection is now turn-scoped (no natural `stop` after the tool) and
  callID-terminal-checked — this kills the stale-`running` false positives.
  `blocked_review` (submit_plan) has **no staleness cutoff** (reviews last
  up to 96h). `complete` decays to `idle` at 5m. Added action helpers:
  `replyOpenCodePermission`, `replyOpenCodeQuestion`, `rejectOpenCodeQuestion`,
  `abortOpenCodeSession`.
- **UI** (`src/routes/+page.svelte` + `app.css`): three blocked pills
  (red/orange/yellow), retry folded under Working with a "↻ retrying"
  sub-label, Approve/Always/Reject buttons for permissions, Cancel for plan
  reviews, "● live" liveness marker, dimming hook (Phase-2 forward-compatible).
- **Backend actions** (`src/routes/api/agents/[id]/+server.ts`): POST now
  supports `action` of `permission` / `question` / `question-reject` / `abort`.
- **Tests**: `scripts/test-status-inference.mjs` compiles the real
  `inference.ts` with the project's `tsc` and asserts 22 fixtures (no logic
  duplication). Updated `property-test-agents-api.mjs` for the new schema;
  wired both into `run_tests.sh`.
- **Doc**: `docs/opencode-liveness-phase2.md` — OS-process-matching design for
  true dead-instance detection (deferred; Phase 1 `/path` shipped now).

## What I learned / what failed

- **Infinite recursion in the test logger**: overriding `console.log` to call
  a helper that itself calls `console.log`. Fixed by capturing the originals
  first (same pattern as the existing property test).
- **tsc + nodenext**: requires explicit `.js` extensions even for type-only
  imports. Switched to `--moduleResolution node` (type imports are erased, so
  the emitted `inference.js` is runtime-self-contained).
- **SSR three-valued booleans**: `instanceAlive ?? false` in the load function
  would coerce "unknown" to `false` and wrongly dim every idle session as
  dead in Phase 1. Fixed to preserve `true | undefined`.
- **Restart limitation**: `./restart_dashboard.sh` can't reach user systemd
  from this shell ("unable to access user systemd from this environment").
  The production build (`npm run build`) succeeded, which verifies the server
  bundles correctly; a real restart needs to happen where systemd is reachable.

## Verification

- `npm run check` → 0 errors, 0 warnings.
- `npm run build` → ✓ built (adapter-node).
- `node scripts/test-status-inference.mjs` → 22 passed, 0 failed, including
  the pinned non-determinism regressions (96h submit_plan stays blocked_review;
  stale running tool after a stop is inactive).

## Key files

- `src/lib/status/inference.ts` (new, pure algorithm)
- `src/lib/agents/opencode.ts` (rewritten inference + new API helpers)
- `src/lib/agents/types.ts` (widened union + helpers)
- `src/routes/+page.svelte` + `src/app.css` (status UI/colors)
- `src/routes/api/agents/[id]/+server.ts` (action endpoints)
- `scripts/test-status-inference.mjs` (new deterministic self-test)
- `docs/opencode-liveness-phase2.md` (new Phase-2 design)
