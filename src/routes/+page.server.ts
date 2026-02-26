import type { PageServerLoad } from './$types';
import { getAllSessions, getStatusCounts } from '$lib/agents/index';
import { generateSummary } from '$lib/llm/summarizer';

export const load: PageServerLoad = async () => {
  const sessions = await getAllSessions();
  const counts = await getStatusCounts();
  
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
      canSendInput: session.canSendInput
    }))
  );
  
  return {
    sessions: sessionsWithSummaries,
    counts,
    timestamp: new Date().toISOString()
  };
};
