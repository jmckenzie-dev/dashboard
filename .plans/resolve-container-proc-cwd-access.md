# Plan: Resolve Container Proc CWD Access

## Problem Description
The containerized dashboard runs with `--pid=host` to monitor host processes (specifically OpenCode sessions). However, rootless Podman isolates container processes in a private user namespace. As a result, even if the container user maps to host UID 1000, reading the symbolic link `/proc/<pid>/cwd` for host processes yields a `Permission denied` error due to namespace and ptrace security boundaries.

We need to choose between two resolution strategies:
1. **Container Configuration (Option A):** Aligning the container user namespace to match the host user.
2. **Software Fallback Heuristic (Option B):** Restricting the liveness mapping heuristics in `src/lib/agents/opencode.ts` to avoid reading `/proc/<pid>/cwd` by using time/recency checks.

---

## Proposed Options

### Option A: Container-Level Namespace Alignment
Configure the Podman container to run with host user mappings directly, allowing it to traverse `/proc/<pid>/cwd`.
- **Action**: Edit `/home/jmckenzie/.config/containers/systemd/ai-agent-dashboard.container`
- **Key Changes**:
  - Add `UserNS=keep-id` (or `UserNS=host`).
  - Add `AddCapability=CAP_SYS_PTRACE` (or via `PodmanArgs=--cap-add=SYS_PTRACE`).
  - *Risk/Work*: Because the container user changes from root (UID 0) to UID 1000, write paths inside the container (e.g., `/root/.config/ai-dashboard` and `/root/.local`) must be redirected to point to the host-equivalent paths `/home/jmckenzie/.config` and `/home/jmckenzie/.local`.

### Option B: Software Heuristic with Recency Bounds
Adjust the SvelteKit backend logic to match PIDs to sessions using a time-bound fallback instead of `/proc/<pid>/cwd`.
- **Action**: Edit `src/lib/agents/opencode.ts`
- **Key Changes**:
  - Keep the container configuration untouched.
  - Implement a recency threshold (e.g., `< 20 minutes` since last activity) when mapping unresolved processes to active sessions.
  - This prevents old/stale sessions from being resurrected in the UI when they match background PIDs, resolving the liveness issue gracefully.

---

## Tasks & Steps

- [ ] **Step 1:** Align with the user on the preferred approach (Option A vs. Option B).
- [ ] **Step 3:** Implement the chosen option:
  - If **Option A**: Update the Quadlet container file, adjust volume mounts, and run `./restart_dashboard.sh`.
  - If **Option B**: Modify `src/lib/agents/opencode.ts` with a 20-minute recency check.
- [ ] **Step 4:** Run `npm run check` and verification tests (`bash run_tests.sh`).
- [ ] **Step 5:** Verify that the "Commit changes on branch" session resolves to `working` and that old sessions are not resurrected.
