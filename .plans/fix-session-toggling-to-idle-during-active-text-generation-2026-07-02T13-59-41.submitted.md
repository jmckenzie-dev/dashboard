---
submitted-at: "2026-07-02T13:59:41.429Z"
title: "Fix: session toggling to idle during active text generation"
auto-captured: true
---
# Fix: session toggling to idle during active text generation

Goal: Stop the dashboard from flipping a session (e.g. "Plannotator dashboard shim
connection issues") to `idle` while its model is actively decoding/generating text.

> Plan file: `.plans/fix-idle-during-text-generation.md` (feedback integrated
> in place).

## Direct answers to the reported questions

1. **Is there timer-based state transition logic?** Yes. In the API-first path a
   session that is not `busy` on the queried API and has no active tool part
   decays to `idle` once `lastActivityMs >= WORKING_GRACE_MS` (10s):
   - `apiStatusFromSignals` (`src/lib/agents/opencode.ts:384-394`) → `idle` when
     `sessionStatus` is not `busy`/`retry`.
   - `applyReviewErrorEnrichment` (`src/lib/agents/opencode.ts:396-417`) only
     upgrades idle→working on an active tool OR `lastActivityMs < WORKING_GRACE_MS`.
   - `WORKING_GRACE_MS = 10_000` (`src/lib/status/inference.ts:42`).

2. **Can the API report idle while the model is generating?** Yes, in two ways:
   - **Scoping:** `/session/status` only ever contains `busy`/`retry` entries for
     the ONE instance behind `apiBase` (`docs/opencode-session-status.md` Truth
     #2). Absence ⇒ idle OR owned by a different/dead instance —
     indistinguishable. If the generating session is driven by a different
     opencode process/port than `apiBase`, it will never show `busy`.
   - **Timer basis:** `lastActivityMs` in the API-first path is derived from the
     SESSION row `time.updated` (`opencode.ts:846-847`), which advances on
     `session.updated` events, not on every streamed token. Between those events
     the 10s window can expire → status decays to `idle` even though parts are
     actively streaming.

## Current State

- Primary snapshot path: `getSessionsViaAPIStatusFirst`
  (`src/lib/agents/opencode.ts:808-941`).
- For each session, `lastActivity = toDate(max(session.time.created,
  session.time.updated))` — session-row based only (`opencode.ts:846-847`).
- Enrichment (fresh SQLite part read) refresh is gated on
  `busyWithoutApiBlock || changedSinceEnrichment || needsBootstrap ||
  (!cached && hasDirectLiveSignal)` (`opencode.ts:836`). `changedSinceEnrichment`
  compares cached vs roster **session-row** activity (`opencode.ts:832`), so if
  the session row isn't ticking, enrichment (and thus the parsed `latestTool`)
  goes stale.
- The pure part-level activity is already computed — `ParsedPartData.lastPartTime`
  (`opencode.ts:344-382`, from `partActivityTime = max(time_created,
  time_updated)`) — but is **unused** for `lastActivity` in the API-first path.
- During pure text/reasoning generation there is no `running` tool part
  (`analyzeParts` marks the latest tool inactive once a `step-finish`/terminal
  part lands, `src/lib/status/inference.ts:48-136`), so the only things that can
  hold `working` are `sessionStatus==='busy'` or the 10s grace window.

## Assumptions

- `apiBase = host.containers.internal:4096` (config), falls back to
  `127.0.0.1:4096`. The generating session is reachable by this API (i.e. the
  scoping gap is not the sole cause) — to be confirmed in Step 1.
- `/session/status` reports `busy` for the agent loop, which includes text
  generation on the SAME instance (doc Q1: busy = "agent loop running"). If the
  Step-1 diagnostic shows it flapping busy/idle mid-generation, that is server
  behavior and Step 2 (part-time-based activity) is the real fix.
- Part times in the DB may be seconds or ms; `toEpochMs` (module-level,
  `opencode.ts:213`) must be applied to `lastPartTime` before comparing.

## Recommended Plan

### Step 1 — Diagnose to confirm root cause (gated)
Run the changed code in an isolated test dashboard and inspect the real pipeline
state from it:

1. Extend `scripts/dump-sessions.mjs` with an endpoint mode (if not already
   present): `--endpoint <base-url>` (and `--auth user:pass` when the dashboard
   has a password hash) that GETs `/api/status/diagnose`
   (`src/routes/api/status/diagnose/+server.ts`) from a RUNNING dashboard
   instead of compiling+requiring the pipeline. This lets you dump/debug the
   test dashboard's view directly (including its isolated config) and avoids the
   standalone `tsc` compile path entirely.
2. Launch the test dashboard against the real opencode data:
   `./start_test_dashboard.sh --use-prod-config` (builds current branch, picks a
   free port ≥50001, prints URL/PID). `--use-prod-config` so it sees the real
   `apiBase`/`dbPath`.
3. While the target session is actively generating, sample repeatedly (3–4× over
   ~20s): `node scripts/dump-sessions.mjs --endpoint http://127.0.0.1:<port>
   --session "Plannotator" --json --no-parts`. Per tick inspect:
   `sessionStatus`, `lastActivityMs`, `latestTool.active`, `livenessReason`, and
   whether `text`/`reasoning` `parts` arrive with advancing time.
4. Empirically determine whether the **session row** `time.updated` advances
   during streaming (sample the `/session` roster `time.updated`, or compare DB
   `session.time_updated` vs newest `part.time_created` during a known decode):
   - advancing per-token/per-message ⇒ `changedSinceEnrichment` already fires
     and Step 3 is only defensive.
   - advances only on discrete `session.updated` events with long gaps ⇒
     Step 3 is necessary.
5. Decision matrix:
   - `sessionStatus==='busy'` but status still flips idle ⇒ pure lastActivity
     bug (Step 2 fixes it).
   - `sessionStatus` null/absent during generation while parts advance ⇒ also
     scoping/enrichment-staleness (Step 2 + Step 3 needed).
   - `lastPartTime` advancing while `lastActivityMs` large ⇒ confirms
     session-row vs part-time mismatch (Step 2).

### Step 2 — Derive lastActivity from part activity (API-first path)
File: `src/lib/agents/opencode.ts`, `getSessionsViaAPIStatusFirst` (~line 845).
- Move the `parsed` resolution (currently ~line 853) ABOVE the `lastActivity`
  computation (currently ~line 846).
- Compute lastActivity from the max of session-row time and part time:
  ```ts
  const sessionActivityMs = toEpochMs(
    Math.max(session.time.created ?? 0, session.time.updated ?? 0),
  );
  const partActivityMs = toEpochMs(parsed?.lastPartTime ?? 0);
  const lastActivity = toDate(Math.max(sessionActivityMs, partActivityMs));
  const lastActivityMs = Date.now() - lastActivity.getTime();
  ```
- `toEpochMs` is module-level (`opencode.ts:213`) and already normalizes
  seconds/ms; applying it to `lastPartTime` is required because `lastPartTime`
  holds raw DB time values (`partActivityTime`, `opencode.ts:237-239`).
- This `lastActivity` already feeds the `AgentSession.lastActivity` field and the
  liveness candidate (`opencode.ts:882,898`); using part time there is strictly
  more accurate and low-risk.
- Net effect: the 10s grace window now tracks streaming parts, so a session
  actively emitting `text`/`reasoning` parts stays `working` instead of decaying.

### Step 3 — Keep enrichment fresh for recently-active sessions
File: `src/lib/agents/opencode.ts`, enrichment-target loop (~line 824-839).
- Add `const RECENT_ENRICHMENT_WINDOW_MS = 2 * 60 * 1000;` near the other limit
  constants (e.g. ~line 247).
- In the per-session gate, add: if `Date.now() - sessionActivityMs <
  RECENT_ENRICHMENT_WINDOW_MS`, treat as an enrichment target even when not
  `busy`. This keeps `parsed.lastPartTime` and `latestTool` current during
  generation when the session row updates slowly.
- Cost guard: bounded by existing `API_ENRICHMENT_PART_LIMIT`
  (12 parts/session) and restricted to recently-touched sessions only.

### Step 4 — Self-test coverage
- Extract the activity computation into a tiny pure helper, e.g.
  `computeApiFirstLastActivityMs(sessionTimeMs, partTimeMs, now)` (pure, no I/O),
  and unit-test it. Add to `scripts/test-optimize-poller.mjs` (or a new
  `scripts/test-api-first-activity.mjs` compiled the same way):
  - session-row older than 10s but part within 2s ⇒ within grace (working-grade).
  - both old ⇒ idle-grade.
- Add a regression case mirroring the report: latest part `text`, latest tool
  `completed`/inactive, part activity < `WORKING_GRACE_MS` ⇒ NOT idle.
- Wire any new script into `run_tests.sh`.

## Validation Plan

- `npm run check` (typecheck + svelte diagnostics) — must pass.
- `npm run build` — must succeed.
- Launch via `./start_test_dashboard.sh --use-prod-config` (do NOT use
  `restart_dashboard.sh`); it builds the branch and runs an isolated test
  instance on a free port. Use the dump script's new `--endpoint` mode to
  inspect the test instance's state.
- `bash run_tests.sh` — all self-tests green (status inference, liveness,
  optimize-poller, visibility hysteresis, process poller).
- Reproduce: with the target session actively generating, poll the test
  dashboard's `GET /api/status/diagnose` (via `dump-sessions.mjs --endpoint …`)
  every few seconds for ~30s.
  - **Pass:** the session holds `status: working` (phase `generating`) and never
    flips to `idle` while parts/`lastPartTime` advance within `WORKING_GRACE_MS`.
  - **Fail:** any idle transition while a new part arrived in the last 10s.

## Risks and Mitigations

- **Enrichment refresh cost:** mitigated by per-session part limit + restricting
  the widened refresh to sessions updated within ~120s.
- **Clock-unit skew (s vs ms):** apply `toEpochMs` to both inputs consistently.
- **Over-showing stale sessions as working:** Step 2 only helps when parts are
  genuinely recent (<10s); older gaps still decay to idle correctly.
- **Multi-instance blindspot remains (doc Truth #2):** Steps 2–3 reduce
  false-idle on the queried instance but cannot manufacture `busy` for a session
  on another instance. That is a larger, separate effort (process-session
  matching already partially compensates via `cwd_allocated`/`process_session_id`).

## Open Questions

- Does `/session/status` report `busy` continuously during text generation on the
  same instance, or does it flap? Step 1 answers this; if it flaps, Step 2 is the
  definitive fix regardless.
- (Resolved during implementation) Whether the session row `time.updated`
  advances during streaming is determined empirically in Step 1.4 and decides
  whether Step 3 is strictly necessary or just defensive.
