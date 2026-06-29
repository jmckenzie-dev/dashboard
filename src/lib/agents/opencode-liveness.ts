import type { OpenCodeSessionReason } from './types';

export const RECENT_ACTIVE_FALLBACK_MS = 30_000;

// Maximum age of an active-tool signal to count as evidence of liveness.
// Tools stuck in 'running' for longer than this are assumed orphaned
// (owning process died without terminalizing the tool).
export const ACTIVE_TOOL_LIVENESS_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export type OpenCodeStatusType = 'idle' | 'busy' | 'retry' | null | undefined;

export function hasOpenCodeStatusLiveness(status: OpenCodeStatusType): boolean {
  return status === 'busy' || status === 'retry';
}

export interface OpenCodeLivenessCandidate {
  id: string;
  parentId?: string | null;
  directory?: string;
  lastActivity: Date;
  hasStatusSignal: boolean;
  hasBlockingRequest: boolean;
  hasActiveTool: boolean;
  hasProcessSessionId: boolean;
}

export interface OpenCodeLivenessDecision {
  instanceAlive?: true;
  livenessReason: OpenCodeSessionReason;
  visibilityReason: OpenCodeSessionReason;
}

/**
 * Determine whether a candidate has a direct (non-allocated) liveness signal.
 *
 * Signals are checked in descending reliability order. The `process_session_id`
 * signal (process argv `-s` flag) is suppressed when the candidate's directory
 * already has a different session confirmed alive by `/session/status`
 * (`status_map`). Rationale: opencode `/new` creates a new session ID but the
 * process argv is immutable on Linux — the old session ID lingers in
 * /proc/<pid>/cmdline even though the process has moved on.
 *
 * Without this guard, an errored session superseded by `/new` stays visible
 * indefinitely via the stale `process_session_id` signal.
 */
function directReason(
  candidate: OpenCodeLivenessCandidate,
  now: number,
  directoriesWithStatusSignal: Set<string>,
): OpenCodeSessionReason | null {
  if (candidate.hasBlockingRequest) return 'blocking_request';
  if (candidate.hasActiveTool) {
    if (now - candidate.lastActivity.getTime() <= ACTIVE_TOOL_LIVENESS_MAX_AGE_MS) {
      return 'active_tool';
    }
  }
  if (candidate.hasProcessSessionId) {
    // If this directory already has a session confirmed alive via
    // /session/status, the process_session_id signal is stale (the
    // process's argv still references an old session ID after /new).
    if (!candidate.directory || !directoriesWithStatusSignal.has(candidate.directory)) {
      return 'process_session_id';
    }
    // Fall through: the candidate can still get liveness via
    // status_map (if it has one) or cwd_allocated / fallback.
  }
  if (candidate.hasStatusSignal) return 'status_map';
  return null;
}

export function allocateOpenCodeLiveness(
  candidates: OpenCodeLivenessCandidate[],
  directoryAllocationCounts: Record<string, number>,
  now = Date.now(),
): Map<string, OpenCodeLivenessDecision> {
  const decisions = new Map<string, OpenCodeLivenessDecision>();
  const directIds = new Set<string>();

  // Compute directories that have at least one session confirmed alive by
  // /session/status. Used below to detect stale process_session_id signals
  // when a process has moved on (e.g. after `/new`) but its argv still
  // references an old session ID.
  const directoriesWithStatusSignal = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.hasStatusSignal && candidate.directory) {
      directoriesWithStatusSignal.add(candidate.directory);
    }
  }

  for (const candidate of candidates) {
    const reason = directReason(candidate, now, directoriesWithStatusSignal);
    if (!reason) continue;
    directIds.add(candidate.id);
    decisions.set(candidate.id, {
      instanceAlive: true,
      livenessReason: reason,
      visibilityReason: reason,
    });
  }

  for (const [directory, count] of Object.entries(directoryAllocationCounts)) {
    if (count <= 0) continue;

    const allocatable = candidates
      .filter((candidate) =>
        candidate.directory === directory
        && !candidate.parentId
        && !directIds.has(candidate.id),
      )
      .sort((a, b) => {
        const activityDiff = b.lastActivity.getTime() - a.lastActivity.getTime();
        if (activityDiff !== 0) return activityDiff;
        return b.id.localeCompare(a.id);
      });

    for (const candidate of allocatable.slice(0, count)) {
      decisions.set(candidate.id, {
        instanceAlive: true,
        livenessReason: 'cwd_allocated',
        visibilityReason: 'cwd_allocated',
      });
    }
  }

  for (const candidate of candidates) {
    if (decisions.has(candidate.id)) continue;

    if (now - candidate.lastActivity.getTime() <= RECENT_ACTIVE_FALLBACK_MS) {
      decisions.set(candidate.id, {
        livenessReason: 'recent_active_fallback',
        visibilityReason: 'recent_active_fallback',
      });
      continue;
    }

    decisions.set(candidate.id, {
      livenessReason: 'hidden_stale',
      visibilityReason: 'hidden_stale',
    });
  }

  return decisions;
}
