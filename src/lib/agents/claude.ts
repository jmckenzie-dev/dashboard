import type { AgentSession, AgentMessage } from '../agents/types';
import { classifyStatus } from '../status/patterns';
import { loadConfig } from '../config';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

interface ClaudeHistoryEntry {
  display: string;
  pastedContents?: Record<string, unknown>;
  timestamp: number;
  project: string;
  sessionId: string;
}

function findClaudeProcesses(): Map<string, number> {
  const pidMap = new Map<string, number>();
  
  try {
    const output = execSync('pgrep -f "claude" 2>/dev/null || true', { encoding: 'utf-8' });
    const pids = output.trim().split('\n').filter(Boolean).map(Number);
    
    for (const pid of pids) {
      try {
        const cmd = execSync(`cat /proc/${pid}/cmdline 2>/dev/null || echo ""`, { encoding: 'utf-8' });
        if (cmd.includes('claude') && !cmd.includes('grep')) {
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

async function parseHistoryFile(path: string): Promise<ClaudeHistoryEntry[]> {
  if (!existsSync(path)) return [];
  
  const content = await readFile(path, 'utf-8');
  const entries: ClaudeHistoryEntry[] = [];
  
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ClaudeHistoryEntry;
      entries.push(entry);
    } catch {}
  }
  
  return entries;
}

async function getProjectDirectories(projectsPath: string): Promise<string[]> {
  if (!existsSync(projectsPath)) return [];
  
  const dirs: string[] = [];
  const entries = await readdir(projectsPath, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    }
  }
  
  return dirs;
}

export async function getClaudeSessions(): Promise<AgentSession[]> {
  const config = await loadConfig();
  const agentConfig = config.agents.claude;
  
  if (!agentConfig.enabled || !agentConfig.historyPath) return [];
  
  const pidMap = findClaudeProcesses();
  const history = await parseHistoryFile(agentConfig.historyPath);
  
  const sessionsMap = new Map<string, ClaudeHistoryEntry[]>();
  
  for (const entry of history) {
    const key = entry.sessionId || entry.project;
    if (!sessionsMap.has(key)) {
      sessionsMap.set(key, []);
    }
    sessionsMap.get(key)!.push(entry);
  }
  
  const result: AgentSession[] = [];
  
  for (const [sessionId, entries] of sessionsMap) {
    const latestEntry = entries[entries.length - 1];
    const projectPath = latestEntry.project || '';
    
    const messages: AgentMessage[] = entries.slice(-20).map((e, i) => ({
      id: `claude-msg-${sessionId}-${i}`,
      role: 'user' as const,
      content: e.display || '',
      timestamp: new Date(e.timestamp)
    }));
    
    const recentContent = messages.map(m => m.content).join('\n');
    const lastActivity = new Date(latestEntry.timestamp);
    const lastActivityMs = Date.now() - latestEntry.timestamp;
    
    const pid = pidMap.get(projectPath);
    const pty = pid ? getPTYForPid(pid) : null;
    
    result.push({
      id: `claude-${sessionId}`,
      type: 'claude',
      name: projectPath.split('/').pop() || 'Claude Session',
      summary: '',
      status: classifyStatus('claude', recentContent, lastActivityMs),
      project: projectPath,
      directory: projectPath,
      lastActivity,
      pid,
      pty: pty || undefined,
      messages,
      canSendInput: !!pty
    });
  }
  
  return result.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime()).slice(0, 20);
}

export async function sendClaudeMessage(sessionId: string, message: string): Promise<boolean> {
  const config = await loadConfig();
  
  const sessions = await getClaudeSessions();
  const session = sessions.find(s => s.id === sessionId);
  
  if (!session?.pty) return false;
  
  try {
    execSync(`echo ${JSON.stringify(message + '\n')} > ${session.pty}`, { encoding: 'utf-8' });
    return true;
  } catch (error) {
    console.error('Failed to send Claude message via PTY:', error);
    return false;
  }
}
