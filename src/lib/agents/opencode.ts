import type { AgentSession, AgentMessage } from './types';
import { loadConfig } from '../config';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';

type DatabaseType = typeof Database;

let sqlite3: DatabaseType | null = null;

async function getSQLite(): Promise<DatabaseType> {
  if (!sqlite3) {
    const module = await import('better-sqlite3');
    sqlite3 = module.default || module as unknown as DatabaseType;
  }
  return sqlite3;
}

interface OpenCodeSessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}

interface OpenCodePartRow {
  id: string;
  session_id: string;
  message_id: string;
  time_created: number;
  data: string;
}

interface OpenCodeSessionStatusResponse {
  type: 'idle' | 'busy' | 'retry';
  attempt?: number;
  message?: string;
  next?: number;
}

type OpenCodeSessionStatus = 'idle' | 'busy' | 'retry';

interface ParsedPartData {
  messages: AgentMessage[];
  latestToolStatus: string | null;
  latestStepReason: string | null;
  lastPartTime: number | null;
}

function toEpochMs(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  const numeric = Math.trunc(value as number);
  if (numeric <= 0) return 0;

  if (numeric < 1e11) {
    return numeric * 1000;
  }

  if (numeric < 1e14) {
    return numeric;
  }

  if (numeric < 1e17) {
    return Math.trunc(numeric / 1000);
  }

  return Math.trunc(numeric / 1_000_000);
}

function toDate(value: number | null | undefined): Date {
  return new Date(toEpochMs(value));
}

function parsePartData(parts: OpenCodePartRow[]): ParsedPartData {
  const messages: AgentMessage[] = [];
  let latestToolStatus: string | null = null;
  let latestStepReason: string | null = null;
  let lastPartTime: number | null = null;

  for (const part of parts.reverse()) {
    let data: any;
    try {
      data = JSON.parse(part.data);
    } catch {
      continue;
    }

    if (!lastPartTime || part.time_created > lastPartTime) {
      lastPartTime = part.time_created;
    }

    if (data.type === 'tool' && data.state?.status) {
      latestToolStatus = String(data.state.status);
    }

    if (data.type === 'step-finish' && data.reason) {
      latestStepReason = String(data.reason);
    }

    if (data.type === 'text' && typeof data.text === 'string' && data.text.trim()) {
      messages.push({
        id: part.id,
        role: 'assistant',
        content: data.text,
        timestamp: toDate(part.time_created)
      });
      continue;
    }

    if (data.type === 'reasoning' && typeof data.text === 'string' && data.text.trim()) {
      messages.push({
        id: part.id,
        role: 'assistant',
        content: data.text,
        timestamp: toDate(part.time_created)
      });
      continue;
    }

    if (data.type === 'tool') {
      const tool = data.tool ? `tool:${data.tool}` : 'tool';
      const status = data.state?.status ? ` status:${data.state.status}` : '';
      const output = typeof data.state?.output === 'string' ? data.state.output.slice(0, 200) : '';
      const text = `${tool}${status}${output ? ` output:${output}` : ''}`.trim();
      if (text) {
        messages.push({
          id: part.id,
          role: 'system',
          content: text,
          timestamp: toDate(part.time_created)
        });
      }
    }
  }

  const trimmed = messages.slice(-25);
  return {
    messages: trimmed,
    latestToolStatus,
    latestStepReason,
    lastPartTime
  };
}

function inferOpencodeStatus(
  sessionStatus: OpenCodeSessionStatus | null,
  latestToolStatus: string | null,
  latestStepReason: string | null,
  lastActivityMs: number,
) {
  if (sessionStatus === 'retry') return 'retry';
  if (sessionStatus === 'busy') return 'working';

  if (latestToolStatus === 'running' || latestToolStatus === 'pending') {
    return 'working';
  }

  if (latestStepReason && !['tool-calls', 'unknown'].includes(latestStepReason)) {
    if (lastActivityMs > 45_000) return 'complete';
    return 'working';
  }

  if (sessionStatus === 'idle') return 'complete';

  return lastActivityMs < 60_000 ? 'working' : 'idle';
}

