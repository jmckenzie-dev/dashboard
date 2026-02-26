import type { AgentSession, AgentMessage } from './types';
import { classifyStatus } from '../status/patterns';
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

interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface OpenCodePartRow {
  id: string;
  session_id: string;
  message_id: string;
  time_created: number;
  data: string;
}

interface ParsedPartData {
  messages: AgentMessage[];
  recentContent: string;
  latestToolStatus: string | null;
  latestStepReason: string | null;
  lastPartTime: number | null;
}

function parsePartData(parts: OpenCodePartRow[]): ParsedPartData {
  const messages: AgentMessage[] = [];
  const statusText: string[] = [];
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
      statusText.push(data.text);
      messages.push({
        id: part.id,
        role: 'assistant',
        content: data.text,
        timestamp: new Date(part.time_created)
      });
      continue;
    }

    if (data.type === 'reasoning' && typeof data.text === 'string' && data.text.trim()) {
      statusText.push(data.text);
      messages.push({
        id: part.id,
        role: 'assistant',
        content: data.text,
        timestamp: new Date(part.time_created)
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
          timestamp: new Date(part.time_created)
        });
      }
    }
  }

  const trimmed = messages.slice(-25);
  return {
    messages: trimmed,
    recentContent: statusText.slice(-8).join('\n'),
    latestToolStatus,
    latestStepReason,
    lastPartTime
  };
}

function inferOpencodeStatus(
  recentContent: string,
  lastActivityMs: number,
  latestToolStatus: string | null,
  latestStepReason: string | null,
) {
  const base = classifyStatus('opencode', recentContent, lastActivityMs);

  if (base === 'blocked') {
    return 'blocked';
  }

  if (base === 'complete' && lastActivityMs < 45_000) {
    return 'working';
  }

  if (latestToolStatus === 'running') {
    if (lastActivityMs > 90_000) return 'blocked';
    return 'working';
  }

  if (latestStepReason === 'stop' && lastActivityMs > 45_000) {
    return 'complete';
  }

  if (latestStepReason === 'tool-calls' && lastActivityMs > 90_000) {
    return 'blocked';
  }

  return base;
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
    
    const result: AgentSession[] = [];
    
    for (const session of sessions) {
      const msgResponse = await fetch(`${apiBase}/session/${session.id}/message`, {
        headers: { 'x-opencode-directory': session.directory || '/' }
      });
      
      let messages: AgentMessage[] = [];
      let recentContent = '';
      
      if (msgResponse.ok) {
        const msgs = await msgResponse.json() as Array<{
          id: string;
          role: string;
          content?: { parts?: Array<{ text?: string }> };
          time_created?: number;
        }>;
        
        messages = msgs.slice(-20).map(m => ({
          id: m.id,
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content?.parts?.map(p => p.text || '').join('') || '',
          timestamp: new Date(m.time_created || Date.now())
        }));
        
        recentContent = messages.map(m => m.content).join('\n');
      }
      
      const lastActivity = new Date(session.time.updated);
      const lastActivityMs = Date.now() - lastActivity.getTime();
      const parentRaw = session.parent_id || session.parentId || null;
      
      result.push({
        id: `opencode-${session.id}`,
        parentId: parentRaw ? `opencode-${parentRaw}` : undefined,
        type: 'opencode',
        name: session.title || 'Untitled Session',
        summary: '',
        status: inferOpencodeStatus(recentContent, lastActivityMs, null, null),
        directory: session.directory,
        lastActivity,
        messages,
        canSendInput: true
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
      const lastActivity = new Date(lastTime);
      const lastActivityMs = Date.now() - lastActivity.getTime();
      
      result.push({
        id: `opencode-${session.id}`,
        parentId: session.parent_id ? `opencode-${session.parent_id}` : undefined,
        type: 'opencode',
        name: session.title || 'Untitled Session',
        summary: '',
        status: inferOpencodeStatus(
          parsed.recentContent,
          lastActivityMs,
          parsed.latestToolStatus,
          parsed.latestStepReason,
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
