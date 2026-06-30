import type { AgentSession, AgentType, AgentStatus, StatusTransition, BlockReason } from './types';
import { isBlocked, compareSessions } from './types';
import {
  getOpenCodeSessions,
  sendOpenCodeMessage,
  isAPIModeAvailable,
  replyOpenCodePermission,
  replyOpenCodeQuestion,
  rejectOpenCodeQuestion,
  abortOpenCodeSession,
} from './opencode';
import { getClaudeSessions, sendClaudeMessage } from './claude';
import { getCodexSessions, sendCodexMessage } from './codex';
import { getGeminiSessions, sendGeminiMessage } from './gemini';
import { computeVisibleSessions } from './visibility-hysteresis';

// LRU cache for previous statuses — bounded to prevent unbounded memory growth.
const MAX_TRACKED_SESSIONS = 200;
const previousStatus = new Map<string, AgentStatus>();
const transitionCallbacks: Array<(transition: StatusTransition) => void> = [];

// Per-process hysteresis deadlines for OpenCode visibility. A session that
// was directly visible within VISIBILITY_GRACE_MS stays visible across
// transient "hidden_stale" gaps so actively-worked sessions stop flickering.
// See src/lib/agents/visibility-hysteresis.ts.
let opencodeVisibleUntil = new Map<string, number>();

function isVisibleOpenCodeSession(session: AgentSession): boolean {
  const reason = session.visibilityReason ?? session.livenessReason ?? null;

  if (reason === 'hidden_stale') return false;
  if (reason) return true;

  if (session.instanceAlive === true) return true;
  if (session.pid) return true;
  if (session.isActiveInstance) return true;
  if ((session.blockingRequestIds?.length ?? 0) > 0) return true;
  if (isBlocked(session.status)) return true;
  if (session.status === 'working' || session.status === 'retry') return true;

  return false;
}

function isVisibleGenericSession(
  session: AgentSession,
  recentWindow: number,
  blockedWindow: number,
  completeWindow: number,
): boolean {
  const updated = session.lastActivity.getTime();

  if (session.instanceAlive === true) return true;
  if (session.pid) return true;
  if (session.isActiveInstance) return true;
  if (updated > recentWindow) return true;
  if (session.status === 'retry' && updated > blockedWindow) return true;
  if (isBlocked(session.status) && updated > blockedWindow) return true;
  if (session.status === 'complete' && updated > completeWindow) return true;
  if (session.status === 'error' && updated > blockedWindow) return true;

  return false;
}

export function onStatusTransition(callback: (transition: StatusTransition) => void): () => void {
  transitionCallbacks.push(callback);
  return () => {
    const index = transitionCallbacks.indexOf(callback);
    if (index > -1) transitionCallbacks.splice(index, 1);
  };
}

function checkTransitions(sessions: AgentSession[]): StatusTransition[] {
  const transitions: StatusTransition[] = [];
  const seen = new Set<string>();
  
  for (const session of sessions) {
    seen.add(session.id);
    const prev = previousStatus.get(session.id);
    
    if (prev && prev !== session.status) {
      const transition: StatusTransition = {
        sessionId: session.id,
        agentType: session.type,
        fromStatus: prev,
        toStatus: session.status,
        timestamp: new Date()
      };
      transitions.push(transition);
      
      for (const callback of transitionCallbacks) {
        try {
          callback(transition);
        } catch (error) {
          console.error('Status transition callback error:', error);
        }
      }
    }
    
    previousStatus.set(session.id, session.status);
  }
  
  // Evict stale entries when the map exceeds the maximum size.
  if (previousStatus.size > MAX_TRACKED_SESSIONS) {
    for (const key of previousStatus.keys()) {
      if (!seen.has(key)) {
        previousStatus.delete(key);
        if (previousStatus.size <= MAX_TRACKED_SESSIONS) break;
      }
    }
  }
  
  return transitions;
}

/**
 * Apply hierarchical blocking: if any descendant session is blocked, bubble
 * the blocking status up to the parent. This matches the reference's
 * child-to-parent bubble (reference/opencode-multiplexer/src/db/reader.ts:243-258)
 * and extends it to the whole tree.
 *
 * Priority: blocked_permission > blocked_question > blocked_review
 */
function applyHierarchicalBlocking(sessions: AgentSession[]): void {
  // Build parent→children map
  const childrenByParent = new Map<string, AgentSession[]>();
  const byId = new Map(sessions.map((s) => [s.id, s]));

  for (const session of sessions) {
    if (session.parentId) {
      const list = childrenByParent.get(session.parentId) ?? [];
      list.push(session);
      childrenByParent.set(session.parentId, list);
    }
  }

  // Walk from leaves upward: compute child block status per parent
  function propagateBlockedStatus(session: AgentSession): void {
    const children = childrenByParent.get(session.id);
    if (!children || children.length === 0) return;

    // First, recursively process children
    for (const child of children) {
      propagateBlockedStatus(child);
    }

    // Now check if any child has a blocking status that should bubble
    let childBlockStatus: AgentStatus | null = null;
    const blockedPriority: AgentStatus[] = [
      'blocked_permission',
      'blocked_question',
      'blocked_review',
    ];

    for (const blockedType of blockedPriority) {
      const found = children.some((c) => c.status === blockedType || c.blockReason === blockedType.replace('blocked_', '') as BlockReason);
      if (found) {
        childBlockStatus = blockedType;
        break;
      }
    }

    if (childBlockStatus && session.status !== childBlockStatus && !isBlocked(session.status)) {
      // Only bubble if parent isn't already in a blocking state
      session.status = childBlockStatus;
    }
  }

  // Process all root sessions (no parent or parent not in this set)
  for (const session of sessions) {
    if (!session.parentId || !byId.has(session.parentId)) {
      propagateBlockedStatus(session);
    }
  }
}

