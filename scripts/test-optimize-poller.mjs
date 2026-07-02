#!/usr/bin/env node
// Optimization test suite verifying DB consolidation, part caching, poller caching/eviction, and metrics.

import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);

mkdirSync(join(ROOT, 'logs'), { recursive: true });
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const logPath = join(ROOT, 'logs', `test_optimize_poller_${timestamp}.log`);
const logStream = createWriteStream(logPath, { flags: 'a' });

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };
function emit(level, args) {
  const line = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)).join(' ');
  logStream.write(`${line}\n`);
  originalConsole[level](line);
}
console.log = (...args) => emit('log', args);
console.error = (...args) => emit('error', args);

let passed = 0;
let failed = 0;
function assert(condition, label, details = null) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${label}${details ? `\n        ${details}` : ''}`);
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${label} -> ${a}`, `expected ${e}, got ${a}`);
}

const OUT_DIR = join(ROOT, 'tmp', 'optimize-poller-test');
rmSync(OUT_DIR, { recursive: true, force: true });

// Setup global mock for child_process and fs BEFORE compiling/loading
const cp = require('node:child_process');
const fsModule = require('node:fs');

let mockPsOutput = '';
let mockCwdMap = {};
let readlinkCount = 0;

// Save original methods
const originalExecSync = cp.execSync;
const originalReadlinkSync = fsModule.readlinkSync;

// Mock execSync to intercept ps commands
cp.execSync = function(cmd, opts) {
  if (typeof cmd === 'string' && cmd.includes('ps -eo pid,args')) {
    return mockPsOutput;
  }
  return originalExecSync.apply(this, arguments);
};

// Mock readlinkSync to intercept /proc/pid/cwd links
fsModule.readlinkSync = function(path, opts) {
  if (typeof path === 'string' && path.startsWith('/proc/')) {
    readlinkCount++;
    const pid = parseInt(path.split('/')[2], 10);
    if (mockCwdMap[pid]) {
      return mockCwdMap[pid];
    }
    const err = new Error('ENOENT: no such file or directory');
    err.code = 'ENOENT';
    throw err;
  }
  return originalReadlinkSync.apply(this, arguments);
};

// Override platform to linux so it usesproc/pid/cwd
const os = require('node:os');
const originalPlatform = os.platform;
os.platform = () => 'linux';

// Compile TypeScript files
console.log('Compiling TypeScript files...');
const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
const tscRes = spawnSync(tsc, [
  join('src', 'lib', 'config.ts'),
  join('src', 'lib', 'metrics.ts'),
  join('src', 'lib', 'process', 'poller.ts'),
  join('src', 'lib', 'agents', 'opencode.ts'),
  '--outDir', OUT_DIR,
  '--module', 'commonjs',
  '--target', 'es2022',
  '--moduleResolution', 'node',
  '--skipLibCheck',
  '--esModuleInterop',
  '--noEmitOnError', 'false',
], { encoding: 'utf-8', cwd: ROOT });

if (tscRes.status !== 0) {
  console.error('tsc failed to compile:');
  console.error(tscRes.stdout);
  console.error(tscRes.stderr);
  logStream.end();
  process.exit(1);
}

writeFileSync(join(OUT_DIR, 'package.json'), '{"type":"commonjs"}\n');

// Load compiled CommonJS modules
const pollerPath = join(OUT_DIR, 'process', 'poller.js');
const metricsPath = join(OUT_DIR, 'metrics.js');
const opencodePath = join(OUT_DIR, 'agents', 'opencode.js');
const configPath = join(OUT_DIR, 'config.js');

const poller = require(pollerPath);
const metrics = require(metricsPath);
const opencode = require(opencodePath);
const configModule = require(configPath);

console.log(`Compiled test dependencies. Log file: ${logPath}\n`);

// ----------------------------------------------------
// TEST 1: Background Process Poller, CWD caching, exit eviction
// ----------------------------------------------------
console.log('--- TEST 1: Process Poller caching & eviction ---');
readlinkCount = 0;
mockCwdMap = {
  100: '/repo/dir1',
  101: '/repo/dir2',
};
mockPsOutput = '  100 opencode -s ses1\n  101 opencode -s ses2\n';

