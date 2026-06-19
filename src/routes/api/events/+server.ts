import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/config';
import { checkAuth, requireAuth } from '$lib/auth';
import { countStatuses, getAllSessions, onStatusTransition } from '$lib/agents';
import { generateSummary } from '$lib/llm/summarizer';

export const GET: RequestHandler = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      
      const sendEvent = async (type: string, data: unknown) => {
        const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };
      
      const pollInterval = setInterval(async () => {
        try {
          const sessions = await getAllSessions();
          const counts = countStatuses(sessions);
          
          // Only generate summaries for active sessions; idle/complete rely on
          // the existing cache (TTL 10-30 min) to avoid LLM calls every tick.
          // Messages are truncated server-side (last 5, 220 chars each).
          const sessionsWithSummaries = await Promise.all(
            sessions.slice(0, 20).map(async (session) => {
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
          
          await sendEvent('update', { sessions: sessionsWithSummaries, counts });
        } catch (error) {
          console.error('SSE poll error:', error);
        }
      }, config.polling.intervalMs);
      
      const unsubscribe = onStatusTransition(async (transition) => {
        await sendEvent('transition', transition);
      });
      
      await sendEvent('connected', { timestamp: new Date().toISOString() });
      
      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, 15000);
      
      event.request.signal.addEventListener('abort', () => {
        clearInterval(pollInterval);
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      });
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
};
