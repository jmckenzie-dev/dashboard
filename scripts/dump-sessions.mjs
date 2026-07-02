#!/usr/bin/env node
// Per-session debug dump for the dashboard.
//
// Two modes:
//
// 1. Compile mode (default): Calls the REAL production pipeline
//    (`getOpenCodeSessionsWithDiagnostics` in src/lib/agents/opencode.ts) —
//    compiled to plain JS via tsc — and prints, per OpenCode session, the full
//    state the dashboard sees.
//
// 2. Endpoint mode (--endpoint): Fetches GET /api/status/diagnose from a
//    RUNNING dashboard instance instead of compiling the pipeline. Useful for
//    inspecting a test dashboard's isolated view (including its own config).
//
// No pipeline logic is duplicated — this script only wires logging + formatting
// around the real functions. Logs to ./logs/ alongside the other dashboard
// scripts (see AGENTS.md).
//
// Usage:
//   node scripts/dump-sessions.mjs                       # all sessions, human-readable
//   node scripts/dump-sessions.mjs --session bigcodebench # filter by id/title substring
//   node scripts/dump-sessions.mjs --json                 # machine-readable (pipe to jq)
//   node scripts/dump-sessions.mjs --no-hidden            # exclude hidden_stale sessions
//   node scripts/dump-sessions.mjs --no-parts             # omit the raw parts block
//   node scripts/dump-sessions.mjs --endpoint http://127.0.0.1:50001  # query a running dashboard
//   node scripts/dump-sessions.mjs --endpoint http://127.0.0.1:50001 --auth admin:secret
//   node scripts/dump-sessions.mjs --help

import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);

// --- argv ---
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const filter = argValue('--session');
const jsonMode = args.includes('--json');
const includeHidden = !args.includes('--no-hidden');
const showParts = !args.includes('--no-parts');
const endpointUrl = argValue('--endpoint');
const authCreds = argValue('--auth');
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`Usage: node scripts/dump-sessions.mjs [options]

Options:
  --session <substr>     Filter sessions by raw id, opencode-<id>, or title (case-insensitive).
  --json                 Emit one JSON object on stdout (for jq/agents); disables log tee.
  --no-hidden            Exclude sessions with visibilityReason 'hidden_stale'.
  --no-parts             Omit the recent-parts block per session.
  --endpoint <base-url>  Fetch from a running dashboard's /api/status/diagnose instead of compiling.
  --auth <user:pass>     Basic auth credentials (required when the dashboard has a password hash).
  -h, --help             Show this help.
`);
  process.exit(0);
}

// --- logging (only in human mode) ---
let logStream = null;
const originalLog = console.log.bind(console);
const originalErr = console.error.bind(console);
if (!jsonMode) {
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  logStream = createWriteStream(join(ROOT, 'logs', `dump_sessions_${ts}.log`), { flags: 'a' });
  const emit = (dst, args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
    logStream.write(`${line}\n`);
    dst(line);
  };
  console.log = (...a) => emit(originalLog, a);
  console.error = (...a) => emit(originalErr, a);
}

// --- compile the real modules (opencode.ts + its dep graph) ---
const OUT_DIR = join(ROOT, 'tmp', `dump-sessions-build-${process.pid}`);
rmSync(OUT_DIR, { recursive: true, force: true });
const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
const sources = [
  join('src', 'lib', 'agents', 'opencode.ts'),
];
const tscRes = spawnSync(tsc, [
  ...sources,
  '--outDir', OUT_DIR,
  '--module', 'commonjs',
  '--target', 'es2022',
  '--moduleResolution', 'node',
  '--esModuleInterop',
  '--skipLibCheck',
  '--noEmitOnError', 'false',
], { encoding: 'utf-8', cwd: ROOT });

if (tscRes.status !== 0) {
  console.error('tsc failed to compile opencode.ts:');
  console.error(tscRes.stdout);
  console.error(tscRes.stderr);
  if (logStream) logStream.end();
  process.exit(1);
}