// Stop automatic poller (if running) and run manually
poller.stopBackgroundPoller();
const scan1 = poller.runScan();

assertEqual(scan1.processes.length, 2, 'resolves 2 processes on first scan');
assertEqual(readlinkCount, 2, 'readlinkSync is called twice for 2 new processes');
assertEqual(scan1.processes[0].cwd, '/repo/dir1', 'resolves cwd for pid 100');
assertEqual(scan1.processes[1].cwd, '/repo/dir2', 'resolves cwd for pid 101');

// Run scan again with same processes
readlinkCount = 0;
const scan2 = poller.runScan();
assertEqual(scan2.processes.length, 2, 'resolves 2 processes on second scan');
assertEqual(readlinkCount, 0, 'readlinkSync is NOT called (hits PID cache)');

// Eviction test: pid 101 terminates
mockPsOutput = '  100 opencode -s ses1\n';
readlinkCount = 0;
const scan3 = poller.runScan();
assertEqual(scan3.processes.length, 1, 'resolves 1 process after pid 101 exits');
assertEqual(readlinkCount, 0, 'readlinkSync is not called');

// Re-entry test: pid 101 starts again (re-resolved)
mockPsOutput = '  100 opencode -s ses1\n  101 opencode -s ses2\n';
readlinkCount = 0;
const scan4 = poller.runScan();
assertEqual(scan4.processes.length, 2, 'resolves 2 processes after pid 101 restarts');
assertEqual(readlinkCount, 1, 'readlinkSync is called once for evicted pid 101');

// Fast-path test
const cachedScan = poller.scanProcesses();
assertEqual(cachedScan.processes.length, 2, 'scanProcesses returns cached results immediately');

// ----------------------------------------------------
// TEST 2: Part Parsing Cache & single JSON parsing
// ----------------------------------------------------
console.log('\n--- TEST 2: Part Parsing Cache ---');
const testPart1 = {
  id: 'part_1',
  session_id: 'ses_a',
  message_id: 'msg_1',
  time_created: 1000,
  time_updated: null,
  data: JSON.stringify({ type: 'text', text: 'Hello, World!' }),
};

const testPart2 = {
  id: 'part_2',
  session_id: 'ses_a',
  message_id: 'msg_2',
  time_created: 2000,
  time_updated: 10,
  data: JSON.stringify({ type: 'tool', tool: 'run_command', state: { status: 'success', output: 'ok' } }),
};

// Reset metrics or fetch them
const getCacheMetric = async (resultType) => {
  const values = (await metrics.partCacheHits.get()).values;
  const entry = values.find(v => v.labels.result === resultType);
  return entry ? entry.value : 0;
};

const hitsBefore = await getCacheMetric('hit');
const missesBefore = await getCacheMetric('miss');

// Call parsePartData
const parsed1 = opencode.parsePartData([testPart1, testPart2]);
assertEqual(parsed1.messages.length, 2, 'extracts 2 messages');

const hitsAfter1 = await getCacheMetric('hit');
const missesAfter1 = await getCacheMetric('miss');

assertEqual(missesAfter1 - missesBefore, 2, 'registers 2 cache misses on first parse');
assertEqual(hitsAfter1 - hitsBefore, 0, 'registers 0 cache hits on first single-pass parse');

// Run again to hit cache
const parsed2 = opencode.parsePartData([testPart1, testPart2]);
const hitsAfter2 = await getCacheMetric('hit');
const missesAfter2 = await getCacheMetric('miss');

assertEqual(missesAfter2 - missesAfter1, 0, 'registers 0 new cache misses');
assertEqual(hitsAfter2 - hitsAfter1, 2, 'registers 2 cache hits on second single-pass execution');

// ----------------------------------------------------
// TEST 3: DB Consolidation Query
// ----------------------------------------------------
console.log('\n--- TEST 3: SQLite Database Consolidation ---');
const Database = require('better-sqlite3');
const tempDbPath = join(ROOT, 'tmp', 'test_opencode_consolidated.db');
rmSync(tempDbPath, { force: true });

const db = new Database(tempDbPath);
db.exec(`
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    parent_id TEXT,
    directory TEXT,
    title TEXT,
    time_created INTEGER,
    time_updated INTEGER,
    time_archived INTEGER
  );

  CREATE TABLE part (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    message_id TEXT,
    time_created INTEGER,
    time_updated INTEGER,
    data TEXT
  );
`);

