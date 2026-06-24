export type AgentType = 'opencode' | 'claude' | 'codex' | 'gemini';

// Status union. The `blocked_*` variants are OpenCode-specific (API-backed);
// generic `blocked` is retained for the regex-based agents (claude/codex/gemini).
// `retry` is a real `/session/status` state; the UI folds it under `working`
// with a "retrying" sub-label, but it remains distinct in the data model so the
// retry count can be surfaced and transitions tracked.
export type AgentStatus =
  | 'working'
  | 'blocked'
  | 'blocked_permission'
  | 'blocked_question'
  | 'blocked_review'
  | 'complete'
  | 'idle'
  | 'retry'
  | 'error';

export type AgentPhase = 'reasoning' | 'generating' | 'using_tool' | 'blocked' | 'idle';

export type BlockReason = 'permission' | 'question' | 'review';

export function isBlocked(status: AgentStatus): boolean {
  return (
    status === 'blocked' ||
    status === 'blocked_permission' ||
    status === 'blocked_question' ||
    status === 'blocked_review'
  );
}

export function blockReasonOf(status: AgentStatus): BlockReason | null {
  switch (status) {
    case 'blocked_permission':
      return 'permission';
    case 'blocked_question':
      return 'question';
    case 'blocked_review':
      return 'review';
    default:
      return null;
  }
}

export interface AgentSession {
  id: string;
  parentId?: string;
  type: AgentType;
  name: string;
  summary: string;
  status: AgentStatus;
  project?: string;
  directory?: string;
  lastActivity: Date;
  pid?: number;
  pty?: string;
  messages: AgentMessage[];
  canSendInput: boolean;
  isActiveInstance?: boolean;
  mode?: string;
  phase?: AgentPhase;
  // Why a session is blocked (only set for blocked_* statuses).
  blockReason?: BlockReason | null;
  // True when we have positive evidence the owning instance is reachable
  // (in the busy status map, or its directory matches a live `/path` probe).
  // Undefined when liveness is unknown (see docs/opencode-liveness-phase2.md).
  instanceAlive?: boolean;
  // OpenCode request IDs backing a block (per_* / que_*), so the UI can act.
  blockingRequestIds?: string[];
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export interface AgentConfig {
  enabled: boolean;
  dbPath?: string;
  historyPath?: string;
  projectsPath?: string;
  configPath?: string;
  apiBase?: string;
  directory?: string;
  username?: string;
  password?: string;
}

export interface DashboardConfig {
  server: {
    host: string;
    port: number;
  };
  auth: {
    username: string;
    passwordHash: string;
  };
  tls: {
    certPath: string;
    keyPath: string;
  };
  llm: {
    endpoint: string;
    model: string;
    summaryMaxTokens: number;
    summaryPrompt: string;
  };
  polling: {
    intervalMs: number;
  };
  notifications: {
    blocked: NotificationConfig;
    complete: NotificationConfig;
  };
  agents: {
    opencode: AgentConfig;
    claude: AgentConfig;
    codex: AgentConfig;
    gemini: AgentConfig;
  };
}

export interface NotificationConfig {
  sound: string | null;
  skill: string | null;
}

export interface StatusTransition {
  sessionId: string;
  agentType: AgentType;
  fromStatus: AgentStatus;
  toStatus: AgentStatus;
  timestamp: Date;
}

export function getStatusRank(status: AgentStatus): number {
  switch (status) {
    case 'error':
      return 1;
    case 'blocked_permission':
    case 'blocked_question':
    case 'blocked':
      return 2;
    case 'blocked_review':
      return 3;
    case 'working':
    case 'retry':
      return 4;
    case 'complete':
      return 5;
    case 'idle':
    default:
      return 6;
  }
}

export function compareSessions(
  a: { status: AgentStatus; lastActivity: Date | string },
  b: { status: AgentStatus; lastActivity: Date | string }
): number {
  const rankA = getStatusRank(a.status);
  const rankB = getStatusRank(b.status);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  const timeA = a.lastActivity instanceof Date ? a.lastActivity.getTime() : new Date(a.lastActivity).getTime();
  const timeB = b.lastActivity instanceof Date ? b.lastActivity.getTime() : new Date(b.lastActivity).getTime();
  return timeB - timeA;
}

