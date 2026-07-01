import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { loadConfig, saveConfig, getSoundsDir } from '$lib/config';
import { hashPassword } from '$lib/auth';
import { checkAuth, requireAuth } from '$lib/auth';
import { existsSync } from 'node:fs';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const GET: RequestHandler = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  return json({
    server: config.server,
    llm: config.llm,
    polling: config.polling,
    notifications: config.notifications,
    agents: {
      opencode: { enabled: config.agents.opencode.enabled, apiBase: config.agents.opencode.apiBase },
      claude: { enabled: config.agents.claude.enabled },
      codex: { enabled: config.agents.codex.enabled },
      gemini: { enabled: config.agents.gemini.enabled }
    }
  });
};

export const PUT: RequestHandler = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  const body = await event.request.json();
  
  if (body.server) {
    config.server = { ...config.server, ...body.server };
  }
  
  if (body.llm) {
    config.llm = { ...config.llm, ...body.llm };
  }
  
  if (body.polling) {
    config.polling = { ...config.polling, ...body.polling };
    if (typeof config.polling.intervalMs === 'number') {
      config.polling.intervalMs = Math.max(1000, Math.min(60000, config.polling.intervalMs));
    }
  }
  
  if (body.notifications) {
    config.notifications = {
      blocked: { ...config.notifications.blocked, ...body.notifications.blocked },
      complete: { ...config.notifications.complete, ...body.notifications.complete }
    };
  }
  
  if (body.password) {
    config.auth.passwordHash = await hashPassword(body.password);
  }
  
  await saveConfig(config);
  
  return json({ success: true });
}
