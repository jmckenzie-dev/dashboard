# OpenCode Session Status — Authoritative Reference for the Dashboard

> **Purpose.** A single source of truth for detecting the status of an
> OpenCode session from (a) the OpenCode HTTP API and (b) the backing SQLite
> database. Use this when designing/implementing/testing the dashboard's status
> inference. Every claim is cited to the OpenCode source or a live DB query.

## 0. Read this first — the five architectural truths that explain every bug

If you read nothing else, read these. They are the root cause of essentially
all non-determinism in the current dashboard logic
(`src/lib/agents/opencode.ts:159` `inferOpencodeStatus`).

1. **There is no persisted process ownership.** Nothing in the DB records which
   OS process/instance owns a session. `event_sequence.owner_id` is **NULL for
   all 267 rows** in the live DB; the `session` table has no `pid`/`owner`/
   `instance` column (only a format `version`). Every opencode instance is
   independent and shares one SQLite file. **→ You cannot answer "is the
   executable still running?" from the DB alone.**

2. **`/session/status` is an in-memory map of NON-idle sessions for ONE
   instance only.** It is built from `SessionStatus`/`SessionRunState`, both of
   which use `InstanceState` (in-memory) and **delete idle sessions from the
   map** (`packages/opencode/src/session/status.ts:81-84`). So: present in map
   ⇒ busy/retry on THIS instance; absent ⇒ idle OR owned by a
   different/dead instance. **These two cases are indistinguishable from the
   API.** This single fact is why "idle vs dead" flickers.

3. **Permission and question blocking states are EPHEMERAL — never persisted.**
   The `question.*` and permission-ask events carry no `sync` block, so by the
   persistence rule in `packages/core/src/event.ts:387` they are **never written
   to the `event` table**. The live DB `event` table contains only
   `message.part.updated.1`, `message.updated.1`, `session.updated.1`,
   `session.created.1`, `session.next.model.switched.1`,
   `session.next.agent.switched.1`. **→ A DB-only scan will NEVER see a pending
   permission or question. You must query the live API.**

4. **`submit_plan` is NOT an OpenCode built-in.** It is a plugin tool from
   **plannotator-bridge**
   (`plannotator/apps/opencode-plugin/index.ts:574-718`). It blocks by being an
   `async execute` that `await`s the review UI; the tool **part stays in
   `state.status: "running"`** the whole time. It does **not** use the Question
   or Permission systems, so it will **never** appear in `GET /question` or
   `GET /permission`. The only durable signal is the `running` tool part.

5. **There are TWO HTTP APIs served on the same port.** The legacy **v1
   "instance" API** (`/session`, `/permission`, `/question`, …) and the newer
   **v2 API** (`/api/session`, `/api/permission/request`, …) are both mounted
   (`packages/opencode/src/server/routes/instance/httpapi/api.ts:69-74`). The
   dashboard uses v1 today. **v2 has no `/session/status` equivalent** — that is
   the single most important endpoint and exists only in v1. Recommendation:
   **hybrid** (keep v1 for status; add v1/v2 permission+question lists). See §1.

---

## 1. The two API surfaces

Both are mounted together in `OpenCodeHttpApi`
(`packages/opencode/src/server/routes/instance/httpapi/api.ts:69-74`). The v2
`Api` (`@opencode-ai/server`) is also `addHttpApi`'d in, so `/api/*` routes are
live on the same server/port as the v1 instance routes.

| | v1 instance API | v2 API |
|---|---|---|
| Path prefix | none (`/session`, `/permission`) | `/api/...` |
| Source | `packages/opencode/src/server/routes/instance/httpapi/groups/*.ts` | `packages/server/src/groups/*.ts` |
| Status | `Schema.Record(string, SessionStatus.Info)` |
| Completeness | Full (session/permission/question/event/instance/project/pty/...) | Partial/experimental ("Experimental HttpApi surface for selected instance routes") |
| `/status` endpoint | **YES** (`/session/status`) | **NO** (only `wait`/events) |
| Directory routing | `x-opencode-directory` header + `WorkspaceRoutingQuery` | `location[directory]` query / `x-opencode-directory` header |

### Why the dashboard currently uses v1 (and should stay mostly v1)

The dashboard calls three v1 paths (`src/lib/agents/opencode.ts:222,238,252,
499`): `GET /session`, `GET /session/status`, `GET/POST /session/:id/message`.
It uses v1 because **`/session/status` exists only in v1** and is the primary
status signal. Dropping v1 would lose status. v2 is the cleaner surface for
permission/question listing (location-scoped) but is incomplete.

