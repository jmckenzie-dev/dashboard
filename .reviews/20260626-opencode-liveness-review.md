# Code Review

## Verdict
REQUEST CHANGES

## Blocking gaps
- None.

## Non-blocking improvements
- [Severity: Major] `/api/status/diagnose` cannot explain hidden OpenCode sessions. Why this matters: the plan explicitly calls for liveness/visibility diagnostics, and the route comment says it should answer why a session is visible or not. Evidence: `src/routes/api/status/diagnose/+server.ts:31-35` builds diagnostics from `getAllSessions()`, while `src/lib/agents/opencode.ts:394-407` filters out `visibilityReason === 'hidden_stale'` before sessions leave the OpenCode collector. Recommended fix: add a diagnostic-only OpenCode collection path that returns all candidates with their `livenessReason`/`visibilityReason`, including `hidden_stale`, and keep the dashboard/API display path filtered.

- [Severity: Major] `status_map` liveness accepts any `/session/status` entry as live, including `idle`. Why this matters: the stated intent is to stop treating roster-like data as session liveness and only keep currently open/active OpenCode sessions. If OpenCode returns an `idle` entry in `/session/status`, this code marks that session visible forever via `status_map`, which reintroduces stale sessions through a different endpoint. Evidence: `src/lib/agents/opencode.ts:438-439` sets `hasActiveInstance` from key presence, `src/lib/agents/opencode.ts:547` passes that as `hasStatusSignal`, and `src/lib/agents/opencode-liveness.ts:22-27` treats it as a direct liveness reason. The accepted response type still includes `'idle'` at `src/lib/agents/opencode.ts:57-58`. Recommended fix: define `hasStatusSignal` as `sessionStatus === 'busy' || sessionStatus === 'retry'`, or narrow/document the response type if `/session/status` is guaranteed never to contain idle sessions.

- [Severity: Minor] Process attribution parsing has no direct regression coverage. Why this matters: process cwd/session attribution is central to the new liveness behavior, but the new liveness test only verifies allocation once candidates are already built. Evidence: `scripts/test-opencode-liveness.mjs` exercises `allocateOpenCodeLiveness()`, but `src/lib/process/poller.ts:48-145` parsing helpers and `scanProcesses()` line parsing are untested. Recommended fix: expose a small pure parser helper or test through lightweight fixtures covering `opencode -s ses_x`, `opencode --session ses_x`, `opencode serve --port 4096`, wrapper forms like `node /path/opencode`, and non-OpenCode false positives.

- [Severity: Nit] Remove stray untracked scratch output before merge. Evidence: `git status --short` shows `?? tmp_inspect.out`. Recommended fix: delete it or intentionally ignore it if it is expected local scratch data.

## Missing validations
- Add a diagnostic-route validation that proves hidden/stale OpenCode candidates are reported with `visibilityReason: 'hidden_stale'` without appearing in `/api/agents`.
- Add a liveness test for a `/session/status` entry with `type: 'idle'` so the intended behavior is locked down explicitly.
- Add process parser fixtures for direct `-s`/`--session` session attribution, serve port extraction, wrapper invocation, and non-matches.

## Concrete revision instructions
1. Split OpenCode collection into a display-filtered path and a diagnostic path, or add an `includeHidden` option that preserves hidden candidates only for `/api/status/diagnose`.
2. Change `hasStatusSignal` to only treat `busy` and `retry` as positive liveness, unless the OpenCode API guarantee is documented and enforced by a narrower type.
3. Extend `scripts/test-opencode-liveness.mjs` or add a companion script to cover status-map idle handling and process parser fixtures, then keep it wired through `run_tests.sh`.
4. Remove `tmp_inspect.out` from the worktree before merge.
