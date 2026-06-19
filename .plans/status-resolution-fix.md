# Plan: Durable Session Status Resolution Fix

## Goals
1. Fix recurring session status errors (sessions going missing, wrong status)
2. Add LLM/agent queryable API for state inspection
3. Verify correctness through the query API

## Changes

### 1. `src/lib/agents/types.ts` — Add `error` status
- Add `'error'` to `AgentStatus` union
- Update `isBlocked()` (no change needed — error is separate)

### 2. `src/lib/status/inference.ts` — Add error detection
- Detect tool parts with `status === 'error'` in `analyzeParts` output
- Add `hasError` to `OpencodeStatusInput`
- Return `'error'` status when latest tool part has error status

### 3. `src/lib/agents/opencode.ts` — Fix SQLite + process-backed fixes
- **SQLite query**: Remove `LIMIT 50`, add `WHERE time_archived IS NULL AND parent_id IS NULL` filter
- **Pass `hasError` to `inferOpencodeStatus`**: from `analyzeParts` result
- **Multi-port**: Accept discovered ports alongside primary apiBase

### 4. `src/lib/process/poller.ts` — NEW: OS process scanner
- Run `ps -eo pid,args` to find opencode processes (TUI + serve)
- Resolve CWD from `/proc/<pid>/cwd`
- Match processes to SQLite projects (longest path wins)
- Map flagless TUI processes to Nth most-recent session per project
- Discover serve ports from process args
- Publish liveness info: which directories/sessions are backed by live processes

### 5. `src/lib/agents/index.ts` — Fix visibility + hierarchical blocking
- **Visibility**: Keep sessions with `instanceAlive === true`
- **Error counts**: Add `error` to `countStatuses`
- **Hierarchical blocking**: After gathering all sessions, bubble child `blocked_*` status to parent sessions

### 6. `src/routes/api/status/diagnose/+server.ts` — NEW: queryability API
- Returns comprehensive state dump:
  - Process inventory (discovered PIDs, CWDs, ports)
  - All sessions with full status info
  - Liveness info per session
  - SQLite query stats
  - Hierarchical blocking analysis
- Designed for LLM/agent consumption (structured, self-describing)

## Verification
1. `npm run check` — TypeScript diagnostics
2. `npm run build` — Build verification
3. Hit `GET /api/status/diagnose` endpoint to inspect state
