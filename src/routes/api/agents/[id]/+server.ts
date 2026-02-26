import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSessionById, sendMessage } from '$lib/agents';
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
