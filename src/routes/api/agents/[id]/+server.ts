import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
  getSessionById,
  sendMessage,
  replyOpenCodePermission,
  replyOpenCodeQuestion,
  rejectOpenCodeQuestion,
  abortOpenCodeSession,
} from '$lib/agents';
import { generateSummary } from '$lib/llm/summarizer';
import { checkAuth, requireAuth } from '$lib/auth';
import { loadConfig } from '$lib/config';

export const GET: RequestHandler = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  const id = event.params.id;
  const session = await getSessionById(id);
  
  if (!session) {
    return json({ error: 'Session not found' }, { status: 404 });
  }
  
  return json({
    ...session,
    summary: await generateSummary(session.id, session.messages),
    lastActivity: session.lastActivity.toISOString()
  });
};

export const POST: RequestHandler = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  const id = event.params.id;
  const body = await event.request.json();
  const action = typeof body.action === 'string' ? body.action : 'message';

  // Resolve a pending permission request: { action: 'permission', requestId, reply }
  if (action === 'permission') {
    const requestId = body.requestId;
    const reply = body.reply;
    if (typeof requestId !== 'string' || !['once', 'always', 'reject'].includes(reply)) {
      return json({ error: 'requestId and reply (once|always|reject) required' }, { status: 400 });
    }
    const success = await replyOpenCodePermission(requestId, reply);
    return success
      ? json({ success: true })
      : json({ error: 'Failed to reply to permission' }, { status: 500 });
  }

  // Resolve a pending question: { action: 'question', requestId, answers }
  if (action === 'question') {
    const requestId = body.requestId;
    const answers = body.answers;
    if (typeof requestId !== 'string' || !Array.isArray(answers)) {
      return json({ error: 'requestId and answers required' }, { status: 400 });
    }
    const success = await replyOpenCodeQuestion(requestId, answers);
    return success
      ? json({ success: true })
      : json({ error: 'Failed to reply to question' }, { status: 500 });
  }

  if (action === 'question-reject') {
    const requestId = body.requestId;
    if (typeof requestId !== 'string') {
      return json({ error: 'requestId required' }, { status: 400 });
    }
    const success = await rejectOpenCodeQuestion(requestId);
    return success
      ? json({ success: true })
      : json({ error: 'Failed to reject question' }, { status: 500 });
  }

  // Abort a session (e.g. cancel a submit_plan plan review).
  if (action === 'abort') {
    const success = await abortOpenCodeSession(id);
    return success
      ? json({ success: true })
      : json({ error: 'Failed to abort session' }, { status: 500 });
  }

  // Default: send a text message.
  const message = body.message;
  if (!message || typeof message !== 'string') {
    return json({ error: 'Message required' }, { status: 400 });
  }

  const session = await getSessionById(id);

  if (!session) {
    return json({ error: 'Session not found' }, { status: 404 });
  }

  if (!session.canSendInput) {
    return json({ error: 'Cannot send input to this session' }, { status: 400 });
  }

  const success = await sendMessage(id, message);

  if (!success) {
    return json({ error: 'Failed to send message' }, { status: 500 });
  }

  return json({ success: true });
};
