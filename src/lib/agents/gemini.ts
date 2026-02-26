import type { AgentSession, AgentMessage } from '../agents/types';
import { classifyStatus } from '../status/patterns';
import { loadConfig } from '../config';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

interface GeminiState {
  defaultBannerShownCount?: Record<string, number>;
}

function findGeminiProcesses(): Map<string, number> {
  const pidMap = new Map<string, number>();
  
  try {
    const output = execSync('pgrep -f "gemini" 2>/dev/null || true', { encoding: 'utf-8' });
    const pids = output.trim().split('\n').filter(Boolean).map(Number);
    
    for (const pid of pids) {
      try {
        const cmd = execSync(`cat /proc/${pid}/cmdline 2>/dev/null || echo ""`, { encoding: 'utf-8' });
        if (cmd.includes('gemini') && !cmd.includes('grep')) {
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

async function readStateFile(path: string): Promise<GeminiState | null> {
  if (!existsSync(path)) return null;
  
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as GeminiState;
  } catch {
    return null;
  }
}

async function findTmpFiles(configPath: string): Promise<Array<{ path: string; mtime: number }>> {
  const tmpPath = join(configPath, 'tmp');
  if (!existsSync(tmpPath)) return [];
  
  const files: Array<{ path: string; mtime: number }> = [];
  
  try {
    const entries = await readdir(tmpPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
        const stat = await readFile(join(tmpPath, entry.name), 'utf-8').then(() => {
          return { path: join(tmpPath, entry.name), mtime: Date.now() };
        }).catch(() => null);
        
        if (stat) files.push(stat);
      }
    }
  } catch {}
  
  return files;
}

export async function getGeminiSessions(): Promise<AgentSession[]> {
  const config = await loadConfig();
  const agentConfig = config.agents.gemini;
  
  if (!agentConfig.enabled || !agentConfig.configPath) return [];
  
  const pidMap = findGeminiProcesses();
  const statePath = join(agentConfig.configPath, 'state.json');
  const state = await readStateFile(statePath);
  
  const result: AgentSession[] = [];
  
  if (pidMap.size > 0) {
    for (const [cwd, pid] of pidMap) {
      const pty = getPTYForPid(pid);
      
      const messages: AgentMessage[] = [{
        id: `gemini-msg-${pid}-0`,
        role: 'assistant',
        content: 'Gemini CLI session active',
        timestamp: new Date()
      }];
      
      result.push({
        id: `gemini-${pid}`,
        type: 'gemini',
        name: `Gemini (${cwd.split('/').pop() || 'session'})`,
        summary: '',
        status: 'working',
        project: cwd,
        directory: cwd,
        lastActivity: new Date(),
        pid,
        pty: pty || undefined,
        messages,
        canSendInput: !!pty
      });
    }
  }
  
  return result;
}

export async function sendGeminiMessage(sessionId: string, message: string): Promise<boolean> {
  const sessions = await getGeminiSessions();
  const session = sessions.find(s => s.id === sessionId);
  
  if (!session?.pty) return false;
  
  try {
    execSync(`echo ${JSON.stringify(message + '\n')} > ${session.pty}`, { encoding: 'utf-8' });
    return true;
  } catch (error) {
    console.error('Failed to send Gemini message via PTY:', error);
    return false;
  }
}
