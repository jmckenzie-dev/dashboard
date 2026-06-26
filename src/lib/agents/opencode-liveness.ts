import type { OpenCodeSessionReason } from './types';

export const RECENT_ACTIVE_FALLBACK_MS = 30_000;

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

function directReason(candidate: OpenCodeLivenessCandidate): OpenCodeSessionReason | null {
  if (candidate.hasBlockingRequest) return 'blocking_request';
  if (candidate.hasActiveTool) return 'active_tool';
  if (candidate.hasProcessSessionId) return 'process_session_id';
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

  for (const candidate of candidates) {
    const reason = directReason(candidate);
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
