// Queryability API: returns a comprehensive dump of the dashboard's internal
// state for LLM/agent consumption. Designed to answer questions like:
// - "What sessions are currently visible?"
// - "What processes are backing each session?"
// - "What blocking states exist?"
// - "Why is session X visible or not?"
//
// This is the verification tool for the status resolution fixes.

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadConfig } from '$lib/config';
import { checkAuth, requireAuth } from '$lib/auth';
import {
  getAllSessions,
  countStatuses,
  blockedTotal,
} from '$lib/agents';
import {
  getOpenCodeSessions,
  getOpenCodeSessionsWithDiagnostics,
} from '$lib/agents/opencode';
import type { DiagnosticAgentSession, SessionDiagnostic } from '$lib/agents/opencode';
import { scanProcesses } from '$lib/process/poller';
import { isBlocked } from '$lib/agents/types';
import type { AgentSession } from '$lib/agents/types';

function describeSession(s: AgentSession, visible: boolean, diagnostic?: SessionDiagnostic) {
  const base = {
    id: s.id,
    parentId: s.parentId ?? null,
    type: s.type,
    name: s.name,
    status: s.status,
    blockReason: s.blockReason ?? null,
    isBlocked: isBlocked(s.status),
    directory: s.directory ?? null,
    project: s.project ?? null,
    pid: s.pid ?? null,
    isActiveInstance: s.isActiveInstance ?? false,
    instanceAlive: s.instanceAlive ?? null,
    livenessReason: s.livenessReason ?? null,
    visibilityReason: s.visibilityReason ?? null,
    visible,
    canSendInput: s.canSendInput,
    lastActivity: s.lastActivity.toISOString(),
    lastActivityAgeMs: Date.now() - s.lastActivity.getTime(),
    messageCount: s.messages.length,
    blockingRequestIds: s.blockingRequestIds ?? [],
  };
  return diagnostic ? { ...base, diagnostic: describeDiagnostic(diagnostic) } : base;
}

// Compact, JSON-safe view of a SessionDiagnostic. Dates are absent here (the
// diagnostic carries epoch-ms times on parts/tool). We keep the inference
// inputs verbatim so a reader can reconstruct exactly why inferOpencodeStatus
// returned the session's status.
function describeDiagnostic(d: SessionDiagnostic) {
  return {
    sessionStatus: d.sessionStatus,
    hasActiveInstance: d.hasActiveInstance,
    permIds: d.permIds,
    questIds: d.questIds,
    latestTool: d.latestTool,
    latestStepReason: d.latestStepReason,
    hasError: d.hasError,
    latestPartType: d.latestPartType,
    latestPartIsActiveTool: d.latestPartIsActiveTool,
    lastActivityMs: d.lastActivityMs,
    inferenceInput: d.inferenceInput,
    livenessCandidate: d.livenessCandidate,
    parts: d.parts,
  };
}

