import type { RequestHandler } from './$types';
import { loadConfig } from '$lib/config';
import { checkAuth, requireAuth } from '$lib/auth';
import { generateSummary } from '$lib/llm/summarizer';
import { sseClientsActive } from '$lib/metrics';
import { subscribe, subscribeTransitions, type SnapshotData } from '$lib/agents/snapshot';
import type { AgentSession } from '$lib/agents/types';

export const GET: RequestHandler = async (event) => {
  const config = await loadConfig();

  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      sseClientsActive.inc();
      let activeDecremented = false;

      const sendEvent = (type: string, data: unknown) => {
        if (closed) return;
        try {
          const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(message));
        } catch (error) {
          console.error('SSE send error:', error);
        }
      };

      // Transform a raw snapshot into the wire format: generate summaries for
      // active sessions, truncate messages, serialize dates. This work is
      // per-client (each client may have different summary cache state), but
      // the expensive getAllSessions() + SQLite + inference pipeline runs only
      // once in the shared snapshot manager.
      const formatSnapshot = async (data: SnapshotData) => {
        const sessionsWithSummaries = await Promise.all(
          data.sessions.slice(0, 20).map(async (session: AgentSession) => {
            const needsSummary = session.status !== 'idle' && session.status !== 'complete';
            return {
              ...session,
              summary: needsSummary
                ? await generateSummary(session.id, session.messages, false, session.status)
                : session.summary,
              messages: session.messages.slice(-5).map((m) => ({
                ...m,
                content: m.content.slice(0, 220),
                timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
              })),
              lastActivity: session.lastActivity.toISOString(),
            };
          })
        );

        return { sessions: sessionsWithSummaries, counts: data.counts };
      };

      sendEvent('connected', { timestamp: new Date().toISOString() });

      // Subscribe to the shared snapshot. The manager runs a SINGLE poll loop
      // regardless of how many SSE clients are connected.
      const unsubscribeSnapshot = subscribe(async (data) => {
        if (closed) return;
        try {
          const formatted = await formatSnapshot(data);
          sendEvent('update', formatted);
        } catch (error) {
          console.error('SSE format/send error:', error);
        }
      });

      const unsubscribeTransitions = subscribeTransitions((transition) => {
        sendEvent('transition', {
          ...transition,
          timestamp: transition.timestamp instanceof Date
            ? transition.timestamp.toISOString()
            : transition.timestamp,
        });
      });

      const keepAlive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch (error) {
          console.error('SSE keepalive error:', error);
        }
      }, 15000);

      event.request.signal.addEventListener('abort', () => {
        if (!activeDecremented) {
          sseClientsActive.dec();
          activeDecremented = true;
        }
        closed = true;
        clearInterval(keepAlive);
        unsubscribeSnapshot();
        unsubscribeTransitions();
        try {
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};
