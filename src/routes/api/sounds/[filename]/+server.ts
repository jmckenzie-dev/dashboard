import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSoundsDir } from '$lib/config';
import { checkAuth, requireAuth } from '$lib/auth';
import { loadConfig } from '$lib/config';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const execAsync = promisify(exec);

export const POST: RequestHandler = async (event) => {
  const config = await loadConfig();
  
  if (config.auth.passwordHash && !await checkAuth(event)) {
    return requireAuth();
  }
  
  const filename = event.params.filename;
  const fullPath = join(getSoundsDir(), filename);
  
  if (!existsSync(fullPath)) {
    return json({ error: 'Sound not found' }, { status: 404 });
  }
  
  try {
    if (process.platform === 'darwin') {
      await execAsync(`afplay "${fullPath}"`);
    } else if (process.platform === 'linux') {
      const { stdout } = await execAsync('which paplay pw-play aplay 2>/dev/null | head -1');
      const player = stdout.trim();
      
      if (player) {
        await execAsync(`${player} "${fullPath}" 2>/dev/null`);
      }
    }
    
    return json({ success: true });
  } catch (error) {
    return json({ error: 'Failed to play sound' }, { status: 500 });
  }
};
