import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getAllSessions, getStatusCounts } from '$lib/agents';
import { generateSummary } from '$lib/llm/summarizer';
import { checkAuth, requireAuth } from '$lib/auth';

export const GET: RequestHandler = async (event) => {
  const config = await import('$lib/config').then(m => m.loadConfig());
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  const sessions = await getAllSessions();
  const counts = await getStatusCounts();
  
  const sessionsWithSummaries = await Promise.all(
    sessions.map(async (session) => ({
      ...session,
      summary: await generateSummary(session.id, session.messages),
      lastActivity: session.lastActivity.toISOString()
    }))
  );
  
  return json({
    sessions: sessionsWithSummaries,
    counts,
    timestamp: new Date().toISOString()
  });
};
