# Agent Status Resolution — Reference Comparison

> **Purpose.** Documentation-only comparison of how the working reference
> implementation (`reference/opencode-multiplexer`) resolves live agent sessions
> and their status, versus how this dashboard does it. Use this as the baseline
> design note when planning a refactor. Every behavioral claim is cited to a
> local file and line number.

This document is descriptive and comparative. It does not prescribe a concrete
implementation. It records the product decisions that constrain future work at
the end.

---

## 1. Reference implementation: `reference/opencode-multiplexer`

The reference is OpenCode-only. Its status model is intentionally small:
`working | needs-input | idle | error`
(`reference/opencode-multiplexer/src/store.ts:6-10`).

### 1.1 Session discovery is process-first

The reference starts from **live OS processes**, then resolves sessions. This is
the central design choice and the reason it does not drop live-but-idle
sessions.

- It inspects OS processes with `ps -eo pid,args`
  (`reference/opencode-multiplexer/src/poller.ts:78`) and matches:
  - TUI processes: `opencode` or wrapper-invoked (`node|bun|deno .../opencode`),
    optionally with `-s <sessionId>`
    (`reference/opencode-multiplexer/src/poller.ts:95`).
  - Serve processes: `opencode serve ... --port <port>`
    (`reference/opencode-multiplexer/src/poller.ts:106`).
- It resolves each process's CWD cross-platform via Linux `/proc/<pid>/cwd` or
  macOS `lsof`
  (`reference/opencode-multiplexer/src/poller.ts:53-69`).
- It maps each CWD to the **most specific** OpenCode project worktree from the
  SQLite `project` table, preferring longer path matches
  (`reference/opencode-multiplexer/src/poller.ts:136-153`).

### 1.2 Session resolution per process

Once a process is known, it is resolved to exactly one session
(`reference/opencode-multiplexer/src/poller.ts:191-254`):

- If the process carried `-s <sessionId>`, that explicit session id is used.
- Otherwise (flagless TUI), the Nth most-recent **top-level** session for that
  project is assigned to the Nth flagless process in that project
  (`reference/opencode-multiplexer/src/poller.ts:213-220`,
  `reference/opencode-multiplexer/src/db/reader.ts:189-221`). This prevents two
  flagless processes in the same directory from collapsing onto the same session.
- Duplicate session ids across processes are deduplicated
  (`reference/opencode-multiplexer/src/poller.ts:223-225`).

### 1.3 Serve-process expansion

A single `opencode serve` process can host multiple sessions. The reference
queries each discovered serve port for additional sessions
(`reference/opencode-multiplexer/src/poller.ts:256-298`):

- `GET http://localhost:<port>/session` returns all sessions for that instance.
- Sessions older than 24 hours are dropped
  (`reference/opencode-multiplexer/src/poller.ts:164-184`).
- Only top-level sessions are eligible
  (`reference/opencode-multiplexer/src/db/reader.ts:488-496`).
- A session is included if it is managed by ocmux **or** currently
  `working`/`needs-input` (`reference/opencode-multiplexer/src/poller.ts:268`).

### 1.4 Status inference from SQLite

Status is derived purely from the SQLite database in `getSessionStatus()`
(`reference/opencode-multiplexer/src/db/reader.ts:223-295`), in this order:

1. `needs-input` — the latest message has a running `question` or `plan_exit`
   tool part (`reference/opencode-multiplexer/src/db/reader.ts:226-241`). The
   blocking tool names are centralized as `NEEDS_INPUT_TOOLS`
   (`reference/opencode-multiplexer/src/db/reader.ts:10`).
2. `needs-input` (bubble) — any **direct child** session has a running
   `question`/`plan_exit` tool part
   (`reference/opencode-multiplexer/src/db/reader.ts:243-258`). This makes a
   parent card reflect a subagent that is asking the user something.
3. `error` — the latest message has any tool part with
   `state.status = 'error'`
   (`reference/opencode-multiplexer/src/db/reader.ts:260-273`).
4. `working` — the latest message is an incomplete assistant message
   (`time.completed IS NULL`) **or** the latest message is from the user
   (`reference/opencode-multiplexer/src/db/reader.ts:275-291`).
5. `idle` — otherwise. There is no separate `complete` status; a finished
   assistant turn is `idle`
   (`reference/opencode-multiplexer/src/db/reader.ts:287-294`).

Status priority for sorting is: `needs-input` > `error` > `working` > `idle`
(`reference/opencode-multiplexer/src/poller.ts:124-129`,
`reference/opencode-multiplexer/src/views/dashboard.tsx:33-38`).

### 1.5 What the reference does NOT use for status

- It does not call `/session/status`, `/permission`, or `/question` for status
  classification. Those endpoints are not part of the dashboard/poller path.
- `/question` is used only later, in the conversation view, to **answer** a
  question that was already detected from the DB
  (`reference/opencode-multiplexer/src/views/conversation.tsx:900-928`).

### 1.6 Child sessions and tree rendering

- Broad top-level queries exclude archived and child sessions
  (`reference/opencode-multiplexer/src/db/reader.ts:140-177`,
  `reference/opencode-multiplexer/src/db/reader.ts:189-221`).
