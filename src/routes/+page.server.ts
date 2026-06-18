import type { PageServerLoad } from './$types';
import { countStatuses, getAllSessions } from '$lib/agents/index';
import { generateSummary } from '$lib/llm/summarizer';

export const load: PageServerLoad = async () => {
  const sessions = await getAllSessions();
  const counts = countStatuses(sessions);
  
  const sessionsWithSummaries = await Promise.all(
    sessions.map(async (session) => ({
      id: session.id,
      parentId: session.parentId,
      type: session.type,
      name: session.name,
      summary: await generateSummary(session.id, session.messages),
      status: session.status,
      project: session.project,
      directory: session.directory,
      lastActivity: session.lastActivity.toISOString(),
      pid: session.pid,
      pty: session.pty,
      messages: session.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp.toISOString()
      })),
      canSendInput: session.canSendInput,
      mode: session.mode,
      blockReason: session.blockReason ?? null,
      // Preserve three-valued liveness: `true` (confirmed alive) or undefined
      // (unknown). Phase 1 never sets `false`; see docs/opencode-liveness-phase2.md.
      instanceAlive: session.instanceAlive === true ? true : undefined,
      blockingRequestIds: session.blockingRequestIds ?? []
    }))
  );
  
  return {
    sessions: sessionsWithSummaries,
    counts,
    timestamp: new Date().toISOString()
  };
};
