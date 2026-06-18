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
          
          const sessionsWithSummaries = await Promise.all(
            sessions.slice(0, 20).map(async (session) => ({
              ...session,
              summary: await generateSummary(session.id, session.messages),
              lastActivity: session.lastActivity.toISOString()
            }))
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
