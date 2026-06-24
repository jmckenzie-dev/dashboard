import type { AgentSession, AgentMessage, AgentStatus, BlockReason } from './types';
import { blockReasonOf } from './types';
import {
  analyzeParts,
  inferOpencodeStatus,
  inferPhase,
} from '../status/inference';
import type {
  LatestToolInfo,
  NormalizedPart,
} from '../status/inference';
import { loadConfig } from '../config';
import { scanProcesses } from '../process/poller';
import type { ProcessScanResult } from '../process/poller';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type Database from 'better-sqlite3';

type DatabaseType = typeof Database;

let sqlite3: DatabaseType | null = null;

async function getSQLite(): Promise<DatabaseType> {
  if (!sqlite3) {
    const module = await import('better-sqlite3');
    sqlite3 = module.default || module as unknown as DatabaseType;
  }
  return sqlite3;
}

interface OpenCodeSessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}

interface OpenCodePartRow {
  id: string;
  session_id: string;
  message_id: string;
  time_created: number;
  data: string;
}

interface OpenCodeSessionStatusResponse {
  type: 'idle' | 'busy' | 'retry';
  attempt?: number;
  message?: string;
  next?: number;
}

type OpenCodeSessionStatus = 'idle' | 'busy' | 'retry';

interface OpenCodeAPIOptions {
  headers: Record<string, string>;
  directory: string;
}

interface ParsedPartData {
  messages: AgentMessage[];
  latestTool: LatestToolInfo | null;
  latestStepReason: string | null;
  lastPartTime: number | null;
  hasError: boolean;
  latestPartType: string | null;
  latestPartIsActiveTool: boolean;
}

// Live-API-only blocking signals, keyed by session id.
interface BlockingRequests {
  permissionsBySession: Map<string, string[]>;
  questionsBySession: Map<string, string[]>;
}

// Phase-1 liveness: directories known to back a reachable instance.
interface InstanceLiveness {
  apiReachable: boolean;
  liveDirectories: Set<string>;
  liveSessionIds: Set<string>;
}

interface OpenCodeSQLiteOptions {
  canSendInput: boolean;
  statusData: Record<string, OpenCodeSessionStatusResponse>;
  blocking: BlockingRequests;
  liveness: InstanceLiveness;
}

function toEpochMs(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  const numeric = Math.trunc(value as number);
  if (numeric <= 0) return 0;

  if (numeric < 1e11) {
    return numeric * 1000;
  }

  if (numeric < 1e14) {
    return numeric;
  }

  if (numeric < 1e17) {
    return Math.trunc(numeric / 1000);
  }

  return Math.trunc(numeric / 1_000_000);
}

function toDate(value: number | null | undefined): Date {
  return new Date(toEpochMs(value));
}