export async function getAllSessions(): Promise<AgentSession[]> {
  // NOTE: Only OpenCode is active. Claude, Codex, and Gemini agent backends
  // are disabled to reduce per-tick I/O overhead (execSync, file reads).
  // Re-enable when full multi-agent support is needed:
  //   const [opencode, claude, codex, gemini] = await Promise.all([
  //     getOpenCodeSessions(),
  //     getClaudeSessions(),
  //     getCodexSessions(),
  //     getGeminiSessions()
  //   ]);
  //   const all = [...opencode, ...claude, ...codex, ...gemini];
  // Fetch the FULL OpenCode set (including hidden_stale candidates) so the
  // hysteresis layer can smooth short visibility gaps instead of never seeing
  // them. Visibility filtering for OpenCode is delegated to
  // computeVisibleSessions below.
  const opencode = await getOpenCodeSessions({ includeHidden: true });
  const all = opencode;

  // Apply hierarchical blocking BEFORE visibility filtering so parent
  // sessions that become blocked via child bubble stay visible.
  applyHierarchicalBlocking(all);

  checkTransitions(all);

  const now = Date.now();
  const recentWindow = now - 10 * 60 * 1000;
  const blockedWindow = now - 2 * 60 * 60 * 1000;
  const completeWindow = now - 30 * 60 * 1000;

  // Split by agent type: OpenCode visibility goes through the hysteresis
  // layer (with the full candidate set as input); generic agents keep their
  // own time-windowed predicate (unchanged semantics).
  const opencodeCandidates = all.filter((session) => session.type === 'opencode');
  const genericCandidates = all.filter((session) => session.type !== 'opencode');

  const { visible: visibleOpenCode, visibleUntil: nextUntil } = computeVisibleSessions({
    candidates: opencodeCandidates,
    visibleUntil: opencodeVisibleUntil,
    now,
    isDirectlyVisible: isVisibleOpenCodeSession,
  });
  opencodeVisibleUntil = nextUntil;

  const visibleGeneric = genericCandidates.filter((session) =>
    isVisibleGenericSession(session, recentWindow, blockedWindow, completeWindow),
  );

  const activeSessions = [...visibleOpenCode, ...visibleGeneric];
  
  return activeSessions.sort(compareSessions);
}

export async function getSessionById(id: string): Promise<AgentSession | null> {
  const sessions = await getAllSessions();
  return sessions.find(s => s.id === id) || null;
}

export async function sendMessage(sessionId: string, message: string): Promise<boolean> {
  if (sessionId.startsWith('opencode-')) {
    return sendOpenCodeMessage(sessionId, message);
  }
  
  if (sessionId.startsWith('claude-')) {
    return sendClaudeMessage(sessionId, message);
  }
  
  if (sessionId.startsWith('codex-')) {
    return sendCodexMessage(sessionId, message);
  }
  
  if (sessionId.startsWith('gemini-')) {
    return sendGeminiMessage(sessionId, message);
  }
  
  return false;
}

export async function getStatusCounts(): Promise<Record<AgentStatus, number>> {
  const sessions = await getAllSessions();
  return countStatuses(sessions);
}

export function countStatuses(sessions: AgentSession[]): Record<AgentStatus, number> {
  const counts = {
    working: 0,
    blocked: 0,
    blocked_permission: 0,
    blocked_question: 0,
    blocked_review: 0,
    complete: 0,
    idle: 0,
    retry: 0,
    error: 0,
  } as Record<AgentStatus, number>;
  for (const s of sessions) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }
  return counts;
}

// Convenience: total blocked count (generic + all specific buckets) for the
// status-bar aggregate pill.
export function blockedTotal(counts: Record<AgentStatus, number>): number {
  return (
    counts.blocked +
    counts.blocked_permission +
    counts.blocked_question +
    counts.blocked_review
  );
}

export { isAPIModeAvailable };

export function getAgentTypeFromId(id: string): AgentType {
  if (id.startsWith('opencode-')) return 'opencode';
  if (id.startsWith('claude-')) return 'claude';
  if (id.startsWith('codex-')) return 'codex';
  if (id.startsWith('gemini-')) return 'gemini';
  return 'opencode';
}

// Re-export OpenCode action helpers so route handlers can resolve blocks.
export {
  replyOpenCodePermission,
  replyOpenCodeQuestion,
  rejectOpenCodeQuestion,
  abortOpenCodeSession,
};
