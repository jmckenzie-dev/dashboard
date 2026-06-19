import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { countStatuses, getAllSessions } from '$lib/agents';
import { generateSummary } from '$lib/llm/summarizer';
import { checkAuth, requireAuth } from '$lib/auth';

export const GET: RequestHandler = async (event) => {
  const config = await import('$lib/config').then(m => m.loadConfig());
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  const sessions = await getAllSessions();
  const counts = countStatuses(sessions);
  
  // Generate summaries only for active (non-idle/non-complete) sessions on
  // poll ticks. Idle/complete sessions use the cache — their summaries change
  // rarely and the cache TTL is already generous (10-30 min).
  // Messages are truncated server-side (last 5, 220 chars each) to reduce
  // payload size — the UI only shows this much anyway.
  const sessionsWithSummaries = await Promise.all(
    sessions.map(async (session) => {
      const needsSummary = session.status !== 'idle' && session.status !== 'complete';
      return {
        ...session,
        summary: needsSummary
          ? await generateSummary(session.id, session.messages, false, session.status)
          : session.summary,
        messages: session.messages.slice(-5).map((m) => ({
          ...m,
          content: m.content.slice(0, 220),
          timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp
        })),
        lastActivity: session.lastActivity.toISOString()
      };
    })
  );
  
  return json({
    sessions: sessionsWithSummaries,
    counts,
    timestamp: new Date().toISOString()
  });
};
