# Fix: Session Visibility Toggle (bigcodebench session flickering in/out)

## Goal
Goal: Stop the "Debug bigcodebench smoke test failures and performance tuning"
opencode session (and any actively-worked session) from repeatedly toggling
between visible and invisible in the dashboard. Visibility must be stable
across polls for sessions attached to a live instance, while genuinely
stale/superseded sessions still hide.

## Current State
- SSE drives the UI. `src/routes/api/events/+server.ts:23` runs
  `setInterval(getAllSessions, config.polling.intervalMs)`. The frontend
  replaces the whole session list on every `update` event
  (`src/routes/+page.svelte:144-152`).
- Live config: `~/.config/ai-dashboard/dashboard.toml` has
  `polling.intervalMs = 500`. (Default in `src/lib/config.ts:34` is 3000.)
- opencode runs as a **flagless TUI** (`/proc/2/cmdline` = bare `opencode`,
  no `-s`, not `serve`; cwd = dashboard dir). Consequences, verified from code:
  - `scanProcesses()` (`src/lib/process/poller.ts:222`) yields NO
    `directSessionIds`, so the `process_session_id` liveness signal is
    unavailable for every session.
  - `cwd_allocated` only reaches sessions whose directory matches a process cwd
    (the dashboard dir), NOT the bigcodebench project dir.
- Liveness allocation (`src/lib/agents/opencode-liveness.ts`):
  - `hasOpenCodeStatusLiveness()` (line 12) returns true ONLY for
    `busy`/`retry`. **`idle` is not counted as liveness** (asserted at
    `scripts/test-opencode-liveness.mjs:109`).
  - `RECENT_ACTIVE_FALLBACK_MS = 30_000` (line 3). Between turns, with no
    `status_map`/`process_session_id`/`cwd_allocated`, a session is visible
    only while `lastActivity` is within 30s.
- Visibility is applied in two layers: `applyLivenessDecisions`
  (`src/lib/agents/opencode.ts:389-415`, filters `hidden_stale` when
  `includeHidden=false`) and `isVisibleOpenCodeSession`
  (`src/lib/agents/index.ts:21-35`).

## Root Cause
1. **Primary (semantic):** An actively-worked session attached to a live
   instance loses every durable liveness signal whenever the instance reports
   `idle` between turns: `idle` is not liveness, the flagless TUI gives no
   `process_session_id`, and its cwd belongs to a different project so
   `cwd_allocated` never applies. Visibility then depends solely on
   `recent_active_fallback` (30s). Debug/smoke-test work produces bursts of
   part writes separated by >30s gaps (model thinking, test runs), so
   `lastActivity` repeatedly crosses the 30s boundary: the session flips to
   `hidden_stale`, then back to visible on the next part. At 500ms polling the
   user sees this as rapid, repeated toggling.
2. **Amplifier (engine):** `/api/events` uses `setInterval` at 500ms regardless
   of whether the previous tick finished, so slow ticks overlap and each emits
   a different snapshot. `checkAPIServer` has a 1s AbortController timeout, but
   `getSessionStatusData` and `getBlockingRequests` (`src/lib/agents/opencode.ts`)
   have NO timeout; under load a tick can observe `apiAvailable=false` (or hang),
   zeroing `statusData`/`blocking` for that tick so any `status_map`/
   `blocking_request` session flips hidden for one tick. This is also the cause
   of TODO #1 ("Updating is very slow").

## Assumptions
- We may add a small amount of server-side in-memory state (hysteresis cache)
  in the dashboard Node process; it is per-process, bounded, and acceptable.
- The 500ms interval is intentional for responsiveness; we keep responsiveness
  but make ticks non-overlapping and cheap rather than raising the floor.
- We do NOT change opencode upstream semantics; `idle` in `/session/status`
  remains "not proof of activity" — we smooth over gaps with hysteresis rather
  than reclassifying idle (which previously caused stale-idle visibility).

## Recommended Plan

