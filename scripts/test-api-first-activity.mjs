#!/usr/bin/env node
// Self-test for the API-first lastActivity computation (Step 4 of
// fix-idle-during-text-generation).
//
// Compiles opencode.ts and tests `computeApiFirstLastActivityMs` — a pure
// helper that combines session-row and part-level timestamps to decide
// whether a session should stay `working` during active text generation.
//
// Run: node scripts/test-api-first-activity.mjs

import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);

// --- logging ---
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const logPath = join(ROOT, 'logs', `test_api_first_activity_${timestamp}.log`);
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

// --- compile opencode.ts ---
const OUT_DIR = join(ROOT, 'tmp', 'test-api-first-activity-build');
rmSync(OUT_DIR, { recursive: true, force: true });
const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
const tscRes = spawnSync(tsc, [
  join('src', 'lib', 'agents', 'opencode.ts'),
  '--outDir', OUT_DIR,
  '--module', 'commonjs',
  '--target', 'es2022',
  '--moduleResolution', 'node',
  '--esModuleInterop',
  '--skipLibCheck',
], { encoding: 'utf-8', cwd: ROOT });

if (tscRes.status !== 0) {
  console.error('tsc failed to compile opencode.ts:');
  console.error(tscRes.stdout);
  console.error(tscRes.stderr);
  process.exit(1);
}

writeFileSync(join(OUT_DIR, 'package.json'), '{"type":"commonjs"}\n');
const opencodePath = join(OUT_DIR, 'agents', 'opencode.js');
const { computeApiFirstLastActivityMs } = require(opencodePath);

// --- tests ---
const WORKING_GRACE_MS = 10_000;
const NOW = 1_000_000_000_000; // fixed "now" for deterministic tests

console.log('=== computeApiFirstLastActivityMs ===');

// 1. Both session and part are recent (< grace) => near-zero delta
{
  const sessionTime = NOW - 2_000;  // 2s ago
  const partTime = NOW - 500;       // 0.5s ago
  const delta = computeApiFirstLastActivityMs(sessionTime, partTime, NOW);
  assert(delta <= WORKING_GRACE_MS, `recent part (${delta}ms) within grace window`);
  assert(delta === 500, `recent part -> ${delta}ms (expected 500)`);
}

// 2. Session old but part recent => part keeps it alive
{
  const sessionTime = NOW - 60_000; // 60s ago (stale session row)
  const partTime = NOW - 3_000;     // 3s ago (recent part)
  const delta = computeApiFirstLastActivityMs(sessionTime, partTime, NOW);
  assert(delta <= WORKING_GRACE_MS, `session stale but part recent (${delta}ms) within grace`);
  assert(delta === 3_000, `part-time wins -> ${delta}ms (expected 3000)`);
}

// 3. Both old => idle-grade
{
  const sessionTime = NOW - 120_000; // 2m ago
  const partTime = NOW - 60_000;     // 1m ago
  const delta = computeApiFirstLastActivityMs(sessionTime, partTime, NOW);
  assert(delta > WORKING_GRACE_MS, `both old (${delta}ms) exceeds grace window`);
}

// 4. No parts (partTime = 0) => falls back to session time
{
  const sessionTime = NOW - 5_000; // 5s ago
  const partTime = 0;
  const delta = computeApiFirstLastActivityMs(sessionTime, partTime, NOW);
  assert(delta <= WORKING_GRACE_MS, `no parts, session recent (${delta}ms) within grace`);
  assert(delta === 5_000, `session-only fallback -> ${delta}ms (expected 5000)`);
}

// 5. No parts, session old => idle-grade
{
  const sessionTime = NOW - 30_000; // 30s ago
  const partTime = 0;
  const delta = computeApiFirstLastActivityMs(sessionTime, partTime, NOW);
  assert(delta > WORKING_GRACE_MS, `no parts, session old (${delta}ms) exceeds grace`);
}

// 6. Session row time > part time => session row wins
{
  const sessionTime = NOW - 1_000; // 1s ago
  const partTime = NOW - 5_000;    // 5s ago
  const delta = computeApiFirstLastActivityMs(sessionTime, partTime, NOW);
  assert(delta <= WORKING_GRACE_MS, `session row newer (${delta}ms) within grace`);
  assert(delta === 1_000, `session-time wins -> ${delta}ms (expected 1000)`);
}

// 7. Edge: both zero (no timestamps at all) => delta = now - 0 = NOW
{
  const delta = computeApiFirstLastActivityMs(0, 0, NOW);
  assert(delta === NOW, `both zero -> ${delta}ms (expected ${NOW})`);
}

// 8. Edge: future timestamps (clock skew) => clamped to 0
{
  const future = NOW + 5_000;
  const delta = computeApiFirstLastActivityMs(future, 0, NOW);
  assert(delta === 0, `future session time -> ${delta}ms (clamped to 0)`);
}

// 9. Boundary: exactly at WORKING_GRACE_MS
{
  const sessionTime = NOW - WORKING_GRACE_MS;
  const partTime = 0;
  const delta = computeApiFirstLastActivityMs(sessionTime, partTime, NOW);
  assert(delta === WORKING_GRACE_MS, `exactly at grace boundary -> ${delta}ms (expected ${WORKING_GRACE_MS})`);
}

// 10. Edge: all timestamps equal => delta = 0
{
  const t = NOW;
  const delta = computeApiFirstLastActivityMs(t, t, t);
  assert(delta === 0, `equal timestamps -> ${delta}ms (expected 0)`);
}

// 11. Both times slightly over grace => idle-grade
{
  const sessionTime = NOW - WORKING_GRACE_MS - 1;
  const partTime = NOW - WORKING_GRACE_MS - 1;
  const delta = computeApiFirstLastActivityMs(sessionTime, partTime, NOW);
  assert(delta > WORKING_GRACE_MS, `both just over grace (${delta}ms) exceeds grace window`);
}

// --- summary ---
console.log(`\n=== ${passed} passed, ${failed} failed ===`);

// --- cleanup ---
rmSync(OUT_DIR, { recursive: true, force: true });
logStream.end();

if (failed > 0) process.exit(1);
