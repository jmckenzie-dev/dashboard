// Pure, I/O-free OpenCode status inference. Separated from opencode.ts so the
// algorithm is unit-testable by compiling this single self-contained module
// (it has only type-only imports, which `tsc` erases) and running it under
// plain `node`. opencode.ts re-imports these — there is exactly one source of
// truth for the algorithm. See docs/opencode-session-status.md §7.

import { isBlocked } from '../agents/types';
import type { AgentStatus, AgentPhase } from '../agents/types';
// Note: isBlocked is a non-type import used at runtime by inferPhase. This is
// fine — it is a pure function that does not pull in side-effects, so the
// "compile under plain node" property of this module is preserved.

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
  hasError: boolean;
  latestPartType: string | null;
  latestPartIsActiveTool: boolean;
} {
  if (parts.length === 0) return { latestTool: null, latestStepReason: null, hasError: false, latestPartType: null, latestPartIsActiveTool: false };

  // Newest first by time (stable for equal times).
  const ordered = [...parts].sort((a, b) => b.time - a.time);

  // Most recent part of any type (for phase inference).
  // ordered is sorted DESC by time. Within equal-time groups, the API path
  // builds parts in forward chronological order (stable-sort preserved), so
  // the last element in the max-time group is the most recent part. The SQLite
  // path uses ORDER BY time_created DESC; within equal timestamps ordering is
  // undefined, so the forward walk is still the best heuristic.
  let latestPartType: string | null = null;
  let latestPartIsActiveTool: boolean = false;
  if (ordered.length > 0) {
    const maxTime = ordered[0].time;
    // Walk forward through the max-time prefix to find its last element.
    let end = 0;
    while (end < ordered.length && ordered[end].time === maxTime) {
      end++;
    }
    const latestOverall = ordered[end - 1];
    latestPartType = latestOverall.type;
    latestPartIsActiveTool = latestOverall.type === 'tool'
      && (latestOverall.status === 'pending' || latestOverall.status === 'running');
  }

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

  // Error is scoped to the latest relevant tool state. A historical tool error
  // must not mask a newer active blocking tool such as `submit_plan`.
  const hasError = latestTool?.status === 'error';

  let latestStepReason: string | null = null;
  for (const p of ordered) {
    if (p.type === 'step-finish' && p.reason) {
      latestStepReason = String(p.reason);
      break;
    }
  }

  return { latestTool, latestStepReason, hasError, latestPartType, latestPartIsActiveTool };
}

export interface OpencodeStatusInput {
  sessionStatus: SessionStatusType | null;
  latestTool: LatestToolInfo | null;
  latestStepReason: string | null;
  hasPermission: boolean;
  hasQuestion: boolean;
  lastActivityMs: number;
  hasError?: boolean;
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
    hasError,
  } = input;

  const toolName = latestTool?.tool ?? '';
  const toolActive = !!latestTool?.active;

  // --- blocking states first (most specific, mutually exclusive) ---
  if (hasPermission) return 'blocked_permission';
  if (hasQuestion) return 'blocked_question';
  // submit_plan/plan_exit park on a running tool part; no staleness cutoff
  // (96h reviews).
  if ((toolName === 'submit_plan' || toolName === 'plan_exit') && toolActive) {
    return 'blocked_review';
  }
  // Durable fallback for the `question` tool when the live /question endpoint
  // is unavailable or the instance restarted mid-ask.
  if (toolName === 'question' && toolActive) return 'blocked_question';

  // --- current/latest tool error ---
  if (hasError) return 'error';

  // --- retry (folded under `working` in the UI, but distinct in the model) ---
  if (sessionStatus === 'retry') return 'retry';

  // --- actively working ---
  if (sessionStatus === 'busy') return 'working';
  if (
    toolActive &&
    toolName !== 'submit_plan' &&
    toolName !== 'plan_exit' &&
    toolName !== 'question'
  ) {
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

/**
 * Infer the current phase of an agent session based on status and the most
 * recent part type.
 *
 * Order matters: blocked/error statuses are authoritative; otherwise the latest
 * part type determines the phase. Reasoning → 🧠, active tool execution → 🔧,
 * text generation → 💬, blocked/idle → nothing.
 */
export function inferPhase(
  status: AgentStatus,
  latestPartType: string | null,
  latestPartIsActiveTool: boolean,
  latestTool: LatestToolInfo | null,
): AgentPhase {
  // Blocked/error statuses are authoritative phase signals.
  // Note: error maps to blocked phase for future UI use (e.g., showing ⚠️
  // alongside ❌). Currently the frontend does not consume phase for error
  // sessions — it shows ❌ via the status dot instead.
  if (isBlocked(status) || status === 'error') return 'blocked';
  if (status === 'complete' || status === 'idle') return 'idle';

  // For working/retry sessions, use the latest part type.
  if (latestPartType === 'reasoning') return 'reasoning';
  if (latestPartType === 'text') return 'generating';

  // Active tool execution (the latest part is a tool that's in flight).
  const toolName = latestTool?.tool ?? '';
  const isBlockingTool = toolName === 'submit_plan' || toolName === 'plan_exit' || toolName === 'question';
  if (latestPartIsActiveTool && !isBlockingTool) return 'using_tool';

  // Fallback: check if latestTool is active (catches cases where a tool part is
  // still running but not the absolute latest part due to ordering quirks).
  if (latestTool?.active && !isBlockingTool) return 'using_tool';

  // Default for working with no clear phase signal.
  return 'idle';
}