function parsePartData(parts: OpenCodePartRow[]): ParsedPartData {
  const messages: AgentMessage[] = [];
  let lastPartTime: number | null = null;

  const normalized: NormalizedPart[] = [];
  for (const part of parts) {
    let data: any;
    try {
      data = JSON.parse(part.data);
    } catch {
      continue;
    }
    if (!lastPartTime || part.time_created > lastPartTime) {
      lastPartTime = part.time_created;
    }
    normalized.push({
      type: String(data.type ?? ''),
      tool: data.tool != null ? String(data.tool) : undefined,
      callID: data.callID ?? data.call_id,
      status: data.state?.status != null ? String(data.state.status) : undefined,
      reason: data.reason != null ? String(data.reason) : undefined,
      time: part.time_created,
    });
  }

  const { latestTool, latestStepReason, hasError, latestPartType, latestPartIsActiveTool } = analyzeParts(normalized);

  // Chronological pass for message extraction (text/reasoning/tool summaries).
  for (const part of [...parts].reverse()) {
    let data: any;
    try {
      data = JSON.parse(part.data);
    } catch {
      continue;
    }

    if (data.type === 'text' && typeof data.text === 'string' && data.text.trim()) {
      messages.push({
        id: part.id,
        role: 'assistant',
        content: data.text,
        timestamp: toDate(part.time_created)
      });
      continue;
    }

    if (data.type === 'reasoning' && typeof data.text === 'string' && data.text.trim()) {
      messages.push({
        id: part.id,
        role: 'assistant',
        content: data.text,
        timestamp: toDate(part.time_created)
      });
      continue;
    }

    if (data.type === 'tool') {
      const tool = data.tool ? `tool:${data.tool}` : 'tool';
      const s = data.state?.status ? ` status:${data.state.status}` : '';
      const output = typeof data.state?.output === 'string' ? data.state.output.slice(0, 200) : '';
      const text = `${tool}${s}${output ? ` output:${output}` : ''}`.trim();
      if (text) {
        messages.push({
          id: part.id,
          role: 'system',
          content: text,
          timestamp: toDate(part.time_created)
        });
      }
    }
  }

  const trimmed = messages.slice(-25);
  return {
    messages: trimmed,
    latestTool,
    latestStepReason,
    lastPartTime,
    hasError,
    latestPartType,
    latestPartIsActiveTool,
  };
}

function statusBlockReason(status: AgentStatus): BlockReason | null {
  return blockReasonOf(status);
}

