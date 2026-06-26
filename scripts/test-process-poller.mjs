#!/usr/bin/env node
// Deterministic parser checks for OpenCode process attribution.

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
const logPath = join(ROOT, 'logs', `test_process_poller_${timestamp}.log`);
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
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    console.log(`  PASS  ${label} -> ${a}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${label}\n        expected ${e}\n        got      ${a}`);
}

const OUT_DIR = join(ROOT, 'tmp', 'process-poller-test');
rmSync(OUT_DIR, { recursive: true, force: true });
const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
const tscRes = spawnSync(tsc, [
  join('src', 'lib', 'process', 'poller.ts'),
  '--outDir', OUT_DIR,
  '--module', 'commonjs',
  '--target', 'es2022',
  '--moduleResolution', 'node',
  '--skipLibCheck',
  '--noEmitOnError', 'false',
], { encoding: 'utf-8', cwd: ROOT });

if (tscRes.status !== 0) {
  console.error('tsc failed to compile poller.ts:');
  console.error(tscRes.stdout);
  console.error(tscRes.stderr);
  logStream.end();
  process.exit(1);
}

writeFileSync(join(OUT_DIR, 'package.json'), '{"type":"commonjs"}\n');
const compiledPath = existsSync(join(OUT_DIR, 'process', 'poller.js'))
  ? join(OUT_DIR, 'process', 'poller.js')
  : join(OUT_DIR, 'poller.js');
const { parseOpenCodeProcessLine } = require(compiledPath);

console.log(`Compiled poller.ts. Log file: ${logPath}\n`);

assertEqual(parseOpenCodeProcessLine('123 opencode -s ses_direct'), {
  pid: 123,
  sessionId: 'ses_direct',
  isServe: false,
}, 'parses short session flag');

assertEqual(parseOpenCodeProcessLine('124 opencode --session-id=ses_equals'), {
  pid: 124,
  sessionId: 'ses_equals',
  isServe: false,
}, 'parses equals session flag');

assertEqual(parseOpenCodeProcessLine('125 node /usr/bin/opencode --session ses_wrapped'), {
  pid: 125,
  sessionId: 'ses_wrapped',
  isServe: false,
}, 'parses node-wrapped opencode command');

assertEqual(parseOpenCodeProcessLine('126 opencode serve --port 35001'), {
  pid: 126,
  sessionId: null,
  port: 35001,
  isServe: true,
}, 'parses serve port');

assertEqual(parseOpenCodeProcessLine('127 bash opencode-ish'), null, 'rejects non-opencode command');
assertEqual(parseOpenCodeProcessLine('not-a-pid opencode'), null, 'rejects malformed pid');

console.log(`\n=== ${passed} passed, ${failed} failed ===`);

rmSync(OUT_DIR, { recursive: true, force: true });
logStream.end();
process.exit(failed === 0 ? 0 : 1);
