# Fix: session toggling to idle during active text generation

## What changed

1. **`src/lib/agents/opencode.ts`** — Core fix:
   - Added `RECENT_ENRICHMENT_WINDOW_MS = 2 * 60 * 1000` constant.
   - Added `recentlyActive` enrichment gate condition (considering both session-row and cached part time) so sessions streaming tokens without session-row updates stay enriched.
   - Moved `parsed` resolution above `lastActivity` computation in `getSessionsViaAPIStatusFirst`.
   - Derived `lastActivity` from `max(sessionActivityMs, partActivityMs)` instead of session-row time alone.
   - Exported `computeApiFirstLastActivityMs` pure helper used by both pipeline and tests.
   - Pipeline now calls the helper (canonical code path).

2. **`scripts/dump-sessions.mjs`** — Added `--endpoint <url>` and `--auth user:pass` flags for querying a running dashboard's `/api/status/diagnose` without compiling the pipeline.

3. **`scripts/test-api-first-activity.mjs`** — New test file (15 tests) covering the pure helper: within-grace, stale-session-with-recent-parts, boundary at WORKING_GRACE_MS, clock skew clamping, equal timestamps, both-old, no-parts fallback.

4. **`run_tests.sh`** — Wired in the new test.

## What we learned

- The root cause was that `lastActivity` in the API-first path used only session-row `time.updated`, which advances on discrete `session.updated` events — not on every streamed token. During pure text/reasoning generation there's no `running` tool part, so the 10s grace window expired and the session decayed to `idle`.
- Two review passes caught important issues:
  - Pass 1: `recentlyActive` enrichment gate was guarded by `!cached`, creating a blind spot for the exact scenario this fix targets. Fixed by removing the `!cached` guard.
  - Pass 2: `recentlyActive` used session-row time only, so a session streaming for >2min without a session-row update wouldn't be re-enriched. Fixed by also considering cached part time.
- The helper/pipeline code path was diverging after review fix 1; unified by having the pipeline call the helper.

## Verification

- `npm run check` — 0 errors, 0 warnings
- `npm run build` — builds successfully
- All 7 test scripts pass (41 + 16 + 20 + 7 + 26 + 15 + API property check)