async function checkAPIServer(apiBase: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const response = await fetch(`${apiBase}/session`, {
      signal: controller.signal,
      headers: { 'x-opencode-directory': '/' }
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

async function getSessionsViaAPI(apiBase: string): Promise<AgentSession[]> {
  try {
    const response = await fetch(`${apiBase}/session`, {
      headers: { 'x-opencode-directory': '/' }
    });
    if (!response.ok) return [];
    
    const sessions = await response.json() as Array<{
      id: string;
      parent_id?: string | null;
      parentId?: string | null;
      title: string;
      directory: string;
      time: { created: number; updated: number };
    }>;
    
    const statusResponse = await fetch(`${apiBase}/session/status`, {
      headers: { 'x-opencode-directory': '/' }
    });
    const statusData = statusResponse.ok
      ? await statusResponse.json() as Record<string, OpenCodeSessionStatusResponse>
      : {};

    const result: AgentSession[] = [];
    
    for (const session of sessions) {
      const msgResponse = await fetch(`${apiBase}/session/${session.id}/message`, {
        headers: { 'x-opencode-directory': session.directory || '/' }
      });
      
      let messages: AgentMessage[] = [];
      let latestToolStatus: string | null = null;
      let latestStepReason: string | null = null;
      let currentMode: string | undefined;

      if (msgResponse.ok) {
        const msgData = await msgResponse.json() as Array<{
          info: {
            id: string;
            role: string;
            agent?: string;
            time?: { created?: number };
          };
          parts: Array<{ type: string; text?: string; state?: { status?: string }; reason?: string }>;
        }>;
        for (const message of msgData.slice(-10)) {
          // Track the agent/mode from the most recent message that has it
          if (message.info.agent) {
            currentMode = message.info.agent;
          }

          for (const part of message.parts) {
            if (part.type === 'tool' && part.state?.status) {
              latestToolStatus = String(part.state.status);
            }

            if (part.type === 'step-finish' && part.reason) {
              latestStepReason = String(part.reason);
            }

            if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
              messages.push({
                id: message.info.id,
                role: message.info.role as 'user' | 'assistant' | 'system',
                content: part.text,
                timestamp: toDate(message.info.time?.created ?? Date.now())
              });
            }
          }
        }
      }
      
      const lastActivity = toDate(session.time.updated);
      const lastActivityMs = Date.now() - lastActivity.getTime();
      const parentRaw = session.parent_id || session.parentId || null;
      
      const sessionStatus = statusData[session.id]?.type ?? null;
      const hasActiveInstance = Object.prototype.hasOwnProperty.call(statusData, session.id);

      result.push({
        id: `opencode-${session.id}`,
        parentId: parentRaw ? `opencode-${parentRaw}` : undefined,
        type: 'opencode',
        name: session.title || 'Untitled Session',
        summary: '',
        status: inferOpencodeStatus(
          sessionStatus,
          latestToolStatus,
          latestStepReason,
          lastActivityMs,
        ),
        directory: session.directory,
        lastActivity,
        messages,
        canSendInput: true,
        isActiveInstance: hasActiveInstance,
        mode: currentMode
      });
    }
    
    return result;
  } catch (error) {
    console.error('OpenCode API error:', error);
    return [];
  }
}

async function getSessionsViaSQLite(dbPath: string): Promise<AgentSession[]> {
  if (!existsSync(dbPath)) return [];
  
  try {
    const DatabaseConstructor = await getSQLite();
    const db = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    
    const sessions = db.prepare(`
      SELECT id, project_id, parent_id, directory, title, time_created, time_updated
      FROM session
      ORDER BY time_updated DESC
      LIMIT 50
    `).all() as OpenCodeSessionRow[];
    
    const result: AgentSession[] = [];
    
    for (const session of sessions) {
      const parts = db.prepare(`
        SELECT id, session_id, message_id, time_created, data
        FROM part
        WHERE session_id = ?
        ORDER BY time_created DESC
        LIMIT 80
      `).all(session.id) as OpenCodePartRow[];

      const parsed = parsePartData(parts);
      const lastTime = parsed.lastPartTime ?? session.time_updated;
      const lastActivity = toDate(lastTime);
      const lastActivityMs = Date.now() - lastActivity.getTime();
      
      result.push({
        id: `opencode-${session.id}`,
        parentId: session.parent_id ? `opencode-${session.parent_id}` : undefined,
        type: 'opencode',
        name: session.title || 'Untitled Session',
        summary: '',
        status: inferOpencodeStatus(
          null,
          parsed.latestToolStatus,
          parsed.latestStepReason,
          lastActivityMs,
        ),
        directory: session.directory,
        lastActivity,
        messages: parsed.messages,
        canSendInput: false
      });
    }
    
    db.close();
    return result;
  } catch (error) {
    console.error('OpenCode SQLite error:', error);
    return [];
  }
}

export async function getOpenCodeSessions(): Promise<AgentSession[]> {
  const config = await loadConfig();
  const agentConfig = config.agents.opencode;
  
  if (!agentConfig.enabled) return [];
  
  if (agentConfig.apiBase) {
    const apiAvailable = await checkAPIServer(agentConfig.apiBase);
    if (apiAvailable) {
      return getSessionsViaAPI(agentConfig.apiBase);
    }
  }
  
  if (agentConfig.dbPath) {
    return getSessionsViaSQLite(agentConfig.dbPath);
  }
  
  return [];
}

export async function sendOpenCodeMessage(sessionId: string, message: string): Promise<boolean> {
  const config = await loadConfig();
  const apiBase = config.agents.opencode.apiBase;
  
  if (!apiBase) return false;
  
  try {
    const cleanSessionId = sessionId.replace('opencode-', '');
    
    const sessions = await getSessionsViaAPI(apiBase);
    const session = sessions.find(s => s.id === sessionId);
    
    const response = await fetch(`${apiBase}/session/${cleanSessionId}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-opencode-directory': session?.directory || '/'
      },
      body: JSON.stringify({
        parts: [{ type: 'text', text: message }]
      })
    });
    
    return response.ok;
  } catch (error) {
    console.error('Failed to send OpenCode message:', error);
    return false;
  }
}

export function isAPIModeAvailable(): Promise<boolean> {
  return loadConfig().then(config => {
    if (!config.agents.opencode.apiBase) return Promise.resolve(false);
    return checkAPIServer(config.agents.opencode.apiBase);
  });
}
