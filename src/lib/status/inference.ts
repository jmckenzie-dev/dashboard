// Pure, I/O-free OpenCode status inference. Separated from opencode.ts so the
// algorithm is unit-testable by compiling this single self-contained module
// (it has only type-only imports, which `tsc` erases) and running it under
// plain `node`. opencode.ts re-imports these — there is exactly one source of
// truth for the algorithm. See docs/opencode-session-status.md §7.

import type { AgentStatus } from '../agents/types';

// `/session/status` entry type (v1). `idle` is computed by absence on the wire,
// but inference accepts it explicitly for completeness.
export type SessionStatusType = 'idle' | 'busy' | 'retry';

// A turn-scoped view of the most recent tool part for a session. `active` is
// true only when the tool is genuinely in flight (doc §6.4).
export interface LatestToolInfo {
  tool: string;
  callID: string;
  status: string;
  time: number;
  active: boolean;
}

// A part normalized to the fields inference cares about.
export interface NormalizedPart {
  type: string;
  tool?: string;
  callID?: string;
  status?: string;
  reason?: string;
  time: number;
}

// How long a naturally-finished session shows as `complete` before decaying to
// `idle` ("Complete (idle < 5 minutes)").
export const COMPLETE_FRESH_MS = 5 * 60 * 1000;
// Ambiguous-activity grace: very recent activity with no other signal is
// treated as `working`. Kept small (doc §7 tuning notes) to avoid stale reads.
export const WORKING_GRACE_MS = 10_000;

// Turn-scoped latest-tool detection. A tool is "active" only when in flight,
// not terminalised by a later part with the same callID, and no natural
// `step-finish` (reason=stop) occurred after it. This is the core fix for the
// stale-`running` false positives (doc §6.4).
export function analyzeParts(parts: NormalizedPart[]): {
  latestTool: LatestToolInfo | null;
  latestStepReason: string | null;
} {
  if (parts.length === 0) return { latestTool: null, latestStepReason: null };

  // Newest first by time (stable for equal times).
  const ordered = [...parts].sort((a, b) => b.time - a.time);

  // Most recent natural-stop boundary (reason === 'stop').
  let lastStopTime = 0;
  for (const p of ordered) {
    if (p.type === 'step-finish' && p.reason === 'stop' && p.time > lastStopTime) {
      lastStopTime = p.time;
    }
  }

  // Most recent tool part.
  let latest: NormalizedPart | null = null;
  for (const p of ordered) {
    if (p.type === 'tool') {
      latest = p;
      break;
    }
  }

  // callIDs with any terminal part (defense-in-depth for duplicate/out-of-order).
  const terminalCallIDs = new Set<string>();
  for (const p of ordered) {
    if (p.type === 'tool' && (p.status === 'completed' || p.status === 'error') && p.callID) {
      terminalCallIDs.add(p.callID);
    }
  }

  let latestTool: LatestToolInfo | null = null;
  if (latest) {
    const status = latest.status ?? '';
    const callID = latest.callID ?? '';
    const tool = latest.tool ?? '';
    const inFlight = status === 'pending' || status === 'running';
    const terminated = callID !== '' && terminalCallIDs.has(callID);
    const turnEnded = latest.time <= lastStopTime;
    latestTool = {
      tool,
      callID,
      status,
      time: latest.time,
      active: inFlight && !terminated && !turnEnded,
    };
  }

  let latestStepReason: string | null = null;
  for (const p of ordered) {
    if (p.type === 'step-finish' && p.reason) {
      latestStepReason = String(p.reason);
      break;
    }
  }

  return { latestTool, latestStepReason };
}

export interface OpencodeStatusInput {
  sessionStatus: SessionStatusType | null;
  latestTool: LatestToolInfo | null;
  latestStepReason: string | null;
  hasPermission: boolean;
  hasQuestion: boolean;
  lastActivityMs: number;
}

// The authoritative status algorithm (doc §7). Blocking states are checked
// first and are mutually exclusive; no staleness cutoff is applied inside
// `blocked_review` (plan reviews legitimately last up to 96h).
export function inferOpencodeStatus(input: OpencodeStatusInput): AgentStatus {
  const {
    sessionStatus,
    latestTool,
    latestStepReason,
    hasPermission,
    hasQuestion,
    lastActivityMs,
  } = input;

  const toolName = latestTool?.tool ?? '';
  const toolActive = !!latestTool?.active;

  // --- blocking states first (most specific, mutually exclusive) ---
  if (hasPermission) return 'blocked_permission';
  if (hasQuestion) return 'blocked_question';
  // submit_plan parks on a running tool part; no staleness cutoff (96h reviews).
  if (toolName === 'submit_plan' && toolActive) return 'blocked_review';
  // Durable fallback for the `question` tool when the live /question endpoint
  // is unavailable or the instance restarted mid-ask.
  if (toolName === 'question' && toolActive) return 'blocked_question';

  // --- retry (folded under `working` in the UI, but distinct in the model) ---
  if (sessionStatus === 'retry') return 'retry';

  // --- actively working ---
  if (sessionStatus === 'busy') return 'working';
  if (toolActive && toolName !== 'submit_plan' && toolName !== 'question') {
    return 'working';
  }

  // --- complete (finished naturally, within the fresh window) ---
  if (latestStepReason === 'stop' && !toolActive) {
    return lastActivityMs < COMPLETE_FRESH_MS ? 'complete' : 'idle';
  }

  // --- ambiguous stale activity ---
  if (lastActivityMs < WORKING_GRACE_MS) return 'working';
  return 'idle';
}
