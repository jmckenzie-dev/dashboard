// OS process scanner for OpenCode instances.
// Implements the reference's process-first discovery model (docs/reference_comparison.md §3.1–§3.3).
// Pure OS-level module; no SQLite dependency. Callers in opencode.ts handle DB mapping.

import { execSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { basename } from 'node:path';

export type CwdReadStatus = 'ok' | 'not_found' | 'permission_denied' | 'timeout' | 'unknown';

export interface CwdReadDiagnostic {
  pid: number;
  status: CwdReadStatus;
  cwd: string | null;
  method: 'proc' | 'lsof';
  error?: string;
}

export interface OpenCodeProcess {
  pid: number;
  cwd: string | null;
  cwdRead?: CwdReadDiagnostic;
  sessionId: string | null;   // from -s flag, or null for flagless TUI
  port?: number;               // only for opencode serve processes
  isServe: boolean;
}

export interface ProcessScanResult {
  processes: OpenCodeProcess[];
  servePorts: number[];
  /** Directories observed as process cwd values; weak signal only */
  liveDirectories: string[];
  /** Backward-compatible alias for directSessionIds */
  liveSessionIds: string[];
  /** Exact session IDs explicitly parsed from process args */
  directSessionIds: string[];
  /** Number of discovered OpenCode processes per readable cwd */
  directoryProcessCounts: Record<string, number>;
  /** Diagnostics for every attempted process cwd read */
  cwdReadDiagnostics: CwdReadDiagnostic[];
  /** Whether the OS process scan succeeded */
  scanSucceeded: boolean;
}

interface ParsedProcessLine {
  pid: number;
  args: string[];
}

export interface ParsedOpenCodeProcess {
  pid: number;
  sessionId: string | null;
  port?: number;
  isServe: boolean;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : undefined;
}

function cwdStatusForError(error: unknown): CwdReadStatus {
  const code = errorCode(error);
  const message = errorMessage(error)?.toLowerCase() ?? '';
  if (code === 'ENOENT' || code === 'ESRCH') return 'not_found';
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (code === 'ETIMEDOUT' || message.includes('timed out') || message.includes('timeout')) return 'timeout';
  return 'unknown';
}

function parseProcessLine(line: string): ParsedProcessLine | null {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return null;

  return {
    pid: parseInt(match[1]!, 10),
    args: match[2]!.trim().split(/\s+/),
  };
}

function isOpenCodeExecutable(arg: string): boolean {
  return basename(arg) === 'opencode';
}

function openCodeArgIndex(args: string[]): number {
  if (args.length === 0) return -1;
  if (isOpenCodeExecutable(args[0]!)) return 0;
  if (
    ['node', 'bun', 'deno'].includes(basename(args[0]!))
    && args[1]
    && isOpenCodeExecutable(args[1])
  ) {
    return 1;
  }
  return -1;
}

function sessionIdFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((arg === '-s' || arg === '--session' || arg === '--session-id') && args[i + 1]) {
      return args[i + 1]!;
    }
    if (arg.startsWith('--session=')) return arg.slice('--session='.length) || null;
    if (arg.startsWith('--session-id=')) return arg.slice('--session-id='.length) || null;
  }
  return null;
}

function portFromArgs(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--port' && args[i + 1]) {
      const port = parseInt(args[i + 1]!, 10);
      return Number.isFinite(port) ? port : undefined;
    }
    if (arg.startsWith('--port=')) {
      const port = parseInt(arg.slice('--port='.length), 10);
      return Number.isFinite(port) ? port : undefined;
    }
  }
  return undefined;
}

export function parseOpenCodeProcessLine(line: string): ParsedOpenCodeProcess | null {
  const parsed = parseProcessLine(line);
  if (!parsed) return null;

  const commandIndex = openCodeArgIndex(parsed.args);
  if (commandIndex === -1) return null;

  const opencodeArgs = parsed.args.slice(commandIndex + 1);
  const isServe = opencodeArgs[0] === 'serve';
  if (isServe) {
    const port = portFromArgs(opencodeArgs);
    return {
      pid: parsed.pid,
      sessionId: sessionIdFromArgs(opencodeArgs),
      port,
      isServe: true,
    };
  }

  return { pid: parsed.pid, sessionId: sessionIdFromArgs(opencodeArgs), isServe: false };
}

/**
 * Resolve the CWD for a PID over /proc (Linux) or lsof (macOS).
 */
function getCwdForPid(pid: number): CwdReadDiagnostic {
  try {
    if (platform() === 'linux') {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      return { pid, status: 'ok', cwd, method: 'proc' };
    }
    const output = execSync(`lsof -p ${pid} 2>/dev/null`, {
      encoding: 'utf-8', timeout: 2000,
    });
    const cwdLine = output.split('\n').find((l) => l.includes(' cwd '));
    const cwd = cwdLine?.trim().split(/\s+/).slice(8).join(' ') || null;
    return { pid, status: cwd ? 'ok' : 'unknown', cwd, method: 'lsof' };
  } catch (error) {
    return {
      pid,
      status: cwdStatusForError(error),
      cwd: null,
      method: platform() === 'linux' ? 'proc' : 'lsof',
      error: errorMessage(error),
    };
  }
}

/**
 * Scan all running opencode processes.
 *
 * TUI:   `opencode [-s sessionId]`
 * Serve: `opencode serve ... --port PORT`
 */
export function scanProcesses(): ProcessScanResult {
  try {
    const psOutput = execSync('ps -eo pid,args 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const processes: OpenCodeProcess[] = [];
    const seenPorts = new Set<number>();

    for (const line of psOutput.split('\n')) {
      const parsed = parseOpenCodeProcessLine(line);
      if (!parsed) continue;

      const cwdRead = getCwdForPid(parsed.pid);
      processes.push({
        pid: parsed.pid,
        cwd: cwdRead.cwd,
        cwdRead,
        sessionId: parsed.sessionId,
        port: parsed.port,
        isServe: parsed.isServe,
      });
      if (parsed.port !== undefined) seenPorts.add(parsed.port);
    }

    const liveDirectories = [...new Set(processes.map((p) => p.cwd).filter((cwd): cwd is string => !!cwd))];
    const directSessionIds = [...new Set(processes.map((p) => p.sessionId).filter((id): id is string => !!id))];
    const directoryProcessCounts = processes.reduce<Record<string, number>>((counts, process) => {
      if (process.cwd) counts[process.cwd] = (counts[process.cwd] ?? 0) + 1;
      return counts;
    }, {});
    const cwdReadDiagnostics = processes
      .map((process) => process.cwdRead)
      .filter((diagnostic): diagnostic is CwdReadDiagnostic => !!diagnostic);

    return {
      processes,
      servePorts: [...seenPorts],
      liveDirectories,
      liveSessionIds: directSessionIds,
      directSessionIds,
      directoryProcessCounts,
      cwdReadDiagnostics,
      scanSucceeded: true,
    };
  } catch {
    return {
      processes: [],
      servePorts: [],
      liveDirectories: [],
      liveSessionIds: [],
      directSessionIds: [],
      directoryProcessCounts: {},
      cwdReadDiagnostics: [],
      scanSucceeded: false,
    };
  }
}