// Insert sessions
db.prepare(`
  INSERT INTO session (id, title, directory, time_created, time_updated)
  VALUES 
    ('ses_1', 'Session One', '/repo/a', 100, 150),
    ('ses_2', 'Session Two', '/repo/b', 200, 250);
`).run();

// Insert parts (multiple parts per session to test row partitioning)
db.prepare(`
  INSERT INTO part (id, session_id, message_id, time_created, time_updated, data)
  VALUES 
    ('p1_1', 'ses_1', 'm1', 110, null, '{"type":"text","text":"hello from s1 p1"}'),
    ('p1_2', 'ses_1', 'm2', 120, null, '{"type":"text","text":"hello from s1 p2"}'),
    ('p2_1', 'ses_2', 'm3', 210, null, '{"type":"text","text":"hello from s2 p1"}');
`).run();
db.close();

// Mock loadConfig to return our temporary test database path
configModule.loadConfig = async () => {
  return {
    agents: {
      opencode: {
        enabled: true,
        dbPath: tempDbPath,
        apiBase: null,
      }
    }
  };
};

const sessionsList = await opencode.getOpenCodeSessions({ includeHidden: true });
assertEqual(sessionsList.length, 2, 'retrieves both sessions from SQLite');
assertEqual(sessionsList.find(s => s.id === 'opencode-ses_1').messages.length, 2, 'session 1 has 2 parsed messages');
assertEqual(sessionsList.find(s => s.id === 'opencode-ses_2').messages.length, 1, 'session 2 has 1 parsed message');

// ----------------------------------------------------
// TEST 4: Prometheus Metrics Registration
// ----------------------------------------------------
console.log('\n--- TEST 4: Prometheus Metrics Registration ---');
const metricsOutput = await metrics.registry.metrics();

assert(metricsOutput.includes('dashboard_poll_duration_seconds_bucket'), 'metrics contains poll duration histogram');
assert(metricsOutput.includes('dashboard_part_cache_hits_total'), 'metrics contains cache hits counter');
assert(metricsOutput.includes('dashboard_sse_clients_active'), 'metrics contains sse clients active gauge');
assert(metricsOutput.includes('dashboard_sessions_total'), 'metrics contains sessions total gauge');

// ----------------------------------------------------
// TEST 5: API-primary SQLite live supplements
// ----------------------------------------------------
console.log('\n--- TEST 5: API-primary live supplement selection ---');
const supplementIds = opencode.liveSupplementSessionIds(
  [
    { id: 'opencode-ses_api_present' },
    { id: 'opencode-ses_status_present' },
  ],
  {
    ses_status_present: { type: 'busy' },
    ses_status_missing: { type: 'busy' },
  },
  {
    permissionsBySession: new Map([['ses_perm_missing', ['per_1']]]),
    questionsBySession: new Map([['ses_question_missing', ['que_1']]]),
  },
  {
    liveSessionIds: new Set(['ses_api_present', 'ses_process_missing']),
  },
);
assertEqual(
  [...supplementIds].sort(),
  ['ses_perm_missing', 'ses_process_missing', 'ses_question_missing', 'ses_status_missing'],
  'supplements include only live/blocking/status ids absent from API session list',
);

const supplementNow = 2_000_000;
assertEqual(
  opencode.isRecentSQLiteSupplement({ lastActivity: new Date(supplementNow - 1_000) }, supplementNow),
  true,
  'recent SQLite sessions supplement API-first snapshots when proc cwd is unavailable',
);
assertEqual(
  opencode.isRecentSQLiteSupplement({ lastActivity: new Date(supplementNow - 11 * 60 * 1000) }, supplementNow),
  false,
  'old SQLite sessions are not blanket supplements in API-first snapshots',
);

console.log('\n--- Cleanup ---');
rmSync(OUT_DIR, { recursive: true, force: true });
rmSync(tempDbPath, { force: true });

// Restore original methods
cp.execSync = originalExecSync;
fsModule.readlinkSync = originalReadlinkSync;
os.platform = originalPlatform;

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
logStream.end();
process.exit(failed === 0 ? 0 : 1);
