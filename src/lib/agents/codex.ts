import type { AgentSession, AgentMessage } from '../agents/types';
import { classifyStatus } from '../status/patterns';
import { loadConfig } from '../config';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

interface CodexHistoryEntry {
  session_id: string;
  ts: number;
  text: string;
}

interface CodexSessionFileLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface ParsedCodexSession {
  sessionId: string;
  cwd?: string;
  lastActivity: Date;
  messages: AgentMessage[];
  recentContent: string;
  completed: boolean;
}

function findCodexProcesses(): Map<string, number> {
  const pidMap = new Map<string, number>();
  
  try {
    const output = execSync('pgrep -f "codex" 2>/dev/null || true', { encoding: 'utf-8' });
    const pids = output.trim().split('\n').filter(Boolean).map(Number);
    
    for (const pid of pids) {
      try {
        const cmd = execSync(`cat /proc/${pid}/cmdline 2>/dev/null || echo ""`, { encoding: 'utf-8' });
        if (cmd.includes('codex') && !cmd.includes('grep')) {
          const cwd = execSync(`readlink -f /proc/${pid}/cwd 2>/dev/null || echo ""`, { encoding: 'utf-8' }).trim();
          if (cwd) {
            pidMap.set(cwd, pid);
          }
        }
      } catch {}
    }
  } catch {}
  
  return pidMap;
}

function getPTYForPid(pid: number): string | null {
  try {
    const fd0 = execSync(`readlink /proc/${pid}/fd/0 2>/dev/null || echo ""`, { encoding: 'utf-8' }).trim();
    if (fd0.startsWith('/dev/pts/')) {
      return fd0;
    }
  } catch {}
  return null;
}

function swapVarHomePrefix(path: string): string {
  if (path.startsWith('/var/home/')) {
    return path.replace('/var/home/', '/home/');
  }
  if (path.startsWith('/home/')) {
    return path.replace('/home/', '/var/home/');
  }
  return path;
}

function getPidForCwd(pidMap: Map<string, number>, cwd?: string): number | undefined {
  if (!cwd) return undefined;
  const direct = pidMap.get(cwd);
  if (direct) return direct;
  const swapped = swapVarHomePrefix(cwd);
  if (swapped !== cwd) {
    return pidMap.get(swapped);
  }
  return undefined;
}

async function collectSessionFiles(path: string, files: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const textParts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const text = (item as Record<string, unknown>).text;
    if (typeof text === 'string' && text.trim()) {
      textParts.push(text.trim());
    }
  }
  return textParts.join('\n').trim();
}

function parseSessionIdFromPath(path: string): string {
  const match = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : path;
}

async function parseSessionFile(path: string): Promise<ParsedCodexSession | null> {
  const content = await readFile(path, 'utf-8');

  const messages: AgentMessage[] = [];
  const assistantText: string[] = [];
  let sessionId = parseSessionIdFromPath(path);
  let cwd: string | undefined;
  let lastActivity = new Date(0);
  let completed = false;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;

    let entry: CodexSessionFileLine;
    try {
      entry = JSON.parse(line) as CodexSessionFileLine;
    } catch {
      continue;
    }

    if (entry.timestamp) {
      const ts = new Date(entry.timestamp);
      if (!Number.isNaN(ts.getTime()) && ts.getTime() > lastActivity.getTime()) {
        lastActivity = ts;
      }
    }

    if (entry.type === 'session_meta' && entry.payload) {
      const id = entry.payload.id;
      const payloadCwd = entry.payload.cwd;
      if (typeof id === 'string' && id) sessionId = id;
      if (typeof payloadCwd === 'string' && payloadCwd) cwd = payloadCwd;
      continue;
    }

    if (entry.type === 'turn_context' && entry.payload) {
      const payloadCwd = entry.payload.cwd;
      if (typeof payloadCwd === 'string' && payloadCwd) cwd = payloadCwd;
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload) {
      const eventType = entry.payload.type;
      if (eventType === 'task_complete') {
        completed = true;
      }
      if (eventType === 'task_started') {
        completed = false;
      }
      if (eventType === 'agent_message') {
        const message = entry.payload.message;
        if (typeof message === 'string' && message.trim()) {
          assistantText.push(message);
          messages.push({
            id: `codex-msg-${sessionId}-${messages.length}`,
            role: 'assistant',
            content: message,
            timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
          });
        }
      }
      continue;
    }

    if (entry.type === 'response_item' && entry.payload) {
      const payloadType = entry.payload.type;
      const role = entry.payload.role;
      if (payloadType === 'message' && (role === 'user' || role === 'assistant')) {
        const text = extractMessageText(entry.payload.content);
        if (text) {
          const mappedRole = role === 'assistant' ? 'assistant' : 'user';
          if (mappedRole === 'assistant') {
            assistantText.push(text);
          }
          messages.push({
            id: `codex-msg-${sessionId}-${messages.length}`,
            role: mappedRole,
            content: text,
            timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
          });
        }
      }
    }
  }

  if (!sessionId || lastActivity.getTime() === 0) {
    return null;
  }

  return {
    sessionId,
    cwd,
    lastActivity,
    messages: messages.slice(-20),
    recentContent: assistantText.slice(-8).join('\n'),
    completed,
  };
}

