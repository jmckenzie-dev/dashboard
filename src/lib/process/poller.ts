// OS process scanner for OpenCode instances.
// Implements the reference's process-first discovery model (docs/reference_comparison.md §3.1–§3.3).
// Pure OS-level module; no SQLite dependency. Callers in opencode.ts handle DB mapping.

import { execSync } from 'node:child_process';
import { existsSync, readlinkSync } from 'node:fs';
import { platform } from 'node:os';

export interface OpenCodeProcess {
  pid: number;
  cwd: string | null;
  sessionId: string | null;   // from -s flag, or null for flagless TUI
  port?: number;               // only for opencode serve processes
  isServe: boolean;
}

export interface ProcessScanResult {
  processes: OpenCodeProcess[];
  servePorts: number[];
  /** Directories known to back live processes */
  liveDirectories: string[];
  /** Session IDs explicitly known from process args or live serve APIs */
  liveSessionIds: string[];
  /** Whether the OS process scan succeeded */
  scanSucceeded: boolean;
}

/**
 * Resolve the CWD for a PID over /proc (Linux) or lsof (macOS).
 */
function getCwdForPid(pid: number): string | null {
  try {
    if (platform() === 'linux') {
      const cwdPath = `/proc/${pid}/cwd`;
      if (!existsSync(cwdPath)) return null;
      return readlinkSync(cwdPath);
    }
    const output = execSync(`lsof -p ${pid} 2>/dev/null`, {
      encoding: 'utf-8', timeout: 2000,
    });
    const cwdLine = output.split('\n').find((l) => l.includes(' cwd '));
    return cwdLine?.trim().split(/\s+/).slice(8).join(' ') || null;
  } catch {
    return null;
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
      const trimmed = line.trim();
      if (!trimmed) continue;

      // TUI: `opencode`, `/path/to/opencode`, or wrapper-invoked
      // `node|bun|deno /path/to/opencode`, optionally with `-s sessionId`.
      const tuiMatch = trimmed.match(
        /^(\d+)\s+(?:(?:node|bun|deno)\s+\S*\/opencode|\S*\/opencode|opencode)(?:\s+-s\s+(\S+))?$/
      );
      if (tuiMatch) {
        const pid = parseInt(tuiMatch[1]!, 10);
        const sessionId = tuiMatch[2] ?? null;
        const cwd = getCwdForPid(pid);
        processes.push({ pid, cwd, sessionId, isServe: false });
        continue;
      }

      // Serve: `opencode serve ... --port PORT` with the same executable forms.
      const serveMatch = trimmed.match(
        /^(\d+)\s+(?:(?:node|bun|deno)\s+\S*\/opencode|\S*\/opencode|opencode)\s+serve\s+.*--port\s+(\d+)/
      );
      if (serveMatch) {
        const pid = parseInt(serveMatch[1]!, 10);
        const port = parseInt(serveMatch[2]!, 10);
        const cwd = getCwdForPid(pid);
        processes.push({ pid, cwd, sessionId: null, port, isServe: true });
        seenPorts.add(port);
        continue;
      }
    }

    const liveDirectories = [...new Set(processes.map((p) => p.cwd).filter((cwd): cwd is string => !!cwd))];
    const liveSessionIds = [...new Set(processes.map((p) => p.sessionId).filter((id): id is string => !!id))];

    return {
      processes,
      servePorts: [...seenPorts],
      liveDirectories,
      liveSessionIds,
      scanSucceeded: true,
    };
  } catch {
    return {
      processes: [],
      servePorts: [],
      liveDirectories: [],
      liveSessionIds: [],
      scanSucceeded: false,
    };
  }
}

/**
 * Query a serve process's /session endpoint to discover sessions it hosts.
 */
export async function getSessionsFromPort(
  port: number,
): Promise<Array<{ id: string; directory?: string }>> {
  try {
    const res = await fetch(`http://localhost:${port}/session`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    return (await res.json()) as Array<{ id: string; directory?: string }>;
  } catch {
    return [];
  }
}

/**
 * Query a serve process's /session/status endpoint.
 */
export async function getStatusFromPort(
  port: number,
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`http://localhost:${port}/session/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