- Children are loaded on demand per expanded parent
  (`reference/opencode-multiplexer/src/db/reader.ts:500-533`,
  `reference/opencode-multiplexer/src/poller.ts:317-342`).
- Running questions from direct children are surfaced both as parent
  `needs-input` (§1.4) and as inline prompts in the conversation view
  (`reference/opencode-multiplexer/src/db/reader.ts:539-600`,
  `reference/opencode-multiplexer/src/views/display-lines.ts:137-153`).

---

## 2. Dashboard implementation: this repository

The dashboard is multi-agent: OpenCode, Claude, Codex, Gemini
(`src/lib/agents/types.ts:1`). Its status model is richer:
`working | blocked | blocked_permission | blocked_question | blocked_review |
complete | idle | retry` (`src/lib/agents/types.ts:8-16`).

### 2.1 Aggregation and visibility

- `getAllSessions()` calls each agent adapter, records status transitions,
  applies visibility windows, and sorts by last activity
  (`src/lib/agents/index.ts:58-87`).
- A session is kept visible only if **any** of these hold
  (`src/lib/agents/index.ts:69-84`):
  - it has `pid` set,
  - it has `isActiveInstance` set,
  - it was active within the last 10 minutes,
  - it is `retry` and active within 2 hours,
  - it is blocked and active within 2 hours,
  - it is `complete` and active within 30 minutes.

### 2.2 OpenCode adapter: API/SQLite hybrid

- It checks API reachability via `GET /session`
  (`src/lib/agents/opencode.ts:232-245`).
- It fetches live `/session/status` once per refresh
  (`src/lib/agents/opencode.ts:247-262`).
- It fetches live `/permission` and `/question`, treating them as the only
  reliable blocking signals
  (`src/lib/agents/opencode.ts:264-306`).
- It fetches `/path` for **positive-only** instance liveness
  (`src/lib/agents/opencode.ts:308-351`).
- It prefers SQLite if configured and returns it if non-empty; otherwise it
  falls back to the API
  (`src/lib/agents/opencode.ts:606-624`).

### 2.3 OpenCode SQLite inventory

- The SQLite path reads the last 50 sessions by `time_updated`
  (`src/lib/agents/opencode.ts:510-515`), including `parent_id` so the UI can
  build a tree.
- Unlike the reference's top-level queries, this query does **not** filter
  `time_archived IS NULL`, and the fixed `LIMIT 50` can exclude an older
  process-backed session that is still live.

### 2.4 OpenCode status inference

Status inference is centralized in pure, unit-testable functions
(`src/lib/status/inference.ts:44-104`, `src/lib/status/inference.ts:118-157`):

- `blocked_permission` from a live `/permission` entry
  (`src/lib/status/inference.ts:132`).
- `blocked_question` from a live `/question` entry, with a durable fallback
  when an active `question` tool part exists
  (`src/lib/status/inference.ts:133`, `src/lib/status/inference.ts:138`).
- `blocked_review` from an active `submit_plan` tool part, with no staleness
  cutoff because plan reviews can last up to 96 hours
  (`src/lib/status/inference.ts:135`).
- `retry` from `/session/status` (`src/lib/status/inference.ts:141`).
- `working` from `/session/status = busy`, an active non-blocking tool, or a
  10-second recent-activity grace (`src/lib/status/inference.ts:144-147`,
  `src/lib/status/inference.ts:155`).
- `complete` for a natural `step-finish.reason = 'stop'` within 5 minutes, then
  `idle` (`src/lib/status/inference.ts:150-152`).

Tool-activity detection defends against stale `running` parts by checking for a
later terminal part with the same `callID` and for a later natural stop
(`src/lib/status/inference.ts:40-104`).

### 2.5 Liveness handling

- OpenCode liveness is **positive-only**: busy/retry implies alive, or a
  matching `/path` directory implies alive; otherwise liveness is left
  **undefined**, never set to `false`
  (`src/lib/agents/opencode.ts:353-365`).
- Crucially, `getAllSessions()` does **not** use `instanceAlive === true` as a
  keep-visible criterion
  (`src/lib/agents/index.ts:74-84`). It only keeps `pid` or `isActiveInstance`,
  and `isActiveInstance` only reflects `/session/status` busy/retry membership
  (`src/lib/agents/opencode.ts:397`, `src/lib/agents/opencode.ts:533`).

### 2.6 Hierarchy and non-OpenCode agents

- Parent/child relationships are rendered in the UI via `parentId`
  (`src/routes/+page.svelte:63-88`), but the backend does **not** recompute
  parent status from child status.
- Claude, Codex, and Gemini adapters use heuristic process/history parsing plus
  regex/recency status classification
  (`src/lib/status/patterns.ts:108-141`, `src/lib/agents/claude.ts:82-138`,
  `src/lib/agents/codex.ts:253-330`, `src/lib/agents/gemini.ts:80-121`).

---

## 3. Gap Analysis: Why This Dashboard Can Miss Sessions