function getOpenCodeAPIOptions(config: Awaited<ReturnType<typeof loadConfig>>): OpenCodeAPIOptions {
  const agentConfig = config.agents.opencode;
  const username = agentConfig.username || process.env.OPENCODE_SERVER_USERNAME;
  const password = agentConfig.password || process.env.OPENCODE_SERVER_PASSWORD;
  const directory = agentConfig.directory || process.env.OPENCODE_DIRECTORY || '/';
  const headers: Record<string, string> = { 'x-opencode-directory': directory };

  if (username && password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  return { headers, directory };
}

export function resolveOpenCodeDbPath(dbPath: string): string | null {
  if (existsSync(dbPath)) return dbPath;

  const marker = `${sep}.local${sep}share${sep}opencode${sep}`;
  const markerIndex = dbPath.indexOf(marker);
  if (markerIndex === -1) return null;

  const relativePath = dbPath.slice(markerIndex + marker.length);
  const containerPath = join(homedir(), '.local', 'share', 'opencode', relativePath);
  return existsSync(containerPath) ? containerPath : null;
}

function withOpenCodeDirectory(
  options: OpenCodeAPIOptions,
  directory: string | null | undefined,
): Record<string, string> {
  return {
    ...options.headers,
    'x-opencode-directory': directory || '/',
  };
}

async function checkAPIServer(apiBase: string, options: OpenCodeAPIOptions): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const response = await fetch(`${apiBase}/session`, {
      signal: controller.signal,
      headers: options.headers,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

async function getSessionStatusData(
  apiBase: string,
  options: OpenCodeAPIOptions,
): Promise<Record<string, OpenCodeSessionStatusResponse>> {
  try {
    const statusResponse = await fetch(`${apiBase}/session/status`, {
      headers: options.headers,
    });
    return statusResponse.ok
      ? await statusResponse.json() as Record<string, OpenCodeSessionStatusResponse>
      : {};
  } catch (error) {
    console.warn('OpenCode status fetch failed:', error);
    return {};
  }
}

// Live-API-only blocking signals. Permission and question requests are NEVER
// persisted (doc §0 truth #3), so this is the only way to detect Q2/Q3
// blocking. Returns request IDs keyed by session id so the UI can act on them.
async function getBlockingRequests(
  apiBase: string,
  options: OpenCodeAPIOptions,
): Promise<BlockingRequests> {
  const empty: BlockingRequests = {
    permissionsBySession: new Map(),
    questionsBySession: new Map(),
  };
  try {
    const [permRes, questRes] = await Promise.all([
      fetch(`${apiBase}/permission`, { headers: options.headers }).catch(() => null),
      fetch(`${apiBase}/question`, { headers: options.headers }).catch(() => null),
    ]);

    if (permRes && permRes.ok) {
      const perms = await permRes.json() as Array<{ id: string; sessionID?: string; sessionId?: string }>;
      for (const p of perms) {
        const sid = p.sessionID ?? p.sessionId;
        if (!sid) continue;
        const list = empty.permissionsBySession.get(sid) ?? [];
        list.push(p.id);
        empty.permissionsBySession.set(sid, list);
      }
    }

    if (questRes && questRes.ok) {
      const quests = await questRes.json() as Array<{ id: string; sessionID?: string; sessionId?: string }>;
      for (const q of quests) {
        const sid = q.sessionID ?? q.sessionId;
        if (!sid) continue;
        const list = empty.questionsBySession.get(sid) ?? [];
        list.push(q.id);
        empty.questionsBySession.set(sid, list);
      }
    }
  } catch (error) {
    console.warn('OpenCode blocking-request fetch failed:', error);
  }
  return empty;
}

// Phase-1 liveness (doc §Q6). The only positive liveness signal available
// without OS process inspection is the `/path` endpoint: it reports the
// directory of the instance on this apiBase. A session is "alive" if it is in
// the busy status map OR its directory matches a reachable instance. This
// cannot prove a session is *dead* (see docs/opencode-liveness-phase2.md), so
// `instanceAlive` is only ever `true` or left undefined.
async function getInstanceLiveness(
  apiBase: string,
  options: OpenCodeAPIOptions,
  apiReachable: boolean,
  statusData: Record<string, OpenCodeSessionStatusResponse>,
  processScan: ProcessScanResult,
): Promise<InstanceLiveness> {
  const liveDirectories = new Set(processScan.liveDirectories);
  const liveSessionIds = new Set(processScan.liveSessionIds);
  if (!apiReachable) {
    return { apiReachable: false, liveDirectories, liveSessionIds };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`${apiBase}/path`, {
      signal: controller.signal,
      headers: options.headers,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json() as { directory?: string };
      if (typeof data.directory === 'string' && data.directory) {
        liveDirectories.add(data.directory);
      }
    }
  } catch {
    // /path unreachable — fall through with whatever statusData told us.
  }

  // Any session that is currently busy is backed by a live instance.
  for (const sid of Object.keys(statusData)) {
    const entry = statusData[sid];
    if (entry && (entry.type === 'busy' || entry.type === 'retry')) {
      liveSessionIds.add(sid);
    }
  }

  // A reachable serve instance's /session endpoint is positive liveness for
  // sessions it currently knows about, including idle-but-live sessions that do
  // not appear in /session/status.
  await addLiveSessionsFromServe(apiBase, options, liveDirectories, liveSessionIds);

  // Process-discovered serve ports may include instances other than apiBase.
  await Promise.all(
    processScan.servePorts.map((port) =>
      addLiveSessionsFromServe(
        `http://127.0.0.1:${port}`,
        options,
        liveDirectories,
        liveSessionIds,
      ),
    ),
  );

  return { apiReachable: true, liveDirectories, liveSessionIds };
}

async function addLiveSessionsFromServe(
  apiBase: string,
  options: OpenCodeAPIOptions,
  liveDirectories: Set<string>,
  liveSessionIds: Set<string>,
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${apiBase}/session`, {
      signal: controller.signal,
      headers: options.headers,
    });
    clearTimeout(timeout);
    if (!res.ok) return;

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const sessions = await res.json() as Array<{
      id?: string;
      directory?: string;
      time?: { updated?: number };
    }>;

    for (const session of sessions) {
      if (!session.id) continue;
      const updated = toEpochMs(session.time?.updated);
      if (updated && updated < cutoff) continue;
      liveSessionIds.add(session.id);
      if (typeof session.directory === 'string' && session.directory) {
        liveDirectories.add(session.directory);
      }
    }
  } catch {
    // Best-effort liveness probe.
  }
}

function computeInstanceAlive(
  sessionId: string,
  directory: string | undefined,
  statusData: Record<string, OpenCodeSessionStatusResponse>,
  liveness: InstanceLiveness,
): boolean {
  // Busy/retry ⇒ instance is alive.
  const entry = statusData[sessionId];
  if (entry && (entry.type === 'busy' || entry.type === 'retry')) return true;
  // /session from a reachable serve instance ⇒ live, even if idle.
  if (liveness.liveSessionIds.has(sessionId)) return true;
  // Directory matches a reachable instance's `/path` ⇒ alive.
  if (directory && liveness.liveDirectories.has(directory)) return true;
  return false;
}

async function getSessionsViaAPI(
  apiBase: string,
  options: OpenCodeAPIOptions,
  blocking: BlockingRequests,
  liveness: InstanceLiveness,
): Promise<AgentSession[]> {
  try {
    const response = await fetch(`${apiBase}/session`, {
      headers: options.headers,
    });
    if (!response.ok) return [];

    const sessions = await response.json() as Array<{
      id: string;
      parent_id?: string | null;
      parentId?: string | null;
      title: string;
      directory: string;
      time: { created: number; updated: number };
    }>;

    const statusData = await getSessionStatusData(apiBase, options);

    const result: AgentSession[] = [];

    for (const [index, session] of sessions.entries()) {
      const lastActivity = toDate(session.time.updated);
      const lastActivityMs = Date.now() - lastActivity.getTime();
      const parentRaw = session.parent_id || session.parentId || null;
      const sessionStatus = statusData[session.id]?.type ?? null;
      const hasActiveInstance = Object.prototype.hasOwnProperty.call(statusData, session.id);
      let messages: AgentMessage[] = [];
      let latestTool: LatestToolInfo | null = null;
      let latestStepReason: string | null = null;
      let hasError = false;
      let latestPartType: string | null = null;
      let latestPartIsActiveTool = false;
      let currentMode: string | undefined;

      if (hasActiveInstance || lastActivityMs < 2 * 60 * 60 * 1000 || index < 25) {
        try {
          const msgResponse = await fetch(`${apiBase}/session/${session.id}/message`, {
            headers: withOpenCodeDirectory(options, session.directory),
          });

          if (msgResponse.ok) {
            const msgData = await msgResponse.json() as Array<{
              info: {
                id: string;
                role: string;
                agent?: string;
                time?: { created?: number };
              };
              parts: Array<{ type: string; text?: string; tool?: string; callID?: string; state?: { status?: string }; reason?: string }>;
            }>;

            const normalized: NormalizedPart[] = [];
            for (const message of msgData.slice(-10)) {
              if (message.info.agent) {
                currentMode = message.info.agent;
              }
              const t = toEpochMs(message.info.time?.created) || Date.now();
              for (const part of message.parts) {
                normalized.push({
                  type: String(part.type ?? ''),
                  tool: part.tool,
                  callID: part.callID,
                  status: part.state?.status != null ? String(part.state.status) : undefined,
                  reason: part.reason,
                  time: t,
                });
                if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
                  messages.push({
                    id: message.info.id,
                    role: message.info.role as 'user' | 'assistant' | 'system',
                    content: part.text,
                    timestamp: toDate(message.info.time?.created ?? Date.now())
                  });
                }
              }
            }

            const analyzed = analyzeParts(normalized);
            latestTool = analyzed.latestTool;
            latestStepReason = analyzed.latestStepReason;
            hasError = analyzed.hasError;
            latestPartType = analyzed.latestPartType;
            latestPartIsActiveTool = analyzed.latestPartIsActiveTool;
          }
        } catch (error) {
          console.warn(`OpenCode message fetch failed for ${session.id}:`, error);
        }
      }

      const permIds = blocking.permissionsBySession.get(session.id) ?? [];
      const questIds = blocking.questionsBySession.get(session.id) ?? [];

      const status = inferOpencodeStatus({
        sessionStatus,
        latestTool,
        latestStepReason,
        hasPermission: permIds.length > 0,
        hasQuestion: questIds.length > 0,
        lastActivityMs,
        hasError,
      });
      const phase = inferPhase(status, latestPartType, latestPartIsActiveTool, latestTool);
      const blockReason = statusBlockReason(status);
      const blockingRequestIds = blockReason === 'permission'
        ? permIds
        : blockReason === 'question'
          ? questIds
          : [];
      const instanceAlive = computeInstanceAlive(session.id, session.directory, statusData, liveness);

      result.push({
        id: `opencode-${session.id}`,
        parentId: parentRaw ? `opencode-${parentRaw}` : undefined,
        type: 'opencode',
        name: session.title || 'Untitled Session',
        summary: '',
        status,
        phase,
        directory: session.directory,
        lastActivity,
        messages,
        canSendInput: true,
        isActiveInstance: hasActiveInstance,
        mode: currentMode,
        blockReason,
        instanceAlive,
        blockingRequestIds: blockingRequestIds.length > 0 ? blockingRequestIds : undefined,
      });
    }

    return result;
  } catch (error) {
    console.error('OpenCode API error:', error);
    return [];
  }
}

async function getSessionsViaSQLite(
  dbPath: string,
  options: OpenCodeSQLiteOptions,
): Promise<AgentSession[]> {
  const resolvedDbPath = resolveOpenCodeDbPath(dbPath);
  if (!resolvedDbPath) return [];

  try {
    const DatabaseConstructor = await getSQLite();
    const db = new DatabaseConstructor(resolvedDbPath, { readonly: true, fileMustExist: true });

    // Reference-style query: exclude archived + child sessions, no fixed low limit.
    // Gap §3.5 fix: remove LIMIT 50, add time_archived IS NULL filter.
    const sessions = db.prepare(`
      SELECT id, project_id, parent_id, directory, title, time_created, time_updated
      FROM session
      WHERE time_archived IS NULL AND parent_id IS NULL
      ORDER BY time_updated DESC
      LIMIT 200
    `).all() as OpenCodeSessionRow[];

    const result: AgentSession[] = [];

    for (const session of sessions) {
      const parts = db.prepare(`
        SELECT id, session_id, message_id, time_created, data
        FROM part
        WHERE session_id = ?
        ORDER BY time_created DESC
        LIMIT 80
      `).all(session.id) as OpenCodePartRow[];

      const parsed = parsePartData(parts);
      const lastTime = parsed.lastPartTime ?? session.time_updated;
      const lastActivity = toDate(lastTime);
      const lastActivityMs = Date.now() - lastActivity.getTime();
      const sessionStatus = options.statusData[session.id]?.type ?? null;
      const hasActiveInstance = Object.prototype.hasOwnProperty.call(options.statusData, session.id);

      const permIds = options.blocking.permissionsBySession.get(session.id) ?? [];
      const questIds = options.blocking.questionsBySession.get(session.id) ?? [];
      const status = inferOpencodeStatus({
        sessionStatus,
        latestTool: parsed.latestTool,
        latestStepReason: parsed.latestStepReason,
        hasPermission: permIds.length > 0,
        hasQuestion: questIds.length > 0,
        lastActivityMs,
        hasError: parsed.hasError,
      });
      const phase = inferPhase(status, parsed.latestPartType, parsed.latestPartIsActiveTool, parsed.latestTool);
      const blockReason = statusBlockReason(status);
      const blockingRequestIds = blockReason === 'permission'
        ? permIds
        : blockReason === 'question'
          ? questIds
          : [];
      const instanceAlive = computeInstanceAlive(session.id, session.directory, options.statusData, options.liveness);

      result.push({
        id: `opencode-${session.id}`,
        parentId: session.parent_id ? `opencode-${session.parent_id}` : undefined,
        type: 'opencode',
        name: session.title || 'Untitled Session',
        summary: '',
        status,
        phase,
        directory: session.directory,
        lastActivity,
        messages: parsed.messages,
        canSendInput: options.canSendInput,
        isActiveInstance: hasActiveInstance,
        blockReason,
        instanceAlive,
        blockingRequestIds: blockingRequestIds.length > 0 ? blockingRequestIds : undefined,
      });
    }

    db.close();
    return result;
  } catch (error) {
    console.error('OpenCode SQLite error:', error);
    return [];
  }
}

export async function getOpenCodeSessions(): Promise<AgentSession[]> {
  const config = await loadConfig();
  const agentConfig = config.agents.opencode;

  if (!agentConfig.enabled) return [];

  const processScan = scanProcesses();

  let apiAvailable = false;
  let options: OpenCodeAPIOptions | null = null;

  if (agentConfig.apiBase) {
    options = getOpenCodeAPIOptions(config);
    apiAvailable = await checkAPIServer(agentConfig.apiBase, options);
  }

  // Fetch the live-API-only signals once and share them across both paths.
  let statusData: Record<string, OpenCodeSessionStatusResponse> = {};
  let blocking: BlockingRequests = {
    permissionsBySession: new Map(),
    questionsBySession: new Map(),
  };
  let liveness: InstanceLiveness = {
    apiReachable: apiAvailable,
    liveDirectories: new Set(processScan.liveDirectories),
    liveSessionIds: new Set(processScan.liveSessionIds),
  };
  if (apiAvailable && options && agentConfig.apiBase) {
    statusData = await getSessionStatusData(agentConfig.apiBase, options);
    blocking = await getBlockingRequests(agentConfig.apiBase, options);
    liveness = await getInstanceLiveness(agentConfig.apiBase, options, apiAvailable, statusData, processScan);
  }

  if (agentConfig.dbPath) {
    const sqliteSessions = await getSessionsViaSQLite(agentConfig.dbPath, {
      canSendInput: apiAvailable,
      statusData,
      blocking,
      liveness,
    });

    if (sqliteSessions.length > 0) {
      return sqliteSessions;
    }
  }

  if (agentConfig.apiBase && apiAvailable && options) {
    return getSessionsViaAPI(agentConfig.apiBase, options, blocking, liveness);
  }

  return [];
}

async function getSessionDirectoryViaSQLite(dbPath: string, sessionId: string): Promise<string | null> {
  const resolvedDbPath = resolveOpenCodeDbPath(dbPath);
  if (!resolvedDbPath) return null;

  try {
    const DatabaseConstructor = await getSQLite();
    const db = new DatabaseConstructor(resolvedDbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT directory FROM session WHERE id = ?').get(sessionId) as { directory: string } | undefined;
    db.close();
    return row?.directory ?? null;
  } catch (error) {
    console.error('OpenCode SQLite directory lookup error:', error);
    return null;
  }
}

async function getSessionDirectoryViaAPI(
  apiBase: string,
  options: OpenCodeAPIOptions,
  sessionId: string,
): Promise<string | null> {
  const emptyBlocking: BlockingRequests = {
    permissionsBySession: new Map(),
    questionsBySession: new Map(),
  };
  const noLiveness: InstanceLiveness = {
    apiReachable: true,
    liveDirectories: new Set(),
    liveSessionIds: new Set(),
  };
  const sessions = await getSessionsViaAPI(apiBase, options, emptyBlocking, noLiveness);
  const session = sessions.find(s => s.id === `opencode-${sessionId}`);
  return session?.directory ?? null;
}

export async function sendOpenCodeMessage(sessionId: string, message: string): Promise<boolean> {
  const config = await loadConfig();
  const agentConfig = config.agents.opencode;
  const apiBase = agentConfig.apiBase;
  const options = getOpenCodeAPIOptions(config);
  
  if (!apiBase) return false;
  
  try {
    const cleanSessionId = sessionId.replace('opencode-', '');
    let directory = agentConfig.dbPath
      ? await getSessionDirectoryViaSQLite(agentConfig.dbPath, cleanSessionId)
      : null;

    if (!directory) {
      directory = await getSessionDirectoryViaAPI(apiBase, options, cleanSessionId);
    }
    
    const response = await fetch(`${apiBase}/session/${cleanSessionId}/message`, {
      method: 'POST',
      headers: {
        ...withOpenCodeDirectory(options, directory ?? options.directory),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parts: [{ type: 'text', text: message }]
      })
    });
    
    return response.ok;
  } catch (error) {
    console.error('Failed to send OpenCode message:', error);
    return false;
  }
}

export function isAPIModeAvailable(): Promise<boolean> {
  return loadConfig().then(config => {
    if (!config.agents.opencode.apiBase) return Promise.resolve(false);
    return checkAPIServer(config.agents.opencode.apiBase, getOpenCodeAPIOptions(config));
  });
}

// Resolve a pending permission request: POST /permission/:id/reply.
// `reply` is "once" | "always" | "reject".
export async function replyOpenCodePermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
): Promise<boolean> {
  const config = await loadConfig();
  const apiBase = config.agents.opencode.apiBase;
  if (!apiBase) return false;
  const options = getOpenCodeAPIOptions(config);

  try {
    const response = await fetch(`${apiBase}/permission/${requestId}/reply`, {
      method: 'POST',
      headers: { ...options.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply }),
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to reply to OpenCode permission:', error);
    return false;
  }
}

// Resolve a pending question: POST /question/:id/reply (answers) or
// /question/:id/reject. `answers` maps 1:1 to the question's option lists.
export async function replyOpenCodeQuestion(
  requestId: string,
  answers: string[][],
): Promise<boolean> {
  const config = await loadConfig();
  const apiBase = config.agents.opencode.apiBase;
  if (!apiBase) return false;
  const options = getOpenCodeAPIOptions(config);

  try {
    const response = await fetch(`${apiBase}/question/${requestId}/reply`, {
      method: 'POST',
      headers: { ...options.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers }),
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to reply to OpenCode question:', error);
    return false;
  }
}

export async function rejectOpenCodeQuestion(requestId: string): Promise<boolean> {
  const config = await loadConfig();
  const apiBase = config.agents.opencode.apiBase;
  if (!apiBase) return false;
  const options = getOpenCodeAPIOptions(config);

  try {
    const response = await fetch(`${apiBase}/question/${requestId}/reject`, {
      method: 'POST',
      headers: { ...options.headers, 'Content-Type': 'application/json' },
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to reject OpenCode question:', error);
    return false;
  }
}

// Cancel a session (e.g. a submit_plan review awaiting Plannotator). The
// standard API cannot approve a plan review — only abort it (doc §4.3).
export async function abortOpenCodeSession(sessionId: string): Promise<boolean> {
  const config = await loadConfig();
  const apiBase = config.agents.opencode.apiBase;
  if (!apiBase) return false;
  const options = getOpenCodeAPIOptions(config);

  try {
    const cleanSessionId = sessionId.replace('opencode-', '');
    let directory = config.agents.opencode.dbPath
      ? await getSessionDirectoryViaSQLite(config.agents.opencode.dbPath, cleanSessionId)
      : null;
    if (!directory) directory = options.directory;

    const response = await fetch(`${apiBase}/session/${cleanSessionId}/abort`, {
      method: 'POST',
      headers: { ...withOpenCodeDirectory(options, directory ?? options.directory) },
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to abort OpenCode session:', error);
    return false;
  }
}
