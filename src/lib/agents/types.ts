export type AgentType = 'opencode' | 'claude' | 'codex' | 'gemini';

export type AgentStatus = 'working' | 'blocked' | 'complete' | 'idle';

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