This section is the reason the comparison was requested. Each gap below can
cause a genuinely live session to be absent from the dashboard, or to show the
wrong status.

### 3.1 No OpenCode OS process inventory

The reference starts from actual `opencode` processes
(`reference/opencode-multiplexer/src/poller.ts:76-122`). This dashboard starts
from DB/API sessions
(`src/lib/agents/opencode.ts:510-515`, `src/lib/agents/opencode.ts:367-497`).
A live session that is older than the last 50 DB rows, outside the recency
windows in §2.1, or served by another port can be dropped entirely.

### 3.2 No flagless TUI mapping

The reference maps flagless OpenCode processes to the Nth most-recent top-level
session per project
(`reference/opencode-multiplexer/src/poller.ts:213-220`). This dashboard has no
equivalent, so a live idle flagless TUI becomes invisible once it ages out of
the 10-minute recency window (`src/lib/agents/index.ts:78`).

### 3.3 Single configured `apiBase`

The reference discovers every `opencode serve --port <port>` process and queries
each port (`reference/opencode-multiplexer/src/poller.ts:106-114`,
`reference/opencode-multiplexer/src/poller.ts:256-298`). This dashboard queries
only the one configured `apiBase` (`src/lib/agents/opencode.ts:588-591`), so
sessions hosted by other serve processes are not first-class.

### 3.4 Liveness is computed but not used for visibility

This dashboard computes `instanceAlive` (`src/lib/agents/opencode.ts:353-365`),
but `getAllSessions()` does not keep a session visible on the basis of
`instanceAlive === true` (`src/lib/agents/index.ts:74-84`). The only live-backed
keep-visible signals it honors are `pid` (which OpenCode sessions generally do
not carry) and `isActiveInstance` (which only means busy/retry membership, not
idle-but-live).

### 3.5 Fixed SQLite `LIMIT 50` without archived filtering

The SQLite inventory query (`src/lib/agents/opencode.ts:510-515`) has a global
`LIMIT 50` and no `WHERE time_archived IS NULL`. A live process-backed session
older than the 50 most-recently-updated rows can be excluded, and archived
sessions can consume the limited capacity. The reference avoids this class by
resolving from live processes first and filtering archived rows at the source
(`reference/opencode-multiplexer/src/db/reader.ts:140-177`).

### 3.6 Hierarchical blocking mismatch

The reference escalates direct child `question`/`plan_exit` blocks to the parent
as `needs-input` (`reference/opencode-multiplexer/src/db/reader.ts:243-258`).
This dashboard leaves the parent status unchanged even when a descendant
requires human input
(`src/lib/agents/index.ts:58-87`, `src/routes/+page.svelte:63-88`).

### 3.7 No first-class `error` status

The reference has a first-class `error` state derived from tool parts with
`state.status = 'error'`
(`reference/opencode-multiplexer/src/db/reader.ts:260-273`,
`reference/opencode-multiplexer/src/store.ts:6-10`). This dashboard's
`AgentStatus` union has no `error` variant
(`src/lib/agents/types.ts:8-16`), so failed tool states cannot be counted or
surfaced as a status category.

### 3.8 Plan-review tool-name mismatch risk

The reference treats `plan_exit` as a needs-input tool
(`reference/opencode-multiplexer/src/db/reader.ts:10`). This dashboard treats
`submit_plan` as the review-blocking tool
(`src/lib/status/inference.ts:135`). If both names appear in local data (for
example, across plugin versions), the dashboard can miss some plan-review waits.

### 3.9 Status model vocabulary differences (summary)

| Dimension | Reference | Dashboard |
|---|---|---|
| Discovery entry point | Live OS processes | DB/API session inventory |
| Live-but-idle retention | Process-backed ⇒ visible | Recency windows only |
| Serve ports | All discovered ports | Single configured `apiBase` |
| `complete` | None (finished = `idle`) | 5-minute fresh window, then `idle` |
| `error` | First-class | Not present |
| Blocked hierarchy | Bubbles to parent | Parent unchanged |
| Blocking detection | Persisted tool parts (`question`, `plan_exit`) | Live `/permission`, `/question`, plus `submit_plan`/`question` tool fallback |
| Stale-tool guard | Not applicable (uses latest message) | `callID` terminal + natural-stop scoping |

---

## 4. Product Decisions Affecting Future Refactor Planning

These decisions constrain future implementation work. They are recorded here so
future plans do not need to re-derive them.

1. **Only sessions with a live backing process should be visible.** The target
   behavior is the reference's process-first model, not "all recent sessions."
   Recency windows alone are insufficient because a live process can be idle
   longer than any window.

2. **Hierarchical blocking is required.** If any session in a hierarchy is
   blocked waiting on human input, the entire tree should qualify as blocked.
   This matches the reference's child-to-parent bubble
   (`reference/opencode-multiplexer/src/db/reader.ts:243-258`) and extends it to
   the whole tree, not only direct children.

3. **Tool errors must be first-class status information.** The dashboard should
   be able to count and surface failed tool states the way the reference surfaces
   `error` (`reference/opencode-multiplexer/src/db/reader.ts:260-273`).