**Recommended hybrid query plan** (see §7 for the full algorithm):
- v1 `GET /session` + `GET /session/status` — roster + busy/idle/retry.
- v1 `GET /permission` + `GET /question` (or v2 `GET /api/permission/request`
  + `GET /api/question/request`) — blocking-on-user signals.
- v1 `GET /session/:id/message` (or DB `part` table) — latest tool part for
  `running`-tool detection (covers `submit_plan`).

---

## 2. Status-relevant endpoint catalog (exact shapes)

All v1 success schemas serialize **camelCase** with `optionalOmitUndefined`
(undefined fields are omitted, never `null`). Branded IDs (`SessionID` =
`"ses_*"`, `MessageID` = `"msg_*"`, `PartID` = `"prt_*"`, `PermissionV1.ID` =
`"per_*"`, `QuestionID` = `"que_*"`) are plain strings on the wire.

### 2.1 `GET /session/status`  ← the most important endpoint

- **v1 only** (`groups/session.ts:121-131`; handler `handlers/session.ts` →
  `statusSvc.list()`).
- **Auth:** HTTP Basic (configured per-instance) + `x-opencode-directory` header.
- **Returns:** `Record<sessionID, SessionStatus.Info>` where
  `SessionStatus.Info` (`packages/opencode/src/session/status.ts:9-32`) is:
  ```ts
  { type: "idle" }                       // NOTE: idle entries are DELETED from the map before return
  | { type: "busy" }                      // agent loop running
  | { type: "retry",
      attempt: number,                    // NonNegativeInt
      message: string,
      action?: { reason, provider, title, message, label, link? },
      next: number }                      // epoch ms of next retry
  ```
- **Critical semantics:** the map only ever contains `busy`/`retry` entries.
  An `idle` result is computed by **absence** (`status.ts:71` default).
  Verified live: `GET /session/status` → `{}` when nothing is busy.

### 2.2 `GET /session` — session roster

- v1: `groups/session.ts:111-120` → `Session.Info[]`
  (`packages/opencode/src/session/session.ts:213-234`). Wire fields (camelCase):
  `id, slug, projectID, workspaceID?, directory, path?, parentID?, title,
  version, agent?, model?{id,providerID,variant?}, cost?, tokens?{input,output,
  reasoning,cache{read,write}}, share?{url}, summary?{additions,deletions,files,
  diffs?}, metadata?, time{created,updated,compacting?,archived?}, permission?,
  revert?`.
- **Note:** `parentID`/`projectID` are camelCase on the wire (the DB columns
  are `parent_id`/`project_id`). The dashboard defensively reads both
  (`src/lib/agents/opencode.ts:259,273`). `time.archived` (if present) ⇒
  archived session.
- v2 equivalent: `GET /api/session` (`packages/server/src/groups/session.ts:
  88-107`) with cursor pagination and a different `SessionV2.Info` shape.

### 2.3 `GET /permission` and `GET /question` — pending user-blocking requests

- **`GET /permission`** (v1, `groups/permission.ts:21-30`) → `PermissionV1.
  Request[]` (`packages/core/src/v1/permission.ts:28-40`):
  ```ts
  { id: "per_*", sessionID, permission: string,   // tool/action name, e.g. "bash"
    patterns: string[], metadata: {}, always: string[],
    tool?: { messageID, callID } }                 // present iff triggered by a tool call
  ```
  Reply enum (`PermissionV1.Reply`): `"once" | "always" | "reject"`.
- **`GET /question`** (v1, `groups/question.ts:22-31`) → `Question.Request[]`
  (`packages/opencode/src/question/index.ts:56-64`):
  ```ts
  { id: "que_*", sessionID, questions: Info[]{ question, header, options[]{label,
    description}, multiple?, custom? }, tool?: { messageID, callID } }
  ```
- v2 equivalents (location-scoped): `GET /api/permission/request`
  (`packages/server/src/groups/permission.ts:14-26`), `GET /api/question/request`
  (`packages/server/src/groups/question.ts:12-24`). These wrap the response in
  `{ location, data }`. Verified live: returns `{location:{...}, data:[]}`.
