# Reference comparison doc

Created `docs/reference_comparison.md`, a documentation-only comparison of
how the working reference (`reference/opencode-multiplexer`) resolves live
agent sessions/status versus how this dashboard does it.

## What changed

- Added `docs/reference_comparison.md` (320 lines, 85 cited local path/line
  references). Three cited sections: reference implementation, dashboard
  implementation, and a gap analysis framed around why this dashboard can
  miss live sessions.
- Recorded the three product decisions that constrain future refactor work:
  only sessions with a live backing process should be visible; if any session
  in a hierarchy is blocked the whole tree should be blocked; tool errors must
  be first-class status.
- No code changes. No implementation sequencing. The doc is descriptive only.

## What I learned / what failed

- The reference is process-first: it enumerates `opencode` OS processes, maps
  CWDs to projects, and assigns sessions to flagless processes by recency. This
  is the core reason it doesn't drop live-but-idle sessions, and the core gap
  in this dashboard (which starts from a DB/API inventory with recency windows).
- This dashboard computes `instanceAlive` but `getAllSessions()` never uses it
  as a keep-visible criterion (`src/lib/agents/index.ts:74-84`) — it only keeps
  `pid` (which OpenCode sessions lack) or `isActiveInstance` (busy/retry only).
- The SQLite inventory has a fixed `LIMIT 50` and no `time_archived IS NULL`
  filter (`src/lib/agents/opencode.ts:510-515`), which can hide live older
  process-backed sessions.
- Tool-name drift risk: reference checks `plan_exit`, dashboard checks
  `submit_plan`. Both should be treated as review/input-blocking.
- The LSP diagnostics emitted on write are all inside `reference/opencode-`
  `multiplexer/` (uninstalled deps: zustand, react, ink, bun:sqlite) — expected
  and irrelevant to this task.

## Verification

- Documentation-only; per approved scope, no `npm run check`/`build` run.
- Confirmed 85 local path/line citations resolve to real code.
- Confirmed a dedicated "Gap Analysis: Why This Dashboard Can Miss Sessions"
  section exists (§3).
- Confirmed the doc does not prescribe a concrete implementation.

## Key files

- `docs/reference_comparison.md` (new, documentation only)