### Step 1 — Add a pure, testable visibility-hysteresis module
Create `src/lib/agents/visibility-hysteresis.ts` (type-only imports only, so it
can be compiled standalone and tested like `opencode-liveness.ts`).
- Export `VISIBILITY_GRACE_MS` (default `90_000`) and `MAX_TRACKED_VISIBLE`
  (default `200`).
- Export `computeVisibleSessions(args)`:
  - Input: `candidates: Array<{ id, visibilityReason?, livenessReason?,
    instanceAlive?, ... }>` (the full OpenCode set incl. hidden), the previous
    `visibleUntil: Map<id, ms>` snapshot, and `now`.
  - Logic:
    - A session is "directly visible this tick" if its effective reason
      (`visibilityReason ?? livenessReason`) is anything other than
      `hidden_stale` (mirrors `isVisibleOpenCodeSession`).
    - If directly visible → include it and set `visibleUntil[id] = now +
      VISIBILITY_GRACE_MS`.
    - Else if `visibleUntil[id] > now` → include it (hysteresis; carry over the
      existing reasons so the UI still shows last-known status) but do NOT
      extend the deadline.
    - Else → exclude it and delete `visibleUntil[id]`.
  - Eviction: after the pass, if the map exceeds `MAX_TRACKED_VISIBLE`, drop
    entries not present in the current candidate set (LRU-ish by deadline).
  - Return `{ visible: AgentSession[], visibleUntil: Map<id, number> }`.
- Keep it pure (no `Date.now()` inside; `now` is a parameter) for determinism.

Touch: `src/lib/agents/visibility-hysteresis.ts` (new).

### Step 2 — Wire hysteresis into getAllSessions
In `src/lib/agents/index.ts`:
- Add module-level state: `let visibleUntil = new Map<string, number>();`
- In `getAllSessions()`:
  - Fetch the full candidate set: `const opencode = await getOpenCodeSessions(
    { includeHidden: true });` (so hidden candidates reach the hysteresis
    layer). Keep `applyHierarchicalBlocking(all)` BEFORE visibility so blocked
    parents bubble correctly.
  - Replace the current `all.filter(isVisibleOpenCodeSession)` for opencode
    with `computeVisibleSessions({ candidates: all, visibleUntil, now:
    Date.now() })`, assigning the returned map back to `visibleUntil`.
  - Keep generic-agent filtering (`isVisibleGenericSession`) unchanged.
- `isVisibleOpenCodeSession` stays as the per-session predicate used inside the
  pure module's "directly visible" test (export/reuse it from the pure module to
  avoid duplication: have the pure module accept an `isDirectlyVisible`
  predicate, or replicate the small rule). Prefer passing the predicate so the
  pure module has zero dependency on `index.ts`.

Touch: `src/lib/agents/index.ts`.

### Step 3 — Harden the SSE poll loop (non-overlapping ticks)
In `src/routes/api/events/+server.ts`:
- Replace `setInterval(async () => {…}, intervalMs)` with a self-scheduling
  `scheduleNext()` that `await`s the poll before setting the next `setTimeout`.
  Guarantee no overlap: a tick never starts until the previous fully settles.
- Keep the keepalive on its own interval.
- Ensure `abort` cleanup clears the pending timeout.

Touch: `src/routes/api/events/+server.ts`.

### Step 4 — Add timeouts to the unbounded OpenCode fetches
In `src/lib/agents/opencode.ts`:
- `getSessionStatusData` (line 277): wrap the `fetch` in an `AbortController`
  with a bounded timeout (reuse the existing 1000ms pattern from
  `checkAPIServer`).
- `getBlockingRequests` (line 297): bound the `Promise.all` fetches with the
  same timeout via `AbortController` on each request.
- On timeout, return the empty defaults already used on error (no behavior
  change except bounded latency).

Touch: `src/lib/agents/opencode.ts`.

### Step 5 — (Optional, recommended) Small TTL cache for hot signals
Add a tiny process-wide cache so 500ms ticks don't re-scan/re-fetch every time:
- `scanProcesses()` result cached ~1000ms in `src/lib/process/poller.ts`
  (shortest interval is 500ms; 1s cache halves process-scan + `/proc` read load).
