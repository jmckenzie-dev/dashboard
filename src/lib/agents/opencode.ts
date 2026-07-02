import type { AgentSession, AgentMessage, AgentStatus, BlockReason } from './types';
import { blockReasonOf } from './types';
import {
  allocateOpenCodeLiveness,
  hasOpenCodeStatusLiveness,
} from './opencode-liveness';
import type {
  OpenCodeLivenessCandidate,
} from './opencode-liveness';
import {
  analyzeParts,
  inferOpencodeStatus,
  inferPhase,
  WORKING_GRACE_MS,
} from '../status/inference';
import type {
  LatestToolInfo,
  NormalizedPart,
  OpencodeStatusInput,
} from '../status/inference';
import { loadConfig } from '../config';
import { scanProcesses } from '../process/poller';
import type { ProcessScanResult } from '../process/poller';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type Database from 'better-sqlite3';
import {
  opencodeSnapshotMode,
  opencodeSqliteEnrichmentSessions,
  partCacheHits,
  pollDuration,
} from '../metrics';

type DatabaseConstructor = typeof Database;
type DatabaseInstance = InstanceType<DatabaseConstructor>;

let sqlite3: DatabaseConstructor | null = null;

async function getSQLite(): Promise<DatabaseConstructor> {
  if (!sqlite3) {
    const module = await import('better-sqlite3');
    sqlite3 = (module.default || module) as unknown as DatabaseConstructor;
  }
  return sqlite3;
}

// Persistent DB connection — reused across poll cycles instead of opening
// and closing on every tick. The path is tracked so a config change to
// dbPath triggers a clean close+reopen.
let dbHandle: DatabaseInstance | null = null;
let dbHandlePath: string | null = null;
const indexedDbPaths = new Set<string>();

function ensureDashboardIndexes(dbPath: string): void {
  if (indexedDbPaths.has(dbPath)) return;
  const DatabaseConstructor = sqlite3!;
  const db = new DatabaseConstructor(dbPath, { fileMustExist: true, timeout: 10000 });
  try {
    // Dashboard-owned indexes for the exact polling access patterns. OpenCode's
    // stock indexes find rows by parent/session, but do not satisfy the
    // activity ORDER BY, so SQLite was building temp B-trees every tick.
    db.exec(`
      CREATE INDEX IF NOT EXISTS dashboard_session_root_activity_idx
      ON session (
        COALESCE(time_updated, time_created) DESC,
        time_created DESC,
        id DESC
      )
      WHERE time_archived IS NULL AND parent_id IS NULL;

      CREATE INDEX IF NOT EXISTS dashboard_part_session_activity_idx
      ON part (
        session_id,
        COALESCE(time_updated, time_created) DESC,
        time_created DESC,
        id DESC
      );
    `);
    indexedDbPaths.add(dbPath);
  } finally {
    db.close();
  }
}

function getDb(dbPath: string): DatabaseInstance {
  if (dbHandle && dbHandlePath === dbPath) {
    return dbHandle;
  }
  // Path changed or first open.
  if (dbHandle) {
    try { dbHandle.close(); } catch {}
    dbHandle = null;
  }
  ensureDashboardIndexes(dbPath);
  const DatabaseConstructor = sqlite3!;
  dbHandle = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  dbHandlePath = dbPath;
  return dbHandle;
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
  time_updated: number | null;
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
  // The normalized parts that were fed to analyzeParts. Exposed so diagnostic
  // callers (e.g. the diagnose endpoint / dump script) can show the raw signal
  // that produced latestTool/hasError without re-reading the DB.
  normalizedParts: NormalizedPart[];
}

interface ApiSQLiteEnrichment {
  sessionActivity: number;
  parsed: ParsedPartData;
}

const apiSQLiteEnrichmentCache = new Map<string, ApiSQLiteEnrichment>();

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
  directoryAllocationCounts: Record<string, number>;
}

interface SessionCandidate {
  session: AgentSession;
  liveness: OpenCodeLivenessCandidate;
}

// Per-session inference internals, captured for diagnostics (the diagnose
// endpoint and the dump script). The liveness DECISION outputs
// (instanceAlive/livenessReason/visibilityReason) are already on the
// AgentSession itself; this object holds the INPUTS to status inference plus
// the normalized parts so a reader can answer "why is this session X?".
export interface SessionDiagnostic {
  sessionStatus: OpenCodeSessionStatus | null;
  hasActiveInstance: boolean;
  permIds: string[];
  questIds: string[];
  latestTool: LatestToolInfo | null;
  latestStepReason: string | null;
  hasError: boolean;
  latestPartType: string | null;
  latestPartIsActiveTool: boolean;
  lastActivityMs: number;
  inferenceInput: OpencodeStatusInput;
  livenessCandidate: {
    hasStatusSignal: boolean;
    hasBlockingRequest: boolean;
    hasActiveTool: boolean;
    hasProcessSessionId: boolean;
    status: AgentStatus;
  };
  parts: NormalizedPart[];
}

export type DiagnosticAgentSession = AgentSession & { diagnostic: SessionDiagnostic };