writeFileSync(join(OUT_DIR, 'package.json'), '{"type":"commonjs"}\n');
// tsc derives rootDir from the compiled graph (src/lib here), so output is
// laid out as <OUT_DIR>/agents/opencode.js, <OUT_DIR>/config.js, etc.
const opencodePath = join(OUT_DIR, 'agents', 'opencode.js');
const opencode = require(opencodePath);
const configLib = require(join(OUT_DIR, 'config.js'));
const { getOpenCodeSessionsWithDiagnostics, resolveOpenCodeDbPath } = opencode;
const { loadConfig } = configLib;

// --- helpers ---
function humanizeMs(ms) {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${ms}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (abs < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  if (abs < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
function fmtParts(parts) {
  // parts are NormalizedPart[] already in DB order (DESC). Show newest first.
  return parts.map((p) => {
    const bits = [`type=${p.type}`];
    if (p.tool) bits.push(`tool=${p.tool}`);
    if (p.status) bits.push(`status=${p.status}`);
    if (p.callID) bits.push(`callID=${p.callID}`);
    if (p.reason) bits.push(`reason=${p.reason}`);
    return `  [t=${p.time}] ${bits.join(' ')}`;
  });
}

async function main() {
  let candidates;

  if (endpointUrl) {
    // Endpoint mode: fetch from a running dashboard's /api/status/diagnose
    const base = endpointUrl.replace(/\/+$/, '');
    const headers = {};
    if (authCreds) {
      headers['Authorization'] = 'Basic ' + Buffer.from(authCreds).toString('base64');
    }
    const res = await fetch(`${base}/api/status/diagnose`, { headers });
    if (!res.ok) {
      console.error(`Endpoint returned ${res.status} ${res.statusText}`);
      if (logStream) logStream.end();
      process.exit(1);
    }
    const raw = await res.json();
    // Convert ISO date strings back to Date objects
    candidates = raw.map((s) => ({
      ...s,
      lastActivity: new Date(s.lastActivity),
    }));
  } else {
    // Compile mode: compile opencode.ts and run the real pipeline
    candidates = await getOpenCodeSessionsWithDiagnostics({ includeHidden: true });
  }

  // Filter
  let view = candidates;
  if (filter) {
    const needle = filter.toLowerCase();
    view = candidates.filter((s) =>
      s.id.toLowerCase().includes(needle) ||
      (s.diagnostic && s.id.replace(/^opencode-/, '').toLowerCase().includes(needle)) ||
      (s.name && s.name.toLowerCase().includes(needle)),
    );
  }
  if (!includeHidden) {
    view = view.filter((s) => s.visibilityReason !== 'hidden_stale');
  }

  // Resolve the DB path actually in use (for the summary header).
  let config = null;
  let dbPath = null;
  if (!endpointUrl) {
    config = await loadConfig();
    dbPath = config?.agents?.opencode?.dbPath
      ? resolveOpenCodeDbPath(config.agents.opencode.dbPath)
      : null;
  }

  // Status counts over the (filtered) view.
  const counts = {};
  for (const s of view) counts[s.status] = (counts[s.status] ?? 0) + 1;

  if (jsonMode) {
    const payload = {
      _meta: {
        generated_at: new Date().toISOString(),
        filter: filter ?? null,
        include_hidden: includeHidden,
        mode: endpointUrl ? 'endpoint' : 'compile',
        endpoint: endpointUrl ?? null,
        db_path: dbPath,
        api_base: config?.agents?.opencode?.apiBase ?? null,
      },
      status_counts: counts,
      sessions: view.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        phase: s.phase ?? null,
        blockReason: s.blockReason ?? null,
        directory: s.directory ?? null,
        parentId: s.parentId ?? null,
        visible: s.visibilityReason !== 'hidden_stale',
        instanceAlive: s.instanceAlive ?? null,
        livenessReason: s.livenessReason ?? null,
        visibilityReason: s.visibilityReason ?? null,
        lastActivity: s.lastActivity.toISOString(),
        lastActivityAgeMs: Date.now() - s.lastActivity.getTime(),
        blockingRequestIds: s.blockingRequestIds ?? [],
        diagnostic: s.diagnostic,
      })),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  // Human mode
  console.log(`=== dashboard session dump (${new Date().toISOString()}) ===`);
  console.log(`mode: ${endpointUrl ? `endpoint (${endpointUrl})` : 'compile'}`);
  console.log(`db_path: ${dbPath ?? '<unresolved>'}`);
  console.log(`api_base: ${config?.agents?.opencode?.apiBase ?? '<none>'}`);
  console.log(`filter: ${filter ?? '<none>'}  include_hidden: ${includeHidden}`);
  console.log(`sessions shown: ${view.length} (of ${candidates.length} total candidates)`);
  console.log(`status counts: ${JSON.stringify(counts)}`);
  console.log('');

  if (view.length === 0) {
    console.log('No sessions matched.');
    return;
  }

  for (const s of view) {
    const age = Date.now() - s.lastActivity.getTime();
    const d = s.diagnostic;
    console.log(`=== ${s.id}  [${s.status}]  phase=${s.phase ?? '?'}  visible=${s.visibilityReason !== 'hidden_stale'}  age=${humanizeMs(age)}`);
    console.log(`  title      : ${s.name}`);
    console.log(`  directory  : ${s.directory ?? '<none>'}`);
    console.log(`  parentId   : ${s.parentId ?? '<none>'}`);
    console.log(`  lastActivity : ${s.lastActivity.toISOString()} (${humanizeMs(age)} ago)`);
    if (s.blockingRequestIds && s.blockingRequestIds.length) {
      console.log(`  blockingRequestIds : ${JSON.stringify(s.blockingRequestIds)}`);
    }
    if (!d) {
      console.log('  <no diagnostic captured>');
      console.log('');
      continue;
    }
    console.log(`  --- API signals ---`);
    console.log(`  sessionStatus     : ${JSON.stringify(d.sessionStatus)}`);
    console.log(`  hasActiveInstance : ${d.hasActiveInstance}`);
    console.log(`  permIds           : ${JSON.stringify(d.permIds)}`);
    console.log(`  questIds          : ${JSON.stringify(d.questIds)}`);
    console.log(`  --- inference inputs ---`);
    console.log(`  latestTool          : ${d.latestTool ? JSON.stringify(d.latestTool) : 'null'}`);
    console.log(`  latestStepReason    : ${JSON.stringify(d.latestStepReason)}`);
    console.log(`  hasError            : ${d.hasError}`);
    console.log(`  latestPartType      : ${JSON.stringify(d.latestPartType)}`);
    console.log(`  latestPartIsActiveTool: ${d.latestPartIsActiveTool}`);
    console.log(`  lastActivityMs      : ${d.lastActivityMs} (${humanizeMs(d.lastActivityMs)})`);
    console.log(`  inferenceInput      : ${JSON.stringify(d.inferenceInput)}`);
    console.log(`  --- inference outputs ---`);
    console.log(`  inferredStatus : ${s.status}`);
    console.log(`  phase          : ${s.phase ?? '?'}`);
    console.log(`  blockReason    : ${s.blockReason ?? 'null'}`);
    console.log(`  --- liveness ---`);
    console.log(`  candidate : ${JSON.stringify(d.livenessCandidate)}`);
    console.log(`  decision  : { instanceAlive: ${s.instanceAlive ?? 'null'}, livenessReason: ${JSON.stringify(s.livenessReason ?? null)}, visibilityReason: ${JSON.stringify(s.visibilityReason ?? null)} }`);
    if (showParts && d.parts.length) {
      console.log(`  --- parts (newest first, ${d.parts.length}) ---`);
      for (const line of fmtParts(d.parts)) console.log(line);
    }
    console.log('');
  }
}

main()
  .catch((error) => {
    console.error('dump-sessions failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(OUT_DIR, { recursive: true, force: true });
    if (logStream) logStream.end();
  });