- **These are the ONLY reliable way to detect permission/question blocking**
  (the DB cannot; see Truth #3). Resolve via `POST /permission/:id/reply`,
  `POST /question/:id/reply`, `POST /question/:id/reject`.

### 2.4 `GET /session/:id/message` — message + part stream

- v1: `groups/session.ts:179-190` → `SessionV1.WithParts[]`
  (`packages/core/src/v1/session.ts:491-498`): `{ info: User|Assistant, parts:
  Part[] }`.
- **`Part` is a discriminated union on `type`** (`v1/session.ts:356-382`):
  `text | reasoning | tool | step-start | step-finish | file | patch |
  compaction | subtask | agent | retry | snapshot`.
- **`tool` part** (`v1/session.ts:306-316`) is the key to working/blocked:
  ```ts
  { type:"tool", id, sessionID, messageID, callID, tool: string,   // <-- tool name
    state: { status: "pending"|"running"|"completed"|"error", ... },
    metadata? }
  ```
  `state.status` variants: `pending`/`running` (in-flight, may be blocked),
  `completed` (done), `error` (failed). `input`/`output`/`error`/`time` fields
  vary per variant (`v1/session.ts:250-304`).
- **`step-finish` part** carries `reason` (`v1/session.ts:231-248`). Observed
  values in DB: `tool-calls` (43387), `stop` (4310), `length` (6), `other` (4),
  `unknown` (2). `stop` ⇒ model finished naturally; `tool-calls` ⇒ more work.

### 2.5 Event streams (live only — not for cold reads)

- v1 `GET /event` (SSE, `groups/event.ts`) and v2 `GET /api/event` (SSE). Useful
  for low-latency updates; `session.status` events flow here (`status.ts:35`).
  Not a substitute for `GET /session/status` at cold start.

### 2.6 Instance/liveness endpoints

- v1 `GET /path` (`groups/instance.ts:72-82`) → `{home,state,config,worktree,
  directory}` — proves the instance on this port is alive and tells you its
  directory. There is **no** endpoint that lists sessions-by-owning-process or
  exposes a PID.

---

## 3. The database — what it can and cannot tell you

DB location: `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` (SQLite,
WAL mode; `opencode.db` / `opencode.db-wal` / `opencode.db-shm`). The dashboard
already opens it readonly via `better-sqlite3`
(`src/lib/agents/opencode.ts:356-418`).

### 3.1 Tables relevant to status

| Table | Status relevance | Key columns |
|---|---|---|
| `session` | roster + metadata | `id, project_id, parent_id, directory, title, agent, model(json), time_created, time_updated, time_compacting, time_archived, metadata(json), cost, tokens_*, permission(json), revert(json)` |
| `part` | **THE durable activity/blocking signal** | `id, message_id, session_id, time_created, time_updated, data(json=V1Part)` |
| `message` | message envelope | `id, session_id, time_created, time_updated, data(json)` |
| `event` | durable event log (incomplete) | `id, aggregate_id(=sessionID), seq, type, data` |
| `event_sequence` | per-session event counter | `aggregate_id, seq, owner_id` (**owner_id is NULL in practice**) |
| `session_message` | model/agent switches | `session_id, type("model-switched"/"agent-switched"), seq, data` |
| `todo` | task lists | `session_id, content, status, priority, position` |
| `session_input` | queued prompts | `session_id, prompt, delivery, admitted_seq, promoted_seq` |
| `session_context_epoch` | compaction baselines | `session_id, baseline_seq, agent` |

### 3.2 `part.data` types observed in the live DB

Counts from `SELECT json_extract(data,'$.type')`: `tool` (64694), `step-start`
(48057), `step-finish` (47668), `reasoning` (33026), `text` (26201), `patch`
(5060), `file` (376), `compaction` (68), `subtask` (4), `agent` (1).

### 3.3 Tool names observed (the ones that matter for status)

From `json_extract(data,'$.tool')` on `type='tool'` parts: `read, bash, grep,
glob, edit, apply_patch, todowrite, …, question (222), plan_exit (120),
submit_plan (114), …`. Tool `state.status` distribution: `completed` (61820),
`error` (2891), **`running` (33), `pending` (4)**.

> **The 33 `running` and 4 `pending` tool parts are the smoking gun.** A
> non-terminal tool part with no later terminal part for the same `callID` = a
> session parked on that tool. This is the ONLY durable signal for `submit_plan`
> blocking, and a strong corroborating signal for `question` blocking.

### 3.4 What the DB CANNOT tell you

- **Pending permissions** — ephemeral (Truth #3). No rows anywhere.
- **Pending questions** (the live `/question` kind) — ephemeral. (The durable
  `question` *tool* part in `running` state is a workaround, see §4.)
- **Which process owns a session / is it alive** — no PID/owner column
  (Truth #1).
- **Whether `submit_plan` is specifically blocked vs just slow** — you only see
  `running`; you infer "blocked on review" from the tool name.

---

## 4. The three blocking mechanisms (the heart of status inference)

### 4.1 Permission block → ephemeral, live-API-only

- A tool hits a permission rule of `"ask"`; `Permission.ask` registers an
  in-memory request and suspends (mirrors Question). Surfaced via `GET
  /permission` (v1) / `GET /api/permission/request` (v2). **Never persisted.**
- **Detection:** sessionID present in `GET /permission`.
- **Resume:** `POST /permission/:requestID/reply` with
  `{reply:"once"|"always"|"reject", message?}`.

### 4.2 Question block → ephemeral, live-API-only (with a durable fallback)

- The built-in **`question` tool** (`packages/opencode/src/tool/question.ts:
  14-44`) calls `question.ask(...)`, which parks on an in-memory
  `Deferred` (`packages/opencode/src/question/index.ts:153-178`). Surfaced via
  `GET /question`. The `question.*` events are **not persisted**.
- **Detection (primary):** sessionID present in `GET /question`.
- **Detection (durable fallback):** latest `tool` part for the session is
  `tool="question"` with `state.status` in `running`/`pending`.
- **Resume:** `POST /question/:requestID/reply` `{answers:string[][]}` or
  `POST /question/:requestID/reject`.

### 4.3 `submit_plan` block → durable tool part, NOT in /question or /permission

- `submit_plan` is a **plannotator-bridge plugin tool**
  (`plannotator/apps/opencode-plugin/index.ts:574-718`). Its `execute` is an
  `async` function that **`await`s `runPlanReview(...)`** (the Plannotator review
  UI — embedded Bun HTTP server or CLI bridge). The execute Promise does not
  resolve until the user approves/denies.
- Net effect: the `tool` part is written with `state.status="running"` and stays
  there for the entire review wait. Confirmed by a live DB sample
  (`tool="submit_plan", state.status="running", state.time.start=…`).
- On approval: part → `completed`, plugin returns the approved prompt, and may
  inject a synthetic prompt switching to the `build` agent (`index.ts:668-704`).
- On denial: part → `completed` with the denial+line-numbered plan in `output`
  (sample shows `"YOUR PLAN WAS NOT APPROVED…"`).
- **Detection (the ONLY reliable signal):** latest `tool` part for the session
  is `tool="submit_plan"` with `state.status` in `running`/`pending`. Works in
  both the DB and `GET /session/:id/message`. Does **not** appear in
  `GET /question` or `GET /permission`.
- **Cannot resume from the dashboard via standard API** — approval happens in
  the Plannotator UI/CLI. (You can `POST /session/:id/abort` to cancel.)

---

## 5. Answering the six status questions

For each: the authoritative signal, the data source, and the gotchas.

### Q1. Are they actively working?
- **Signal:** `GET /session/status` ⇒ entry with `type:"busy"` for the
  sessionID.
- **Corroborating (durable):** latest `step-finish` part has
  `reason:"tool-calls"`, OR latest `tool` part has `state.status` in
  `running`/`pending` for a NON-blocking tool (i.e. not `submit_plan`/`question`
  while a pending request exists).
- **Gotcha:** `busy` only reflects the instance you're querying. A session being
  driven by a *different* opencode process won't show `busy` here.

### Q2. Blocked on a permissions request?
- **Signal:** sessionID present in `GET /permission` (v1) or
  `GET /api/permission/request` (v2). **DB cannot detect this.**
- **Gotcha:** purely ephemeral; if the instance died mid-ask, the request is gone
  and the session is just stale `running` tool.

### Q3. Blocked on asking questions of the user?
- **Primary signal:** sessionID present in `GET /question` (v1) or
  `GET /api/question/request` (v2).
- **Durable fallback:** latest `tool` part is `tool="question"` with
  `state.status` in `running`/`pending`.
- **Gotcha:** live `/question` is authoritative while the instance lives; the DB
  fallback survives restarts but can't prove the instance is still waiting
  (could be a dead `question` part).

### Q4. Blocked in a `submit_plan` call waiting for plan review?
- **Signal:** latest `tool` part is `tool="submit_plan"` with `state.status` in
  `running`/`pending` (DB `part` table OR `GET /session/:id/message`).
- **NOT** in `GET /question` or `GET /permission` (it uses neither).
- **Corroborating:** `session.agent = "plan"` (the plan agent) strengthens the
  signal; switching to `build` agent (`session.next.agent.switched.1` event)
  signals the review was approved.
- **Gotcha:** indistinguishable from "submit_plan executing slowly" without a
  timeout heuristic. Treat `running` + age > N seconds as blocked.

### Q5. Complete and idle?
- **Signal:** absent from `GET /session/status` (not busy/retry on this
  instance) AND latest `step-finish.reason = "stop"` (model finished naturally)
  AND no `running`/`pending` tool part.
- **Gotcha (big one):** absent-from-status is **also** what a dead instance
  looks like. You cannot distinguish "idle, alive" from "dead" via the API
  alone. Must combine with Q6.

### Q6. Is the opencode instance for that session still running as an executable?
- **There is no first-class API/DB signal** (Truth #1). Best available:
  1. If the session is in `GET /session/status` → instance alive (busy).
  2. Else if `GET /path` on the configured `apiBase` returns 200 with a
     `directory` matching the session's `directory` → *an* instance for that
     directory is alive (but you still can't prove it owns this session).
  3. **For true per-session liveness, use OS-level process inspection:**
     enumerate `opencode` processes (e.g. `ps`/`/proc/*/cmdline` + `cwd`) and
     match by working directory == session.directory and/or session id in argv.
     This is the only reliable method and is outside the API/DB.
- **Gotcha:** multiple instances can share one directory; matching is heuristic.
  A session whose instance died will keep its last DB rows forever looking
  "recent" — staleness timers are a weak proxy.

---

## 6. Why the current dashboard logic is non-deterministic

`inferOpencodeStatus` (`src/lib/agents/opencode.ts:159-180`) makes several
assumptions that break against the truths above:

1. **Treats `/session/status` absence as terminal/idle** (lines 177, 179) — but
   that's also a dead instance (Q5/Q6 ambiguity). Hence "complete" flickers to
   "idle" and back.
2. **Uses wall-clock staleness (`lastActivityMs`) as a status proxy**
   (lines 172-179) — but a `submit_plan` review can legitimately wait hours
   (plugin default timeout is **96 hours**, `index.ts:100`). A legitimately
   blocked plan ages past 45–60s and gets misclassified as `complete`/`idle`.
3. **Never queries `/permission` or `/question`** — so it literally cannot
   detect Q2/Q3 blocking. Those sessions get misread as `working` (because of a
   stale `running` tool part) or `idle`.
4. **`latestStepReason` / `latestToolStatus` come from whichever part was seen
   last** without scoping to the current assistant turn or checking for a later
   terminal part on the same `callID` — so a stale `running` from a dead turn
   pollutes the read.
5. **`hasActiveInstance = statusData.hasOwnProperty(id)`** (line 274, 390) is
   only true while busy; idle-but-alive and dead both yield `false`.

---

## 7. Recommended detection algorithm

Inputs per refresh: `statusMap = GET /session/status` (v1),
`permissions = GET /permission`, `questions = GET /question`, and for each
session its latest parts (DB `part` table, or `GET /session/:id/message`).

```
for each session S:
  st = statusMap[S.id]?.type            // "busy" | "retry" | undefined
  latestTool = most recent part of S where data.type == "tool"
               (break ties by time_created DESC, id DESC)
  latestToolRunning = latestTool && latestTool.state.status in {"pending","running"}
                     && no LATER part with same callID in {"completed","error"}
  latestStepReason = most recent "step-finish" part's reason

  # --- blocking states first (most specific) ---
  if S.id in permissions:        return "blocked_permission"
  if S.id in questions:          return "blocked_question"
  if latestTool?.tool == "submit_plan" and latestToolRunning:
                                 return "blocked_plan_review"
  if latestTool?.tool == "question"   and latestToolRunning:
                                 return "blocked_question"   # durable fallback

  # --- actively working ---
  if st == "busy":               return "working"
  if st == "retry":              return "retry"
  if latestToolRunning and latestTool.tool not in {"submit_plan","question"}:
                                 return "working"

  # --- terminal / idle ---
  if latestStepReason == "stop" and not latestToolRunning:
                                 return "idle"                # model finished

  # --- ambiguous: stale activity ---
  age = now - S.time.updated
  if age < WORKING_GRACE_MS (e.g. 30000): return "working"   # recent activity
  return "idle"                                              # default
```

**Liveness (Q6) must be layered on top, separately:** compute
`instanceAlive(S)` via OS process match (preferred) or `GET /path` directory
match; if `!instanceAlive(S)` and status is `idle`/`working`, downgrade to
`dead/stale`. Never derive liveness from `/session/status` alone.

**Tuning notes:**
- `WORKING_GRACE_MS` should be small (≈ one poll interval × 2). The current
  45–60s windows are too wide and cause the "stale working" misreads.
- For `submit_plan`, do **not** apply the staleness downgrade inside the review
  window — reviews legitimately last up to 96h.
- Scope "latest tool" to the current assistant turn (parts after the last
  `user` message) to avoid stale cross-turn reads.

---

## 8. Testing strategy

There is no test runner in the dashboard today; when adding Vitest, exercise the
**real** inference against captured fixtures:

1. **DB fixtures:** export anonymized rows from `part`/`session` for each
   scenario — a completed turn (`reason=stop`), a `submit_plan running`, a
   `question running`, a stale `bash running` from a dead turn, a `retry`
   status. Assert the algorithm maps each to the expected label.
2. **API fixtures:** record `GET /session/status`, `/permission`, `/question`
  responses (use the live instance in each state) as JSON fixtures; assert the
  blocking-state branches.
3. **Property tests:** for any session, `blocked_*` states must be mutually
   exclusive and take priority over `working`/`idle`; `idle` must imply no
   `running`/`pending` tool part and `reason != tool-calls`.
4. **Adversarial/missing inputs:** empty `statusMap`, missing `permission`/
  `question` endpoints (API down → DB-only mode), archived sessions
  (`time.archived` set), sessions with zero parts.
5. **Non-determinism regression:** the specific cases that flicker today —
   long-running `submit_plan` aged past 60s, dead-instance idle vs alive-idle —
   must be pinned by tests.

---

## 9. Key files reference

**Dashboard (the consumer):**
- `src/lib/agents/opencode.ts` — current inference (`inferOpencodeStatus:159`,
  API paths at `222,238,252,499`, SQLite reader `356-418`).
- `src/lib/agents/types.ts` — `AgentSession.status` union (narrow it to the new
  labels when implementing).

**OpenCode API (v1 instance):**
- `packages/opencode/src/server/routes/instance/httpapi/api.ts:69-74` — both
  APIs mounted together.
- `…/groups/session.ts:78-105` (paths), `:121-131` (status), `:179-190`
  (messages).
- `…/groups/permission.ts`, `…/groups/question.ts`, `…/groups/event.ts`,
  `…/groups/instance.ts`.
- `packages/opencode/src/session/status.ts:9-33, 69-91` — status schema + the
  in-memory map that deletes idle entries.
- `packages/opencode/src/session/run-state.ts` — in-memory runner map.
- `packages/opencode/src/tool/question.ts:14-44` — the `question` tool.

**OpenCode API (v2):**
- `packages/server/src/groups/{session,permission,question,event}.ts` — note no
  status endpoint.

**Persistence rules:**
- `packages/core/src/event.ts:387-407` — only `sync`'d events hit the DB.
- `packages/core/src/session/sql.ts:21-97` — `session` + `part` table columns.
- `packages/core/src/v1/session.ts:250-316` — `ToolPart`/`ToolState` (the
  `running` signal).
- `packages/core/src/v1/permission.ts:28-49` — permission request/reply shapes.

**The `submit_plan` tool (plugin):**
- `~/src/ai/services/projects/plannotator-bridge/plannotator/apps/opencode-plugin/index.ts:574-718`
  — definition; `:591-715` execute (awaits review); `:100` 96h default timeout.
- Registered via `plugin.tool.submit_plan` (gated by `shouldRegisterSubmitPlan`).

**Config:**
- `~/.config/ai-dashboard/dashboard.toml` — `[agents.opencode]` apiBase/dbPath/
  credentials.
- `~/.config/opencode/opencode.json:559-570` — plugin list (incl. plannotator).

---

## 10. Confidence & gaps

- **High confidence:** all endpoint paths/shapes; the five architectural truths
  (verified against source + live DB counts + live API probes); the `submit_plan`
  plugin location and blocking mechanism.
- **Medium:** the exact v2 `PermissionV2.Request`/`QuestionV2.Request` shapes
  differ slightly from v1 — confirm against `packages/core/src` v2 schemas if
  you adopt the v2 endpoints (I documented the v1 shapes authoritatively).
- **Open:** true per-session process liveness has no API answer; the OS-process
  approach (Q6) needs implementation + testing against how the user actually
  launches opencode (container vs host; `host.containers.internal:4096` in the
  current config implies the API is exposed from a container — process
  enumeration may need to happen inside that container).