interface OpenCodeSQLiteOptions {
  canSendInput: boolean;
  statusData: Record<string, OpenCodeSessionStatusResponse>;
  blocking: BlockingRequests;
  liveness: InstanceLiveness;
  includeHidden: boolean;
  captureDiagnostics?: boolean;
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

function partActivityTime(part: OpenCodePartRow): number {
  return Math.max(part.time_created ?? 0, part.time_updated ?? 0);
}

const PART_CACHE_LIMIT = 100000;
const SESSION_METADATA_LIMIT = 200;
const PART_SESSION_SCAN_LIMIT = 40;
const PARTS_PER_SESSION_LIMIT = 80;
const API_ENRICHMENT_BOOTSTRAP_LIMIT = 20;
const API_ENRICHMENT_PART_LIMIT = 12;
const RECENT_SQLITE_SUPPLEMENT_MS = 10 * 60 * 1000;
const partCache = new Map<string, CachedPart>();

interface CachedPart {
  id: string;
  timeUpdated: number | null;
  parsedData: any;
  normalized: NormalizedPart;
  message: AgentMessage | null;
}

function getOrParsePart(part: OpenCodePartRow): { parsedData: any; normalized: NormalizedPart | null; message: AgentMessage | null } {
  const cached = partCache.get(part.id);
  if (cached && cached.timeUpdated === part.time_updated) {
    try {
      partCacheHits.inc({ result: 'hit' });
    } catch {}
    return {
      parsedData: cached.parsedData,
      normalized: cached.normalized,
      message: cached.message,
    };
  }

  try {
    partCacheHits.inc({ result: 'miss' });
  } catch {}

  let data: any;
  try {
    data = JSON.parse(part.data);
  } catch {
    return { parsedData: null, normalized: null, message: null };
  }

  const activeTime = partActivityTime(part);
  const normalized: NormalizedPart = {
    type: String(data.type ?? ''),
    tool: data.tool != null ? String(data.tool) : undefined,
    callID: data.callID ?? data.call_id,
    status: data.state?.status != null ? String(data.state.status) : undefined,
    reason: data.reason != null ? String(data.reason) : undefined,
    time: activeTime,
  };

  let message: AgentMessage | null = null;
  if (data.type === 'text' && typeof data.text === 'string' && data.text.trim()) {
    message = {
      id: part.id,
      role: 'assistant',
      content: data.text,
      timestamp: toDate(activeTime)
    };
  } else if (data.type === 'reasoning' && typeof data.text === 'string' && data.text.trim()) {
    message = {
      id: part.id,
      role: 'assistant',
      content: data.text,
      timestamp: toDate(activeTime)
    };
  } else if (data.type === 'tool') {
    const tool = data.tool ? `tool:${data.tool}` : 'tool';
    const s = data.state?.status ? ` status:${data.state.status}` : '';
    const output = typeof data.state?.output === 'string' ? data.state.output.slice(0, 200) : '';
    const text = `${tool}${s}${output ? ` output:${output}` : ''}`.trim();
    if (text) {
      message = {
        id: part.id,
        role: 'system',
        content: text,
        timestamp: toDate(activeTime)
      };
    }
  }

  const entry: CachedPart = {
    id: part.id,
    timeUpdated: part.time_updated,
    parsedData: data,
    normalized,
    message,
  };

  partCache.set(part.id, entry);

  if (partCache.size > PART_CACHE_LIMIT) {
    const keys = partCache.keys();
    for (let i = 0; i < 2000; i++) {
      const key = keys.next().value;
      if (key === undefined) break;
      partCache.delete(key);
    }
  }

  return { parsedData: data, normalized, message };
}

export function parsePartData(parts: OpenCodePartRow[]): ParsedPartData {
  // Single pass: extract normalized parts AND messages in one iteration.
  // Parts arrive from the DB ordered newest→oldest (rn ASC where rn=1 is
  // newest). We collect messages in that order, then reverse at the end for
  // chronological display.
  const messagesNewestFirst: AgentMessage[] = [];
  let lastPartTime: number | null = null;

  const normalized: NormalizedPart[] = [];
  for (const part of parts) {
    const { normalized: norm, message } = getOrParsePart(part);
    if (!norm) continue;

    const activeTime = norm.time;
    if (!lastPartTime || activeTime > lastPartTime) {
      lastPartTime = activeTime;
    }
    normalized.push(norm);

    if (message) {
      messagesNewestFirst.push(message);
    }
  }

  const { latestTool, latestStepReason, hasError, latestPartType, latestPartIsActiveTool } = analyzeParts(normalized);

  // Reverse to chronological (oldest→newest) and take the last 25.
  const trimmed = messagesNewestFirst.reverse().slice(-25);
  return {
    messages: trimmed,
    latestTool,
    latestStepReason,
    lastPartTime,
    hasError,
    latestPartType,
    latestPartIsActiveTool,
    normalizedParts: normalized,
  };
}

function apiStatusFromSignals(
  sessionStatus: OpenCodeSessionStatus | null,
  hasPermission: boolean,
  hasQuestion: boolean,
): AgentStatus {
  if (hasPermission) return 'blocked_permission';
  if (hasQuestion) return 'blocked_question';
  if (sessionStatus === 'retry') return 'retry';
  if (sessionStatus === 'busy') return 'working';
  return 'idle';
}

function applyReviewErrorEnrichment(
  status: AgentStatus,
  parsed: ParsedPartData | null,
  hasPermission: boolean,
  hasQuestion: boolean,
  lastActivityMs: number,
): AgentStatus {
  if (!parsed || hasPermission || hasQuestion) return status;

  const toolName = parsed.latestTool?.tool ?? '';
  const toolActive = parsed.latestTool?.active === true;
  if ((toolName === 'submit_plan' || toolName === 'plan_exit') && toolActive) {
    return 'blocked_review';
  }

  if (parsed.hasError) return 'error';
  if (status === 'idle') {
    if (toolActive && toolName !== 'question') return 'working';
    if (lastActivityMs < WORKING_GRACE_MS) return 'working';
  }
  return status;
}

function evictApiSQLiteEnrichmentCache(seenIds: Set<string>): void {
  for (const id of apiSQLiteEnrichmentCache.keys()) {
    if (!seenIds.has(id)) apiSQLiteEnrichmentCache.delete(id);
  }
  while (apiSQLiteEnrichmentCache.size > SESSION_METADATA_LIMIT) {
    const oldest = apiSQLiteEnrichmentCache.keys().next();
    if (oldest.done) break;
    apiSQLiteEnrichmentCache.delete(oldest.value);
  }
}

async function getApiSQLiteEnrichment(
  dbPath: string | null | undefined,
  sessionActivityById: Map<string, number>,
): Promise<Map<string, ParsedPartData>> {
  if (!dbPath || sessionActivityById.size === 0) return new Map();
  const resolvedDbPath = resolveOpenCodeDbPath(dbPath);
  if (!resolvedDbPath) return new Map();

  try {
    await getSQLite();
    const db = getDb(resolvedDbPath);
    const startDb = process.hrtime();
    const sessionIds = [...sessionActivityById.keys()];
    const rows = db.prepare(`
      WITH ranked_parts AS (
        SELECT id, session_id, message_id, time_created, time_updated, data,
               ROW_NUMBER() OVER (
                 PARTITION BY session_id
                 ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
               ) as rn
        FROM part
        WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
      )
      SELECT id, session_id, message_id, time_created, time_updated, data
      FROM ranked_parts
      WHERE rn <= ${API_ENRICHMENT_PART_LIMIT}
      ORDER BY session_id, rn ASC
    `).all(...sessionIds) as OpenCodePartRow[];

    const dbDiff = process.hrtime(startDb);
    try {
      pollDuration.observe({ step: 'sqlite_enrichment' }, dbDiff[0] + dbDiff[1] / 1e9);
      opencodeSqliteEnrichmentSessions.inc(sessionIds.length);
    } catch {}

    const partsBySession = new Map<string, OpenCodePartRow[]>();
    for (const row of rows) {
      let parts = partsBySession.get(row.session_id);
      if (!parts) {
        parts = [];
        partsBySession.set(row.session_id, parts);
      }
      parts.push(row);
    }

    const result = new Map<string, ParsedPartData>();
    for (const sessionId of sessionIds) {
      const parsed = parsePartData(partsBySession.get(sessionId) ?? []);
      const sessionActivity = sessionActivityById.get(sessionId) ?? 0;
      apiSQLiteEnrichmentCache.set(sessionId, { sessionActivity, parsed });
      result.set(sessionId, parsed);
    }
    return result;
  } catch (error) {
    console.error('OpenCode SQLite enrichment error:', error);
    return new Map();
  }
}

function statusBlockReason(status: AgentStatus): BlockReason | null {
  return blockReasonOf(status);
}

function getOpenCodeAPIOptions(config: Awaited<ReturnType<typeof loadConfig>>): OpenCodeAPIOptions {
  const agentConfig = config.agents.opencode;
  const username = agentConfig.username || process.env.OPENCODE_SERVER_USERNAME;
  const password = agentConfig.password || process.env.OPENCODE_SERVER_PASSWORD;
  const directory = agentConfig.directory || process.env.OPENCODE_DIRECTORY || '/';
  const headers: Record<string, string> = {};

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

function getOpenCodeApiBaseCandidates(apiBase: string): string[] {
  const candidates = [apiBase];
  try {
    const url = new URL(apiBase);
    if (url.hostname === 'host.containers.internal') {
      url.hostname = '127.0.0.1';
      candidates.push(url.toString().replace(/\/$/, ''));
    }
  } catch {
    // Leave invalid URLs to the normal checkAPIServer failure path.
  }
  return candidates;
}

async function resolveReachableOpenCodeApiBase(
  apiBase: string,
  options: OpenCodeAPIOptions,
): Promise<string | null> {
  for (const candidate of getOpenCodeApiBaseCandidates(apiBase)) {
    if (await checkAPIServer(candidate, options)) return candidate;
  }
  return null;
}

async function getSessionStatusData(
  apiBase: string,
  options: OpenCodeAPIOptions,
): Promise<Record<string, OpenCodeSessionStatusResponse>> {
  try {
    // Bounded latency: match the 1s budget already used by checkAPIServer.
    // Without this, a slow /session/status response can hold a poll tick
    // open indefinitely, which under the old setInterval loop caused
    // overlapping snapshots and per-tick visibility flicker.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const statusResponse = await fetch(`${apiBase}/session/status`, {
      signal: controller.signal,
      headers: options.headers,
    });
    clearTimeout(timeout);
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
    // Bound both fetches with a shared 1s budget (matches checkAPIServer).
    // We pass a single AbortController to both requests so a slow upstream
    // surfaces as an empty result here rather than an unbounded tick.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const fetchOpts = { headers: options.headers, signal: controller.signal };
    try {
      const [permRes, questRes] = await Promise.all([
        fetch(`${apiBase}/permission`, fetchOpts).catch(() => null),
        fetch(`${apiBase}/question`, fetchOpts).catch(() => null),
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
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.warn('OpenCode blocking-request fetch failed:', error);
  }
  return empty;
}

function getDirectoryAllocationCounts(processScan: ProcessScanResult): Record<string, number> {
  const counts = { ...processScan.directoryProcessCounts };
  for (const process of processScan.processes) {
    if (!process.cwd || !process.sessionId) continue;
    counts[process.cwd] = Math.max((counts[process.cwd] ?? 0) - 1, 0);
  }

  for (const directory of Object.keys(counts)) {
    if (counts[directory] <= 0) delete counts[directory];
  }

  return counts;
}

// Liveness discovery gathers direct process session ids and weak directory
// signals. Directory signals are allocated later to the newest N root sessions;
// they are never blanket proof for every session in a directory.
async function getInstanceLiveness(
  apiBase: string,
  options: OpenCodeAPIOptions,
  apiReachable: boolean,
  processScan: ProcessScanResult,
): Promise<InstanceLiveness> {
  const liveDirectories = new Set(processScan.liveDirectories);
  const liveSessionIds = new Set(processScan.directSessionIds);
  const directoryAllocationCounts = getDirectoryAllocationCounts(processScan);
  if (!apiReachable) {
    return { apiReachable: false, liveDirectories, liveSessionIds, directoryAllocationCounts };
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
    // /path unreachable — process cwd signals may still be available.
  }

  return { apiReachable: true, liveDirectories, liveSessionIds, directoryAllocationCounts };
}

function applyLivenessDecisions(
  candidates: SessionCandidate[],
  liveness: InstanceLiveness,
  includeHidden: boolean,
): AgentSession[] {
  const decisions = allocateOpenCodeLiveness(
    candidates.map((candidate) => candidate.liveness),
    liveness.directoryAllocationCounts,
  );

  const sessions = candidates
    .map(({ session, liveness: candidate }) => {
      const decision = decisions.get(candidate.id) ?? {
        livenessReason: 'hidden_stale' as const,
        visibilityReason: 'hidden_stale' as const,
      };
      return {
        ...session,
        instanceAlive: decision.instanceAlive,
        livenessReason: decision.livenessReason,
        visibilityReason: decision.visibilityReason,
      };
    });
  return includeHidden
    ? sessions
    : sessions.filter((session) => session.visibilityReason !== 'hidden_stale');
}

export function rawOpenCodeSessionId(id: string): string {
  return id.replace(/^opencode-/, '');
}

export function liveSupplementSessionIds(
  apiSessions: AgentSession[],
  statusData: Record<string, OpenCodeSessionStatusResponse>,
  blocking: BlockingRequests,
  liveness: InstanceLiveness,
): Set<string> {
  const apiIds = new Set(apiSessions.map((session) => rawOpenCodeSessionId(session.id)));
  const wanted = new Set<string>();

  for (const id of liveness.liveSessionIds) wanted.add(id);
  for (const id of Object.keys(statusData)) wanted.add(id);
  for (const id of blocking.permissionsBySession.keys()) wanted.add(id);
  for (const id of blocking.questionsBySession.keys()) wanted.add(id);

  for (const id of [...wanted]) {
    if (apiIds.has(id)) wanted.delete(id);
  }

  return wanted;
}

export function isRecentSQLiteSupplement(session: AgentSession, now = Date.now()): boolean {
  return now - session.lastActivity.getTime() <= RECENT_SQLITE_SUPPLEMENT_MS;
}

async function getSQLiteLiveSupplements(
  dbPath: string | undefined,
  existingIds: Set<string>,
  wantedIds: Set<string>,
  options: OpenCodeSQLiteOptions,
): Promise<AgentSession[]> {
  const liveDirectories = new Set(
    Object.entries(options.liveness.directoryAllocationCounts)
      .filter(([, count]) => count > 0)
      .map(([directory]) => directory),
  );
  if (!dbPath) return [];

  const sqliteCandidates = await getSessionsViaSQLite(dbPath, {
    ...options,
    includeHidden: true,
  });
  const supplements = sqliteCandidates.filter((session) => {
    const rawId = rawOpenCodeSessionId(session.id);
    if (existingIds.has(rawId)) return false;
    if (wantedIds.has(rawId)) return true;
    if (isRecentSQLiteSupplement(session)) return true;
    return !session.parentId
      && !!session.directory
      && liveDirectories.has(session.directory);
  });

  return options.includeHidden
    ? supplements
    : supplements.filter((session) => session.visibilityReason !== 'hidden_stale');
}

interface APIFirstSessionMetadata {
  id: string;
  parent_id?: string | null;
  parentId?: string | null;
  parentID?: string | null;
  title: string;
  directory: string;
  time: { created: number; updated: number };
}

async function getAPIFirstSessionMetadata(
  apiBase: string,
  options: OpenCodeAPIOptions,
): Promise<APIFirstSessionMetadata[]> {
  const response = await fetch(`${apiBase}/session`, {
    headers: options.headers,
  });
  if (!response.ok) return [];
  return response.json() as Promise<APIFirstSessionMetadata[]>;
}

async function getSessionsViaAPIStatusFirst(
  apiBase: string,
  options: OpenCodeAPIOptions,
  statusData: Record<string, OpenCodeSessionStatusResponse>,
  blocking: BlockingRequests,
  liveness: InstanceLiveness,
  includeHidden: boolean,
  dbPath?: string,
  captureDiagnostics?: boolean,
): Promise<AgentSession[]> {
  try {
    const sessions = await getAPIFirstSessionMetadata(apiBase, options);
    if (sessions.length === 0) return [];

    const seenIds = new Set<string>();
    const enrichmentTargets = new Map<string, number>();
    for (const [index, session] of sessions.entries()) {
      seenIds.add(session.id);
      const sessionStatus = statusData[session.id]?.type ?? null;
      const permIds = blocking.permissionsBySession.get(session.id) ?? [];
      const questIds = blocking.questionsBySession.get(session.id) ?? [];
      const sessionActivity = Math.max(session.time.created ?? 0, session.time.updated ?? 0);
      const cached = apiSQLiteEnrichmentCache.get(session.id);
      const busyWithoutApiBlock = sessionStatus === 'busy' && permIds.length === 0 && questIds.length === 0;
      const changedSinceEnrichment = !!cached && cached.sessionActivity !== sessionActivity;
      const needsBootstrap = !cached && index < API_ENRICHMENT_BOOTSTRAP_LIMIT;
      const hasDirectLiveSignal = liveness.liveSessionIds.has(session.id) || Object.prototype.hasOwnProperty.call(statusData, session.id);

      if (busyWithoutApiBlock || changedSinceEnrichment || needsBootstrap || (!cached && hasDirectLiveSignal)) {
        enrichmentTargets.set(session.id, sessionActivity);
      }
    }

    evictApiSQLiteEnrichmentCache(seenIds);
    const freshEnrichment = await getApiSQLiteEnrichment(dbPath, enrichmentTargets);
    const candidates: SessionCandidate[] = [];

    for (const session of sessions) {
      const lastActivity = toDate(Math.max(session.time.created ?? 0, session.time.updated ?? 0));
      const lastActivityMs = Date.now() - lastActivity.getTime();
      const parentRaw = session.parent_id || session.parentId || session.parentID || null;
      const sessionStatus = statusData[session.id]?.type ?? null;
      const hasActiveInstance = Object.prototype.hasOwnProperty.call(statusData, session.id);
      const permIds = blocking.permissionsBySession.get(session.id) ?? [];
      const questIds = blocking.questionsBySession.get(session.id) ?? [];
      const parsed = freshEnrichment.get(session.id) ?? apiSQLiteEnrichmentCache.get(session.id)?.parsed ?? null;
      const apiStatus = apiStatusFromSignals(sessionStatus, permIds.length > 0, questIds.length > 0);
      const status = applyReviewErrorEnrichment(apiStatus, parsed, permIds.length > 0, questIds.length > 0, lastActivityMs);
      const inferenceInput: OpencodeStatusInput = {
        sessionStatus,
        latestTool: parsed?.latestTool ?? null,
        latestStepReason: parsed?.latestStepReason ?? null,
        hasPermission: permIds.length > 0,
        hasQuestion: questIds.length > 0,
        lastActivityMs,
        hasError: parsed?.hasError ?? false,
      };
      const phase = parsed
        ? inferPhase(status, parsed.latestPartType, parsed.latestPartIsActiveTool, parsed.latestTool)
        : status === 'idle'
          ? 'idle'
          : (status === 'error' || statusBlockReason(status) !== null)
            ? 'blocked'
            : undefined;
      const blockReason = statusBlockReason(status);
      const blockingRequestIds = blockReason === 'permission'
        ? permIds
        : blockReason === 'question'
          ? questIds
          : [];
      const livenessCandidate = {
        id: session.id,
        parentId: parentRaw,
        directory: session.directory,
        lastActivity,
        hasStatusSignal: hasOpenCodeStatusLiveness(sessionStatus),
        hasBlockingRequest: permIds.length > 0 || questIds.length > 0,
        hasActiveTool: parsed?.latestTool?.active === true,
        hasProcessSessionId: liveness.liveSessionIds.has(session.id),
        status,
      };
      const agentSession: AgentSession = {
        id: `opencode-${session.id}`,
        parentId: parentRaw ? `opencode-${parentRaw}` : undefined,
        type: 'opencode',
        name: session.title || 'Untitled Session',
        summary: '',
        status,
        phase,
        directory: session.directory,
        lastActivity,
        messages: parsed?.messages ?? [],
        canSendInput: true,
        isActiveInstance: hasActiveInstance,
        blockReason,
        blockingRequestIds: blockingRequestIds.length > 0 ? blockingRequestIds : undefined,
      };

      if (captureDiagnostics) {
        (agentSession as DiagnosticAgentSession).diagnostic = {
          sessionStatus,
          hasActiveInstance,
          permIds,
          questIds,
          latestTool: parsed?.latestTool ?? null,
          latestStepReason: parsed?.latestStepReason ?? null,
          hasError: parsed?.hasError ?? false,
          latestPartType: parsed?.latestPartType ?? null,
          latestPartIsActiveTool: parsed?.latestPartIsActiveTool ?? false,
          lastActivityMs,
          inferenceInput,
          livenessCandidate: {
            hasStatusSignal: livenessCandidate.hasStatusSignal,
            hasBlockingRequest: livenessCandidate.hasBlockingRequest,
            hasActiveTool: livenessCandidate.hasActiveTool,
            hasProcessSessionId: livenessCandidate.hasProcessSessionId,
            status: livenessCandidate.status,
          },
          parts: parsed?.normalizedParts ?? [],
        };
      }

      candidates.push({
        session: agentSession,
        liveness: livenessCandidate,
      });
    }

    return applyLivenessDecisions(candidates, liveness, includeHidden);
  } catch (error) {
    console.error('OpenCode API status-first error:', error);
    return [];
  }
}

async function getSessionsViaAPI(
  apiBase: string,
  options: OpenCodeAPIOptions,
  statusData: Record<string, OpenCodeSessionStatusResponse>,
  blocking: BlockingRequests,
  liveness: InstanceLiveness,
  includeHidden: boolean,
  captureDiagnostics?: boolean,
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
      parentID?: string | null;
      title: string;
      directory: string;
      time: { created: number; updated: number };
    }>;

    const candidates: SessionCandidate[] = [];

    for (const [index, session] of sessions.entries()) {
      const lastActivity = toDate(Math.max(session.time.created ?? 0, session.time.updated ?? 0));
      const lastActivityMs = Date.now() - lastActivity.getTime();
      const parentRaw = session.parent_id || session.parentId || session.parentID || null;
      const sessionStatus = statusData[session.id]?.type ?? null;
      const hasActiveInstance = Object.prototype.hasOwnProperty.call(statusData, session.id);
      let messages: AgentMessage[] = [];
      let latestTool: LatestToolInfo | null = null;
      let latestStepReason: string | null = null;
      let hasError = false;
      let latestPartType: string | null = null;
      let latestPartIsActiveTool = false;
      let currentMode: string | undefined;
      let normalized: NormalizedPart[] = [];

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

            normalized = [];
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

      const inferenceInput: OpencodeStatusInput = {
        sessionStatus,
        latestTool,
        latestStepReason,
        hasPermission: permIds.length > 0,
        hasQuestion: questIds.length > 0,
        lastActivityMs,
        hasError,
      };
      const inferredStatus = inferOpencodeStatus(inferenceInput);
      const status = inferredStatus === 'complete' ? 'idle' : inferredStatus;
      const phase = inferPhase(status, latestPartType, latestPartIsActiveTool, latestTool);
      const blockReason = statusBlockReason(status);
      const blockingRequestIds = blockReason === 'permission'
        ? permIds
        : blockReason === 'question'
          ? questIds
          : [];
      const livenessCandidate = {
        id: session.id,
        parentId: parentRaw,
        directory: session.directory,
        lastActivity,
        hasStatusSignal: hasOpenCodeStatusLiveness(sessionStatus),
        hasBlockingRequest: permIds.length > 0 || questIds.length > 0,
        hasActiveTool: latestTool?.active === true,
        hasProcessSessionId: liveness.liveSessionIds.has(session.id),
        status,
      };
      const agentSession: AgentSession = {
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
        blockingRequestIds: blockingRequestIds.length > 0 ? blockingRequestIds : undefined,
      };

      if (captureDiagnostics) {
        (agentSession as DiagnosticAgentSession).diagnostic = {
          sessionStatus,
          hasActiveInstance,
          permIds,
          questIds,
          latestTool,
          latestStepReason,
          hasError,
          latestPartType,
          latestPartIsActiveTool,
          lastActivityMs,
          inferenceInput,
          livenessCandidate: {
            hasStatusSignal: livenessCandidate.hasStatusSignal,
            hasBlockingRequest: livenessCandidate.hasBlockingRequest,
            hasActiveTool: livenessCandidate.hasActiveTool,
            hasProcessSessionId: livenessCandidate.hasProcessSessionId,
            status: livenessCandidate.status,
          },
          parts: normalized,
        };
      }

      candidates.push({
        session: agentSession,
        liveness: livenessCandidate,
      });
    }

    return applyLivenessDecisions(candidates, liveness, includeHidden);
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
    await getSQLite();
    const db = getDb(resolvedDbPath);

    const startDb = process.hrtime();

    // Reference-style query: exclude archived + child sessions, no fixed low limit.
    // Gap §3.5 fix: remove LIMIT 50, add time_archived IS NULL filter.
    const sessions = db.prepare(`
      SELECT id, project_id, parent_id, directory, title, time_created, time_updated
      FROM session
      WHERE time_archived IS NULL AND parent_id IS NULL
      ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
      LIMIT ${SESSION_METADATA_LIMIT}
    `).all() as OpenCodeSessionRow[];

    const sessionIdsToScan = new Set<string>();
    for (const session of sessions.slice(0, PART_SESSION_SCAN_LIMIT)) {
      sessionIdsToScan.add(session.id);
    }
    for (const session of sessions) {
      if (Object.prototype.hasOwnProperty.call(options.statusData, session.id)) sessionIdsToScan.add(session.id);
      if (options.blocking.permissionsBySession.has(session.id)) sessionIdsToScan.add(session.id);
      if (options.blocking.questionsBySession.has(session.id)) sessionIdsToScan.add(session.id);
      if (options.liveness.liveSessionIds.has(session.id)) sessionIdsToScan.add(session.id);
    }

    // Consolidated parts query using window functions, limited to sessions that
    // can plausibly affect the visible dashboard. We still read broad session
    // metadata above for liveness allocation/hysteresis, but avoid pulling 80
    // JSON blobs for every old hidden-stale session on every tick.
    const allParts = sessionIdsToScan.size === 0
      ? []
      : db.prepare(`
        WITH ranked_parts AS (
          SELECT id, session_id, message_id, time_created, time_updated, data,
                 ROW_NUMBER() OVER (
                   PARTITION BY session_id
                   ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
                 ) as rn
          FROM part
          WHERE session_id IN (${[...sessionIdsToScan].map(() => '?').join(',')})
        )
        SELECT id, session_id, message_id, time_created, time_updated, data
        FROM ranked_parts
        WHERE rn <= ${PARTS_PER_SESSION_LIMIT}
        ORDER BY session_id, rn ASC
      `).all(...sessionIdsToScan) as OpenCodePartRow[];

    const dbDiff = process.hrtime(startDb);
    const dbDuration = dbDiff[0] + dbDiff[1] / 1e9;
    try {
      pollDuration.observe({ step: 'db_query' }, dbDuration);
    } catch {}

    // DB handle is persistent — do NOT close it here. It's reused across
    // poll cycles for connection pooling. See getDb() above.

    // Map parts to their corresponding sessions in O(M) time
    const startParse = process.hrtime();

    const partsBySession = new Map<string, OpenCodePartRow[]>();
    for (const part of allParts) {
      let list = partsBySession.get(part.session_id);
      if (!list) {
        list = [];
        partsBySession.set(part.session_id, list);
      }
      list.push(part);
    }

    const candidates: SessionCandidate[] = [];

    for (const session of sessions) {
      const parts = partsBySession.get(session.id) ?? [];
      const parsed = parsePartData(parts);
      const lastTime = Math.max(parsed.lastPartTime ?? 0, session.time_created ?? 0, session.time_updated ?? 0);
      const lastActivity = toDate(lastTime);
      const lastActivityMs = Date.now() - lastActivity.getTime();
      const sessionStatus = options.statusData[session.id]?.type ?? null;
      const hasActiveInstance = Object.prototype.hasOwnProperty.call(options.statusData, session.id);

      const permIds = options.blocking.permissionsBySession.get(session.id) ?? [];
      const questIds = options.blocking.questionsBySession.get(session.id) ?? [];
      const inferenceInput: OpencodeStatusInput = {
        sessionStatus,
        latestTool: parsed.latestTool,
        latestStepReason: parsed.latestStepReason,
        hasPermission: permIds.length > 0,
        hasQuestion: questIds.length > 0,
        lastActivityMs,
        hasError: parsed.hasError,
      };
      const inferredStatus = inferOpencodeStatus(inferenceInput);
      const status = inferredStatus === 'complete' ? 'idle' : inferredStatus;
      const phase = inferPhase(status, parsed.latestPartType, parsed.latestPartIsActiveTool, parsed.latestTool);
      const blockReason = statusBlockReason(status);
      const blockingRequestIds = blockReason === 'permission'
        ? permIds
        : blockReason === 'question'
          ? questIds
          : [];
      const livenessCandidate = {
        id: session.id,
        parentId: session.parent_id,
        directory: session.directory,
        lastActivity,
        hasStatusSignal: hasOpenCodeStatusLiveness(sessionStatus),
        hasBlockingRequest: permIds.length > 0 || questIds.length > 0,
        hasActiveTool: parsed.latestTool?.active === true,
        hasProcessSessionId: options.liveness.liveSessionIds.has(session.id),
        status,
      };
      const agentSession: AgentSession = {
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
        blockingRequestIds: blockingRequestIds.length > 0 ? blockingRequestIds : undefined,
      };

      if (options.captureDiagnostics) {
        (agentSession as DiagnosticAgentSession).diagnostic = {
          sessionStatus,
          hasActiveInstance,
          permIds,
          questIds,
          latestTool: parsed.latestTool,
          latestStepReason: parsed.latestStepReason,
          hasError: parsed.hasError,
          latestPartType: parsed.latestPartType,
          latestPartIsActiveTool: parsed.latestPartIsActiveTool,
          lastActivityMs,
          inferenceInput,
          livenessCandidate: {
            hasStatusSignal: livenessCandidate.hasStatusSignal,
            hasBlockingRequest: livenessCandidate.hasBlockingRequest,
            hasActiveTool: livenessCandidate.hasActiveTool,
            hasProcessSessionId: livenessCandidate.hasProcessSessionId,
            status: livenessCandidate.status,
          },
          parts: parsed.normalizedParts,
        };
      }

      candidates.push({
        session: agentSession,
        liveness: livenessCandidate,
      });
    }

    const parseDiff = process.hrtime(startParse);
    const parseDuration = parseDiff[0] + parseDiff[1] / 1e9;
    try {
      pollDuration.observe({ step: 'parse_inference' }, parseDuration);
    } catch {}

    return applyLivenessDecisions(candidates, options.liveness, options.includeHidden);
  } catch (error) {
    console.error('OpenCode SQLite error:', error);
    return [];
  }
}

export async function getOpenCodeSessions(
  optionsArg: { includeHidden?: boolean; captureDiagnostics?: boolean } = {},
): Promise<AgentSession[]> {
  const config = await loadConfig();
  const agentConfig = config.agents.opencode;
  const includeHidden = optionsArg.includeHidden === true;
  const captureDiagnostics = optionsArg.captureDiagnostics === true;

  if (!agentConfig.enabled) return [];

  const processScan = scanProcesses();

  let apiAvailable = false;
  let apiBase: string | null = null;
  let options: OpenCodeAPIOptions | null = null;

  if (agentConfig.apiBase) {
    options = getOpenCodeAPIOptions(config);
    apiBase = await resolveReachableOpenCodeApiBase(agentConfig.apiBase, options);
    apiAvailable = apiBase !== null;
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
    liveSessionIds: new Set(processScan.directSessionIds),
    directoryAllocationCounts: getDirectoryAllocationCounts(processScan),
  };
  if (apiAvailable && options && apiBase) {
    statusData = await getSessionStatusData(apiBase, options);
    blocking = await getBlockingRequests(apiBase, options);
    liveness = await getInstanceLiveness(apiBase, options, apiAvailable, processScan);
  }

  if (apiBase && apiAvailable && options) {
    const apiSessions = await getSessionsViaAPIStatusFirst(
      apiBase,
      options,
      statusData,
      blocking,
      liveness,
      includeHidden,
      agentConfig.dbPath,
      captureDiagnostics,
    );
    if (apiSessions.length > 0) {
      const apiIds = new Set(apiSessions.map((session) => rawOpenCodeSessionId(session.id)));
      const supplementIds = liveSupplementSessionIds(apiSessions, statusData, blocking, liveness);
      const supplements = await getSQLiteLiveSupplements(agentConfig.dbPath, apiIds, supplementIds, {
        canSendInput: apiAvailable,
        statusData,
        blocking,
        liveness,
        includeHidden,
        captureDiagnostics,
      });
      try {
        opencodeSnapshotMode.inc({ mode: 'api_first' });
      } catch {}
      return [...apiSessions, ...supplements];
    }
  }

  if (agentConfig.dbPath) {
    const sqliteSessions = await getSessionsViaSQLite(agentConfig.dbPath, {
      canSendInput: apiAvailable,
      statusData,
      blocking,
      liveness,
      includeHidden,
      captureDiagnostics,
    });

    if (sqliteSessions.length > 0) {
      try {
        opencodeSnapshotMode.inc({ mode: captureDiagnostics ? 'diagnostic_sqlite' : 'sqlite_fallback' });
      } catch {}
      return sqliteSessions;
    }
  }

  if (apiBase && apiAvailable && options) {
    try {
      opencodeSnapshotMode.inc({ mode: 'api_messages_fallback' });
    } catch {}
    return getSessionsViaAPI(apiBase, options, statusData, blocking, liveness, includeHidden, captureDiagnostics);
  }

  return [];
}

/**
 * Variant of {@link getOpenCodeSessions} that attaches a per-session
 * {@link SessionDiagnostic} (inference inputs + normalized parts) to each
 * returned session. Used by the diagnose endpoint and the dump script. The
 * diagnostic object is only populated when requested via this entry point, so
 * normal polling paths are unaffected.
 */
export async function getOpenCodeSessionsWithDiagnostics(
  optionsArg: { includeHidden?: boolean } = {},
): Promise<DiagnosticAgentSession[]> {
  return getOpenCodeSessions({ ...optionsArg, captureDiagnostics: true }) as Promise<DiagnosticAgentSession[]>;
}

async function getSessionDirectoryViaSQLite(dbPath: string, sessionId: string): Promise<string | null> {
  const resolvedDbPath = resolveOpenCodeDbPath(dbPath);
  if (!resolvedDbPath) return null;

  try {
    await getSQLite();
    const db = getDb(resolvedDbPath);
    const row = db.prepare('SELECT directory FROM session WHERE id = ?').get(sessionId) as { directory: string } | undefined;
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
  try {
    const response = await fetch(`${apiBase}/session`, {
      headers: options.headers,
    });
    if (!response.ok) return null;
    const sessions = await response.json() as Array<{ id: string; directory?: string }>;
    return sessions.find((session) => session.id === sessionId)?.directory ?? null;
  } catch (error) {
    console.warn(`OpenCode directory fetch failed for ${sessionId}:`, error);
    return null;
  }
}

export async function sendOpenCodeMessage(sessionId: string, message: string): Promise<boolean> {
  const config = await loadConfig();
  const agentConfig = config.agents.opencode;
  const configuredApiBase = agentConfig.apiBase;
  const options = getOpenCodeAPIOptions(config);
  
  if (!configuredApiBase) return false;
  const apiBase = await resolveReachableOpenCodeApiBase(configuredApiBase, options);
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
    const apiBase = config.agents.opencode.apiBase;
    if (!apiBase) return Promise.resolve(false);
    return resolveReachableOpenCodeApiBase(apiBase, getOpenCodeAPIOptions(config))
      .then((reachable) => reachable !== null);
  });
}

