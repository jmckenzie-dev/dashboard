import type { AgentSession, AgentType, AgentStatus, StatusTransition } from './types';
import { getOpenCodeSessions, sendOpenCodeMessage, isAPIModeAvailable } from './opencode';
import { getClaudeSessions, sendClaudeMessage } from './claude';
import { getCodexSessions, sendCodexMessage } from './codex';
import { getGeminiSessions, sendGeminiMessage } from './gemini';

const previousStatus = new Map<string, AgentStatus>();
const transitionCallbacks: Array<(transition: StatusTransition) => void> = [];

export function onStatusTransition(callback: (transition: StatusTransition) => void): () => void {
  transitionCallbacks.push(callback);
  return () => {
    const index = transitionCallbacks.indexOf(callback);
    if (index > -1) transitionCallbacks.splice(index, 1);
  };
}

function checkTransitions(sessions: AgentSession[]): StatusTransition[] {
  const transitions: StatusTransition[] = [];
  
  for (const session of sessions) {
    const prev = previousStatus.get(session.id);
    
    if (prev && prev !== session.status) {
      const transition: StatusTransition = {
        sessionId: session.id,
        agentType: session.type,
        fromStatus: prev,
        toStatus: session.status,
        timestamp: new Date()
      };
      transitions.push(transition);
      
      for (const callback of transitionCallbacks) {
        try {
          callback(transition);
        } catch (error) {
          console.error('Status transition callback error:', error);
        }
      }
    }
    
    previousStatus.set(session.id, session.status);
  }
  
  return transitions;
}

export async function getAllSessions(): Promise<AgentSession[]> {
  const [opencode, claude, codex, gemini] = await Promise.all([
    getOpenCodeSessions(),
    getClaudeSessions(),
    getCodexSessions(),
    getGeminiSessions()
  ]);
  
  const all = [...opencode, ...claude, ...codex, ...gemini];
  checkTransitions(all);

  const now = Date.now();
  const recentWindow = now - 10 * 60 * 1000;
  const blockedWindow = now - 2 * 60 * 60 * 1000;
  const completeWindow = now - 30 * 60 * 1000;

  const activeSessions = all.filter(session => {
    const updated = session.lastActivity.getTime();
    if (session.pid) return true;
    if (updated > recentWindow) return true;
    if (session.status === "blocked" && updated > blockedWindow) return true;
    if (session.status === "complete" && updated > completeWindow) return true;
    return false;
  });
  
  return activeSessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
}

export async function getSessionById(id: string): Promise<AgentSession | null> {
  const sessions = await getAllSessions();
  return sessions.find(s => s.id === id) || null;
}

export async function sendMessage(sessionId: string, message: string): Promise<boolean> {
  if (sessionId.startsWith('opencode-')) {
    return sendOpenCodeMessage(sessionId, message);
  }
  
  if (sessionId.startsWith('claude-')) {
    return sendClaudeMessage(sessionId, message);
  }
  
  if (sessionId.startsWith('codex-')) {
    return sendCodexMessage(sessionId, message);
  }
  
  if (sessionId.startsWith('gemini-')) {
    return sendGeminiMessage(sessionId, message);
  }
  
  return false;
}

export async function getStatusCounts(): Promise<Record<AgentStatus, number>> {
  const sessions = await getAllSessions();
  
  return {
    working: sessions.filter(s => s.status === 'working').length,
    blocked: sessions.filter(s => s.status === 'blocked').length,
    complete: sessions.filter(s => s.status === 'complete').length,
    idle: sessions.filter(s => s.status === 'idle').length
  };
}

export { isAPIModeAvailable };

export function getAgentTypeFromId(id: string): AgentType {
  if (id.startsWith('opencode-')) return 'opencode';
  if (id.startsWith('claude-')) return 'claude';
  if (id.startsWith('codex-')) return 'codex';
  if (id.startsWith('gemini-')) return 'gemini';
  return 'opencode';
}
