import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'toml';
import type { DashboardConfig } from './agents/types';

const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const XDG_DATA_HOME = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
const CONFIG_DIR = join(XDG_CONFIG_HOME, 'ai-dashboard');
const DATA_DIR = join(XDG_DATA_HOME, 'ai-dashboard');
const CONFIG_FILE = join(CONFIG_DIR, 'dashboard.toml');
const SOUNDS_DIR = join(DATA_DIR, 'sounds');

const DEFAULT_CONFIG: DashboardConfig = {
  server: {
    host: '0.0.0.0',
    port: 35001
  },
  auth: {
    username: 'admin',
    passwordHash: ''
  },
  tls: {
    certPath: join(CONFIG_DIR, 'cert.pem'),
    keyPath: join(CONFIG_DIR, 'key.pem')
  },
  llm: {
    endpoint: 'http://192.168.68.150:5010/v1',
    model: 'glm-4-flash',
    summaryMaxTokens: 50,
    summaryPrompt: 'Summarize this AI agent\'s current task in 5-8 words. Be specific and concise. Only output the summary, nothing else.'
  },
  polling: {
    intervalMs: 3000
  },
  notifications: {
    blocked: {
      sound: 'blocked.wav',
      skill: null
    },
    complete: {
      sound: 'complete.wav',
      skill: null
    }
  },
  agents: {
    opencode: {
      enabled: true,
      dbPath: join(homedir(), '.local/share/opencode/opencode.db'),
      apiBase: 'http://localhost:4096'
    },
    claude: {
      enabled: true,
      historyPath: join(homedir(), '.claude/history.jsonl'),
      projectsPath: join(homedir(), '.claude/projects')
    },
    codex: {
      enabled: true,
      historyPath: join(homedir(), '.codex/history.jsonl')
    },
    gemini: {
      enabled: true,
      configPath: join(homedir(), '.gemini')
    }
  }
};

let configCache: DashboardConfig | null = null;

function expandPath(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function tomlStringify(obj: unknown, indent = 0): string {
  const spaces = '  '.repeat(indent);
  const lines: string[] = [];
  
  if (typeof obj !== 'object' || obj === null) {
    return String(obj);
  }
  
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value === null) {
      continue;
    } else if (typeof value === 'string') {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      lines.push(`${spaces}${key} = "${escaped}"`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`${spaces}${key} = ${value}`);
    } else if (Array.isArray(value)) {
      lines.push(`${spaces}${key} = [${value.map(v => 
        typeof v === 'string' ? `"${v}"` : String(v)
      ).join(', ')}]`);
    } else if (typeof value === 'object') {
      lines.push(`${spaces}[${key}]`);
      lines.push(tomlStringify(value, indent + 1));
    }
  }
  
  return lines.join('\n');
}

export async function loadConfig(): Promise<DashboardConfig> {
  if (configCache) return configCache;
  
  if (!existsSync(CONFIG_FILE)) {
    await saveConfig(DEFAULT_CONFIG);
    configCache = DEFAULT_CONFIG;
    return DEFAULT_CONFIG;
  }
  
  const content = await readFile(CONFIG_FILE, 'utf-8');
  const parsed = parse(content) as Partial<DashboardConfig>;
  
  const config: DashboardConfig = {
    server: { ...DEFAULT_CONFIG.server, ...parsed.server },
    auth: { ...DEFAULT_CONFIG.auth, ...parsed.auth },
    tls: { ...DEFAULT_CONFIG.tls, ...parsed.tls },
    llm: { ...DEFAULT_CONFIG.llm, ...parsed.llm },
    polling: { ...DEFAULT_CONFIG.polling, ...parsed.polling },
    notifications: {
      blocked: { ...DEFAULT_CONFIG.notifications.blocked, ...parsed.notifications?.blocked },
      complete: { ...DEFAULT_CONFIG.notifications.complete, ...parsed.notifications?.complete }
    },
    agents: {
      opencode: { ...DEFAULT_CONFIG.agents.opencode, ...parsed.agents?.opencode },
      claude: { ...DEFAULT_CONFIG.agents.claude, ...parsed.agents?.claude },
      codex: { ...DEFAULT_CONFIG.agents.codex, ...parsed.agents?.codex },
      gemini: { ...DEFAULT_CONFIG.agents.gemini, ...parsed.agents?.gemini }
    }
  };
  
  // Normalize notification configs: the legacy serializer wrote "null" as the
  // string "null". Map it back to proper null so downstream checks work.
  for (const key of ['blocked', 'complete'] as const) {
    const nc = config.notifications[key];
    if (nc) {
      if (nc.skill === 'null') nc.skill = null;
      if (nc.sound === 'null') nc.sound = null;
    }
  }
  
  // Expand paths
  config.tls.certPath = expandPath(config.tls.certPath);
  config.tls.keyPath = expandPath(config.tls.keyPath);
  if (config.agents.opencode.dbPath) config.agents.opencode.dbPath = expandPath(config.agents.opencode.dbPath);
  if (config.agents.claude.historyPath) config.agents.claude.historyPath = expandPath(config.agents.claude.historyPath);
  if (config.agents.claude.projectsPath) config.agents.claude.projectsPath = expandPath(config.agents.claude.projectsPath);
  if (config.agents.codex.historyPath) config.agents.codex.historyPath = expandPath(config.agents.codex.historyPath);
  if (config.agents.gemini.configPath) config.agents.gemini.configPath = expandPath(config.agents.gemini.configPath);
  
  configCache = config;
  return config;
}

export async function saveConfig(config: DashboardConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(SOUNDS_DIR, { recursive: true });
  
  const content = tomlStringify(config);
  await writeFile(CONFIG_FILE, content, 'utf-8');
  configCache = config;
}

export async function updateConfig(updates: Partial<DashboardConfig>): Promise<DashboardConfig> {
  const current = await loadConfig();
  const updated = deepMerge(current, updates);
  await saveConfig(updated);
  return updated;
}

function deepMerge(target: DashboardConfig, source: Partial<DashboardConfig>): DashboardConfig {
  return {
    server: { ...target.server, ...source.server },
    auth: { ...target.auth, ...source.auth },
    tls: { ...target.tls, ...source.tls },
    llm: { ...target.llm, ...source.llm },
    polling: { ...target.polling, ...source.polling },
    notifications: {
      blocked: { ...target.notifications.blocked, ...source.notifications?.blocked },
      complete: { ...target.notifications.complete, ...source.notifications?.complete }
    },
    agents: {
      opencode: { ...target.agents.opencode, ...source.agents?.opencode },
      claude: { ...target.agents.claude, ...source.agents?.claude },
      codex: { ...target.agents.codex, ...source.agents?.codex },
      gemini: { ...target.agents.gemini, ...source.agents?.gemini }
    }
  };
}

export function getSoundsDir(): string {
  return SOUNDS_DIR;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getDataDir(): string {
  return DATA_DIR;
}