// Resolve a pending permission request: POST /permission/:id/reply.
// `reply` is "once" | "always" | "reject".
export async function replyOpenCodePermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
): Promise<boolean> {
  const config = await loadConfig();
  const configuredApiBase = config.agents.opencode.apiBase;
  if (!configuredApiBase) return false;
  const options = getOpenCodeAPIOptions(config);
  const apiBase = await resolveReachableOpenCodeApiBase(configuredApiBase, options);
  if (!apiBase) return false;

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
  const configuredApiBase = config.agents.opencode.apiBase;
  if (!configuredApiBase) return false;
  const options = getOpenCodeAPIOptions(config);
  const apiBase = await resolveReachableOpenCodeApiBase(configuredApiBase, options);
  if (!apiBase) return false;

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
  const configuredApiBase = config.agents.opencode.apiBase;
  if (!configuredApiBase) return false;
  const options = getOpenCodeAPIOptions(config);
  const apiBase = await resolveReachableOpenCodeApiBase(configuredApiBase, options);
  if (!apiBase) return false;

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
  const configuredApiBase = config.agents.opencode.apiBase;
  if (!configuredApiBase) return false;
  const options = getOpenCodeAPIOptions(config);
  const apiBase = await resolveReachableOpenCodeApiBase(configuredApiBase, options);
  if (!apiBase) return false;

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
