import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSoundsDir } from '$lib/config';
import { checkAuth, requireAuth } from '$lib/auth';
import { loadConfig } from '$lib/config';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const GET: RequestHandler = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  const soundsDir = getSoundsDir();
  const sounds: string[] = [];
  
  try {
    const files = await readdir(soundsDir);
    for (const file of files) {
      if (file.endsWith('.wav') || file.endsWith('.mp3') || file.endsWith('.ogg')) {
        sounds.push(file);
      }
    }
  } catch {}
  
  return json(sounds);
};

export const POST: RequestHandler = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  const formData = await event.request.formData();
  const file = formData.get('sound') as File;
  const type = formData.get('type') as string;
  
  if (!file) {
    return json({ error: 'No file provided' }, { status: 400 });
  }
  
  const soundsDir = getSoundsDir();
  const filename = `${type}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const filepath = join(soundsDir, filename);
  
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(filepath, buffer);
  
  return json({ filename, path: filepath });
};
