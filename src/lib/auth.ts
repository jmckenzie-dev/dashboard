import { loadConfig } from './config';
import bcrypt from 'bcryptjs';
import type { RequestEvent } from '@sveltejs/kit';

let passwordCache: { hash: string; plain?: string } | null = null;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function setPassword(password: string): Promise<void> {
  const config = await loadConfig();
  config.auth.passwordHash = await hashPassword(password);
  
  const { saveConfig } = await import('./config');
  await saveConfig(config);
  
  passwordCache = { hash: config.auth.passwordHash, plain: password };
}

export async function checkAuth(event: RequestEvent): Promise<boolean> {
  const config = await loadConfig();
  
  if (!config.auth.passwordHash) {
    return true;
  }
  
  const authHeader = event.request.headers.get('authorization');
  
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }
  
  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
  const colonIndex = credentials.indexOf(':');
  
  if (colonIndex === -1) {
    return false;
  }
  
  const username = credentials.slice(0, colonIndex);
  const password = credentials.slice(colonIndex + 1);
  
  if (username !== config.auth.username) {
    return false;
  }
  
  return verifyPassword(password, config.auth.passwordHash);
}

export function requireAuth(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="AI Agent Dashboard", charset="UTF-8"'
    }
  });
}
