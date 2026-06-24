# Dashboard Status-Based Session Sorting

The dashboard currently sorts sessions purely by their last activity time. The goal of this change is to group sessions on the dashboard by their status, and then sort by the most recently updated session first.

The status groupings should be:
1. **Error**: `error`
2. **Blocked (permission or question)**: `blocked_permission`, `blocked_question`, `blocked`
3. **Blocked (review)**: `blocked_review`
4. **Working**: `working`, `retry`
5. **Complete**: `complete`
6. **Idle**: `idle`

---

## Proposed Changes

### Core Types & Logic

#### [MODIFY] [types.ts](file:///home/jmckenzie/src/ai/services/projects/dashboard/src/lib/agents/types.ts)
- Add `getStatusRank(status: AgentStatus): number` helper function mapping statuses to their ranks (1-6).
- Add `compareSessions(a: { status: AgentStatus; lastActivity: Date | string }, b: { status: AgentStatus; lastActivity: Date | string }): number` sorting function. It compares status ranks first, and falls back to comparing `lastActivity` descending (most recent first).

---

### Backend Session API

#### [MODIFY] [index.ts](file:///home/jmckenzie/src/ai/services/projects/dashboard/src/lib/agents/index.ts)
- Import `compareSessions` from `./types`.
- Modify `getAllSessions` to sort using `compareSessions` instead of sorting by `lastActivity` descending only. This ensures that the SSE API endpoint, which slices the top 20 sessions, includes the most relevant sessions (e.g. older Errors/Blocked sessions) instead of missing them due to time recency.

---

### Frontend Dashboard View

#### [MODIFY] [page.svelte](file:///home/jmckenzie/src/routes/+page.svelte)
- Import `compareSessions` from `$lib/agents/types`.
- In `buildSessionTree`, replace the `sortByLastActivityDesc` comparator for `roots` and `children` arrays with `compareSessions`.
- Remove the unused `sortByLastActivityDesc` helper function.

---

## Verification Plan

### Automated Tests
- Run `npm run check` to ensure there are no TypeScript or Svelte diagnostics errors.
- Run `npm run build` to verify the production bundle builds successfully.
- Run `node scripts/test-status-inference.mjs` to ensure the status inference tests still pass.

### Manual Verification
- Rebuild the dashboard container and restart the service using `./restart_dashboard.sh`.
- View the dashboard to confirm sessions are correctly sorted:
  - Error sessions at the top
  - Blocked sessions below Errors
  - Working sessions below Blocked
  - Complete/Idle sessions at the bottom
  - Within each group, sessions are ordered by the most recently updated first.
