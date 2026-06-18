import { loadConfig, getSoundsDir } from '../config';
import { onStatusTransition } from '../agents';
import { isBlocked } from '../agents/types';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const execAsync = promisify(exec);

export type NotificationType = 'blocked' | 'complete';

interface NotificationState {
  initialized: boolean;
  lastBlocked: number;
  lastComplete: number;
  cooldownMs: number;
}

const state: NotificationState = {
  initialized: false,
  lastBlocked: 0,
  lastComplete: 0,
  cooldownMs: 3000
};

export function initializeNotifications(): () => void {
  if (state.initialized) {
    return () => {};
  }
  
  state.initialized = true;
  
  const unsubscribe = onStatusTransition(async (transition) => {
    if (isBlocked(transition.toStatus)) {
      await triggerNotification('blocked', transition.sessionId);
    } else if (transition.toStatus === 'complete') {
      await triggerNotification('complete', transition.sessionId);
    }
  });
  
  return () => {
    state.initialized = false;
    unsubscribe();
  };
}

export async function triggerNotification(type: NotificationType, sessionId: string): Promise<void> {
  const now = Date.now();
  
  if (type === 'blocked' && now - state.lastBlocked < state.cooldownMs) {
    return;
  }
  if (type === 'complete' && now - state.lastComplete < state.cooldownMs) {
    return;
  }
  
  if (type === 'blocked') {
    state.lastBlocked = now;
  } else {
    state.lastComplete = now;
  }
  
  const config = await loadConfig();
  const notificationConfig = config.notifications[type];
  
  if (notificationConfig.sound) {
    await playSound(notificationConfig.sound);
  }
  
  if (notificationConfig.skill) {
    await executeSkill(notificationConfig.skill, sessionId, type);
  }
}

async function playSound(soundPath: string): Promise<void> {
  let fullPath = soundPath;
  
  if (!soundPath.startsWith('/')) {
    fullPath = join(getSoundsDir(), soundPath);
  }
  
  if (!existsSync(fullPath)) {
    console.warn('Sound file not found:', fullPath);
    return;
  }
  
  try {
    if (process.platform === 'darwin') {
      await execAsync(`afplay "${fullPath}"`);
    } else if (process.platform === 'linux') {
      const { stdout } = await execAsync('which paplay pw-play aplay 2>/dev/null | head -1');
      const player = stdout.trim();
      
      if (player) {
        await execAsync(`${player} "${fullPath}" 2>/dev/null`);
      } else {
        console.warn('No audio player found');
      }
    }
  } catch (error) {
    console.error('Failed to play sound:', error);
  }
}

async function executeSkill(skillPath: string, sessionId: string, type: NotificationType): Promise<void> {
  if (!existsSync(skillPath)) {
    console.warn('Skill file not found:', skillPath);
    return;
  }
  
  try {
    await execAsync(`"${skillPath}" "${sessionId}" "${type}"`, {
      timeout: 5000
    });
  } catch (error) {
    console.error('Failed to execute skill:', error);
  }
}

export async function testSound(soundPath: string): Promise<boolean> {
  await playSound(soundPath);
  return true;
}

export function setCooldown(ms: number): void {
  state.cooldownMs = ms;
}