async function parseSessionsDirectory(path: string): Promise<ParsedCodexSession[]> {
  if (!existsSync(path)) return [];

  const sessionFiles: string[] = [];
  await collectSessionFiles(path, sessionFiles);
  if (sessionFiles.length === 0) return [];

  const parsed = await Promise.all(
    sessionFiles.map(async (sessionFile) => {
      try {
        return await parseSessionFile(sessionFile);
      } catch {
        return null;
      }
    }),
  );

  const sessions = parsed.filter((session): session is ParsedCodexSession => session !== null);
  return sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
}

async function parseHistoryFile(path: string): Promise<CodexHistoryEntry[]> {
  if (!existsSync(path)) return [];
  
  const content = await readFile(path, 'utf-8');
  const entries: CodexHistoryEntry[] = [];
  
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CodexHistoryEntry;
      entries.push(entry);
    } catch {}
  }
  
  return entries;
}

export async function getCodexSessions(): Promise<AgentSession[]> {
  const config = await loadConfig();
  const agentConfig = config.agents.codex;
  
  if (!agentConfig.enabled || !agentConfig.historyPath) return [];

  const pidMap = findCodexProcesses();

  const sessionsDir = join(dirname(agentConfig.historyPath), 'sessions');
  const parsedSessions = await parseSessionsDirectory(sessionsDir);
  const result: AgentSession[] = [];

  if (parsedSessions.length > 0) {
    for (const session of parsedSessions) {
      const lastActivityMs = Date.now() - session.lastActivity.getTime();
      const pid = getPidForCwd(pidMap, session.cwd);
      const pty = pid ? getPTYForPid(pid) : null;

      result.push({
        id: `codex-${session.sessionId}`,
        type: 'codex',
        name: `Codex ${session.sessionId.slice(0, 8)}`,
        summary: '',
        status: session.completed ? 'complete' : classifyStatus('codex', session.recentContent, lastActivityMs),
        project: session.cwd,
        directory: session.cwd,
        lastActivity: session.lastActivity,
        pid,
        pty: pty || undefined,
        messages: session.messages,
        canSendInput: !!pty,
      });
    }

    return result
      .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())
      .slice(0, 20);
  }

  const history = await parseHistoryFile(agentConfig.historyPath);
  const sessionsMap = new Map<string, CodexHistoryEntry[]>();

  for (const entry of history) {
    if (!sessionsMap.has(entry.session_id)) {
      sessionsMap.set(entry.session_id, []);
    }
    sessionsMap.get(entry.session_id)!.push(entry);
  }

  for (const [sessionId, entries] of sessionsMap) {
    const latestEntry = entries[entries.length - 1];
    const messages: AgentMessage[] = entries.slice(-20).map((entry, index) => ({
      id: `codex-msg-${sessionId}-${index}`,
      role: 'user' as const,
      content: entry.text || '',
      timestamp: new Date(entry.ts * 1000),
    }));

    const lastActivity = new Date(latestEntry.ts * 1000);
    const lastActivityMs = Date.now() - lastActivity.getTime();
    const status = lastActivityMs < 60_000 ? 'working' : 'idle';

    result.push({
      id: `codex-${sessionId}`,
      type: 'codex',
      name: `Codex ${sessionId.slice(0, 8)}`,
      summary: '',
      status,
      lastActivity,
      messages,
      canSendInput: false,
    });
  }

  return result
    .sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())
    .slice(0, 20);
}

export async function sendCodexMessage(sessionId: string, message: string): Promise<boolean> {
  const sessions = await getCodexSessions();
  const session = sessions.find(s => s.id === sessionId);
  
  if (!session?.pty) return false;
  
  try {
    execSync(`echo ${JSON.stringify(message + '\n')} > ${session.pty}`, { encoding: 'utf-8' });
    return true;
  } catch (error) {
    console.error('Failed to send Codex message via PTY:', error);
    return false;
  }
}
