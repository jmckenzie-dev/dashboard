## Status-Based Session Sorting

- Implemented status-based session sorting as requested to group dashboard sessions by status (Error -> Blocked -> Working -> Complete -> Idle), and within each group, order by most recently updated.
- Created `getStatusRank` and `compareSessions` utility functions in `src/lib/agents/types.ts` to manage status ranking and time comparisons.
- Modified the backend's `getAllSessions` function in `src/lib/agents/index.ts` to use `compareSessions` so that the SSE endpoint's `slice(0, 20)` includes the most relevant/urgent sessions (e.g. older errors) instead of slicing purely by recency.
- Updated the frontend's `buildSessionTree` in `src/routes/+page.svelte` to sort both root-level parent sessions and child subagent lists using `compareSessions`.
- Verified typescript and svelte check (`npm run check`) and ran the status inference tests (`test-status-inference.mjs`), which both pass cleanly.
