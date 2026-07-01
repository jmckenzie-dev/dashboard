# TODO
- [ ] Auto collapse w/subagents by default. Show (N subagents active of M total) or something instead in title.
- [ ] Get git repo setup; remote origin at http://192.168.68.110:3000/jmckenzie/agent_dashboard.git. Need to create branch, commit all existing code, and push it.
- [ ] On settings, add a button to check connectivity to the provided LLM Configuration and print out either green successful connection on test or red connection failed w/failure message. Use popup for both.
- [ ] Add configuration in settings to choose 15/30/60 min for completed tasks.
- [ ] Add keyboard shortcut to toggle between 15/30/60 min (alt+t).
- [ ] On working tasks, calculate and show duration of working on dashboard.
- [ ] Consider showing # active subagents or team members for a given task while working.
- [ ] Debug inability to send messages to agents from interface.
- [ ] Make title of the page editable instead of just being AI Agent Dashboard.
- [ ] Auto sort w/blocked at top ordered by longest blocked first, working underneath sorted by longest, then complete sorted by most recent to oldest.
- [ ] Look into ability to remotely spin up new opencode sessions from http GUI and start new jobs in a new worktree.
- [ ] Look into ability to register certain projects or create new projects w/the GUI to kick off new feature work.

# DONE

## Completed
- [x] CPU Optimization & Prometheus Instrumentation: implemented background process polling, CWD caching, window function SQLite query consolidation, in-memory part caching, and metrics endpoint (/api/metrics) with self-tests.
- [x] Group dashboard sessions by status (Error, Blocked, Working, Complete, Idle) and sort by updated descending
- [x] Implement OpenCode liveness Phase 2 (OS process matching) per docs/reference_comparison.md.
- [x] Implement session status resolution fixes: OS process inventory, error status, hierarchical blocking, multi-port discovery, fixed SQLite query, liveness-based visibility, and queryability API (GET /api/status/diagnose).
- [x] Initial git commit created (Feb 26, 2025)
- [x] Update local AGENTS.md with the status of this codebase (complete via initial commit).
- [x] For subagents, list them nested and indented under their parent session. Collapse them automatically after 1 minute being complete under the parent task
- [x] Get opencode status deterministic — rewrote `inferOpencodeStatus` (src/lib/status/inference.ts) per docs/opencode-session-status.md §7: now queries live `/permission` + `/question`, turn-scopes the latest tool part (kills stale-`running` false positives), splits blocking into blocked_permission/blocked_question/blocked_review with no staleness cutoff on 96h plan reviews, and decays complete→idle at 5m. Added a deterministic self-test (scripts/test-status-inference.mjs, 22 cases) exercising the real compiled algorithm.
- [x] Add clickable buttons for approvals passing through the approval an instance is asking for — permission requests now surface Approve once / Always allow / Reject buttons (POST /api/agents/[id] action=permission); submit_plan reviews surface a Cancel-session action (action=abort); questions keep the reply input.
- [x] Fix stuck error-status session visible after `/new` — suppress stale `process_session_id` signal when a different session in the same directory is confirmed alive by `/session/status`.