- Keep it minimal and TTL-based; document the TTL. (Defer if Step 1-4 already
  resolve the flicker in validation.)

Touch: `src/lib/process/poller.ts` (optional).

### Step 6 — Tests
- Add `scripts/test-visibility-hysteresis.mjs` mirroring
  `scripts/test-opencode-liveness.mjs` (compile the pure module with `tsc`, run
  under node, log to `./logs`). Cover:
  1. Directly-visible session stays visible and refreshes its deadline.
  2. Session that drops to `hidden_stale` stays visible for `<= GRACE` ms then
     disappears on the next tick after the deadline.
  3. Once hidden past grace, a tick does NOT resurrect it absent a new signal.
  4. Map is bounded: over `MAX_TRACKED_VISIBLE` distinct ids, stale entries are
     evicted.
  5. Determinism: fixed `now` + fixed inputs ⇒ identical output (property sweep).
- Keep the existing `scripts/test-opencode-liveness.mjs` green (no change to
  allocation semantics).

Touch: `scripts/test-visibility-hysteresis.mjs` (new); `run_tests.sh` (wire it
in per repo convention).

### Step 7 — Config quick-mitigation (immediate, independent of code)
Until the code lands, the user can stop the visible flicker instantly by raising
`polling.intervalMs` in `~/.config/ai-dashboard/dashboard.toml` to `2000`–`3000`
and restarting the dashboard (`./restart_dashboard.sh`). This does not fix the
30s-boundary root cause but materially reduces the toggle frequency and tick
overlap. (Document only — not a code change.)

## Validation Plan
- `npm run check` (type/svelte diagnostics) — must pass.
- `npm run build` — must pass.
- `node scripts/test-opencode-liveness.mjs` — must pass (regression).
- `node scripts/test-visibility-hysteresis.mjs` — must pass.
- `./run_tests.sh` — green.
- Restart service: `./restart_dashboard.sh`.
- Live check via `/api/status/diagnose` (no auth in this config): capture two
  snapshots ~1s apart; the bigcodebench session's `visible`/`visibilityReason`
  must be STABLE (no `hidden_stale` flip) while the instance is attached, even
  when it reports `idle`. Pass = stable across >=10 consecutive snapshots.
- Negative check: an old, non-attached session (last activity > grace window,
  no liveness signal) must still go and stay hidden after the grace window.
- Watch the SSE stream for ~30s during active bigcodebench work: the session id
  must be continuously present (no dropouts). Pass = zero visibility dropouts.
- Confirm no concurrent tick overlap: during a deliberately slow opencode API
  response, dashboard updates remain eventual and consistent (no A/B snapshot
  flicker).

## Risks and Mitigations
- **Lingering superseded sessions (the `/new` stale-argv case).** Hysteresis
  extends visibility by up to `VISIBILITY_GRACE_MS` for a superseded errored
  session before it hides. Mitigation: grace is short (90s) vs the prior
  indefinite-stuck bug; the existing `process_session_id` suppression still
  applies, so after grace it hides for good. Add a regression case for this.
- **In-memory state across restarts.** `visibleUntil` resets on dashboard
  restart; first tick re-derives from real signals. Acceptable (no persistence
  needed).
- **Threading the predicate into the pure module.** Keep the pure module
  dependency-free by injecting `isDirectlyVisible(session)`; avoid importing
  `index.ts` (which has side-effects) into the testable module.
- **Tick latency vs interval.** Non-overlapping loop means effective cadence =
  max(intervalMs, tickLatency). If tick latency is high, updates slow down
  gracefully rather than corrupting each other. Step 4/5 keep tick latency low.
- **Cache staleness (Step 5).** Keep TTL <= interval floor; never cache
  blocking/status longer than ~1s so approvals/blocks still surface promptly.

## Open Questions
- Preferred grace window: 90s proposed. Acceptable, or tune (e.g. 60s)?
- Should we also treat a bounded `idle` status as weak liveness (semantic
  alternative to hysteresis)? Recommendation: NO for now (reopens a known
  stale-idle path); revisit after hysteresis lands if needed.