export const GET: RequestHandler = async (event) => {
  const config = await loadConfig();

  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }

  const processScan = scanProcesses();

  const sessions = await getAllSessions();
  const opencodeCandidates = await getOpenCodeSessionsWithDiagnostics({ includeHidden: true });
  const visibleSessionIds = new Set(sessions.map((s) => s.id));
  const hiddenOpenCodeSessions = opencodeCandidates.filter(
    (s): s is DiagnosticAgentSession => !visibleSessionIds.has(s.id),
  );
  const diagnosticById = new Map(opencodeCandidates.map((s) => [s.id, s.diagnostic]));
  const counts = countStatuses(sessions);

  // Detailed session diagnostics
  const sessionDetails = sessions.map((s) =>
    describeSession(s, true, diagnosticById.get(s.id)),
  );
  const hiddenSessionDetails = hiddenOpenCodeSessions.map((s) =>
    describeSession(s, false, s.diagnostic),
  );

  // Build the parent→child tree for analysis
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const parentChildMap = new Map<string, string[]>();
  for (const s of sessions) {
    if (s.parentId && byId.has(s.parentId)) {
      const list = parentChildMap.get(s.parentId) ?? [];
      list.push(s.id);
      parentChildMap.set(s.parentId, list);
    }
  }
  const parentChildEntries = [...parentChildMap.entries()].map(
    ([parentId, childIds]) => ({ parentId, childIds }),
  );

  // Process inventory diagnostics
  const processInfo = {
    totalProcesses: processScan.processes.length,
    processes: processScan.processes.map((p) => ({
      pid: p.pid,
      cwd: p.cwd,
      sessionId: p.sessionId,
      port: p.port ?? null,
      isServe: p.isServe,
      cwdRead: p.cwdRead ? {
        pid: p.cwdRead.pid,
        status: p.cwdRead.status,
        cwd: p.cwdRead.cwd,
        method: p.cwdRead.method,
        error: p.cwdRead.error ?? null,
      } : null,
    })),
    servePorts: processScan.servePorts,
    liveDirectories: processScan.liveDirectories,
    liveSessionIds: processScan.liveSessionIds,
    directSessionIds: processScan.directSessionIds,
    directoryProcessCounts: processScan.directoryProcessCounts,
    cwdReadDiagnostics: processScan.cwdReadDiagnostics.map((cwdRead) => ({
      pid: cwdRead.pid,
      status: cwdRead.status,
      cwd: cwdRead.cwd,
      method: cwdRead.method,
      error: cwdRead.error ?? null,
    })),
    cwdReadErrors: processScan.cwdReadDiagnostics
      .filter((cwdRead) => cwdRead.status !== 'ok')
      .map((cwdRead) => ({
        pid: cwdRead.pid,
        status: cwdRead.status,
        cwd: cwdRead.cwd,
        method: cwdRead.method,
        error: cwdRead.error ?? null,
      })),
    scanSucceeded: processScan.scanSucceeded,
  };

  // Config diagnostics
  const agentConfig = {
    opencode: {
      enabled: config.agents.opencode.enabled,
      hasDbPath: !!config.agents.opencode.dbPath,
      hasApiBase: !!config.agents.opencode.apiBase,
      apiBase: config.agents.opencode.apiBase ?? null,
      dbPath: config.agents.opencode.dbPath ?? null,
    },
    claude: {
      enabled: config.agents.claude.enabled,
      hasHistoryPath: !!config.agents.claude.historyPath,
    },
    codex: {
      enabled: config.agents.codex.enabled,
      hasHistoryPath: !!config.agents.codex.historyPath,
    },
    gemini: {
      enabled: config.agents.gemini.enabled,
      hasHistoryPath: !!config.agents.gemini.historyPath,
    },
  };

  // Gap analysis: which fixes are in effect
  const gapAnalysis = {
    hasProcessScanning: processScan.scanSucceeded,
    processScannedProcesses: processScan.processes.length,
    sessionsWithProcessBacking: sessions.filter((s) => s.instanceAlive === true).length,
    sessionsWithPid: sessions.filter((s) => s.pid != null).length,
    sessionsWithActiveInstance: sessions.filter((s) => s.isActiveInstance).length,
    hierarchicalBlockingApplied: parentChildEntries.length > 0,
    sessionsWithErrorStatus: sessions.filter((s) => s.status === 'error').length,
    blockedSessions: sessions.filter((s) => isBlocked(s.status)).length,
    visibleSessionCount: sessions.length,
    hiddenOpenCodeSessionCount: hiddenOpenCodeSessions.length,
    allStatusCounts: counts,
    blockedTotal: blockedTotal(counts),
  };

  return json({
    _meta: {
      description: 'Dashboard State Diagnosis API',
      version: '1.0',
      timestamp: new Date().toISOString(),
      generated_for: 'LLM/agent queryability — structured system state inspection',
    },
    gap_analysis: gapAnalysis,
    session_tree: parentChildEntries,
    sessions: sessionDetails,
    hidden_sessions: hiddenSessionDetails,
    processes: processInfo,
    agent_config: agentConfig,
    opencode_visibility: {
      visible_reasons: [
        'status_map',
        'blocking_request',
        'active_tool',
        'process_session_id',
        'cwd_allocated',
        'recent_active_fallback',
      ],
      hidden_reason: 'hidden_stale',
      unknown_liveness_value: null,
    },
    visibility_windows: {
      applies_to: 'generic_agents_only',
      recent_window_seconds: 600,
      blocked_window_seconds: 7200,
      complete_window_seconds: 1800,
      working_grace_seconds: 10,
    },
  });
};
