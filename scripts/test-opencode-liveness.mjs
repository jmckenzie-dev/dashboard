#!/usr/bin/env node
// Deterministic regression/property checks for OpenCode liveness allocation.
// Compiles and imports the real src/lib/agents/opencode-liveness.ts module.

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
const logPath = join(ROOT, 'logs', `test_opencode_liveness_${timestamp}.log`);
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

const OUT_DIR = join(ROOT, 'tmp', 'opencode-liveness-test');
rmSync(OUT_DIR, { recursive: true, force: true });
const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
const tscRes = spawnSync(tsc, [
  join('src', 'lib', 'agents', 'opencode-liveness.ts'),
  '--outDir', OUT_DIR,
  '--module', 'commonjs',
  '--target', 'es2022',
  '--moduleResolution', 'node',
  '--skipLibCheck',
  '--noEmitOnError', 'false',
], { encoding: 'utf-8', cwd: ROOT });

if (tscRes.status !== 0) {
  console.error('tsc failed to compile opencode-liveness.ts:');
  console.error(tscRes.stdout);
  console.error(tscRes.stderr);
  logStream.end();
  process.exit(1);
}

writeFileSync(join(OUT_DIR, 'package.json'), '{"type":"commonjs"}\n');
const compiledPath = existsSync(join(OUT_DIR, 'agents', 'opencode-liveness.js'))
  ? join(OUT_DIR, 'agents', 'opencode-liveness.js')
  : join(OUT_DIR, 'opencode-liveness.js');
const liveness = require(compiledPath);
const { allocateOpenCodeLiveness, hasOpenCodeStatusLiveness, RECENT_ACTIVE_FALLBACK_MS } = liveness;

const NOW = 2_000_000;
function candidate(id, overrides = {}) {
  const offset = overrides.offset ?? 60_000;
  return {
    id,
    parentId: null,
    directory: '/repo/a',
    lastActivity: new Date(NOW - offset),
    hasStatusSignal: false,
    hasBlockingRequest: false,
    hasActiveTool: false,
    hasProcessSessionId: false,
    ...overrides,
  };
}
function cwdAllocated(decisions, directory = '/repo/a') {
  return [...decisions.entries()]
    .filter(([, decision]) => decision.visibilityReason === 'cwd_allocated')
    .filter(([id]) => id.startsWith(directory === '/repo/a' ? 'a-' : 'b-'))
    .map(([id]) => id);
}
function directIds(decisions) {
  return [...decisions.entries()]
    .filter(([, decision]) => decision.visibilityReason !== 'cwd_allocated'
      && decision.visibilityReason !== 'recent_active_fallback'
      && decision.visibilityReason !== 'hidden_stale')
    .map(([id]) => id);
}

console.log(`Compiled opencode-liveness.ts. RECENT_ACTIVE_FALLBACK_MS=${RECENT_ACTIVE_FALLBACK_MS}`);
console.log(`Log file: ${logPath}\n`);

console.log('--- deterministic liveness regressions ---');
assertEqual(hasOpenCodeStatusLiveness('busy'), true, 'busy status is direct liveness');
assertEqual(hasOpenCodeStatusLiveness('retry'), true, 'retry status is direct liveness');
assertEqual(hasOpenCodeStatusLiveness('idle'), false, 'idle status is not direct liveness');

let decisions = allocateOpenCodeLiveness([
  candidate('a-old-error', { offset: 500_000 }),
  candidate('a-new-idle', { offset: 100_000 }),
  candidate('a-newest-working', { offset: 10_000 }),
], { '/repo/a': 1 }, NOW);
assertEqual(cwdAllocated(decisions), ['a-newest-working'], 'newest same-directory session receives cwd allocation');
assertEqual(decisions.get('a-old-error').visibilityReason, 'hidden_stale', 'stale same-directory error session is hidden');
assertEqual(decisions.get('a-new-idle').visibilityReason, 'hidden_stale', 'stale same-directory idle session is hidden');

decisions = allocateOpenCodeLiveness([
  candidate('a-old-direct', { offset: 900_000, hasProcessSessionId: true }),
  candidate('a-newest', { offset: 1_000 }),
  candidate('a-middle', { offset: 2_000 }),
], { '/repo/a': 1 }, NOW);
assertEqual(directIds(decisions), ['a-old-direct'], 'direct process session signal remains visible regardless of age');
assertEqual(cwdAllocated(decisions), ['a-newest'], 'cwd allocation still prefers newest non-direct session');

decisions = allocateOpenCodeLiveness([
  candidate('a-parent', { offset: 1_000, parentId: 'parent-session' }),
  candidate('a-root', { offset: 2_000 }),
], { '/repo/a': 1 }, NOW);
assertEqual(cwdAllocated(decisions), ['a-root'], 'cwd allocation skips child/subagent sessions');

decisions = allocateOpenCodeLiveness([
  candidate('a-path-only-stale', { offset: 900_000 }),
], {}, NOW);
assertEqual(
  decisions.get('a-path-only-stale').visibilityReason,
  'hidden_stale',
  '/path-only directory diagnostics do not allocate liveness',
);

console.log('\n--- allocation property sweep ---');
function makePrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function sampleInt(rand, maxExclusive) {
  return Math.floor(rand() * maxExclusive);
}
function hasDirectSignal(candidate) {
  return candidate.hasBlockingRequest
    || candidate.hasActiveTool
    || candidate.hasProcessSessionId
    || candidate.hasStatusSignal;
}
function ranksBefore(left, right) {
  const activityDiff = left.lastActivity.getTime() - right.lastActivity.getTime();
  if (activityDiff !== 0) return activityDiff > 0;
  return left.id.localeCompare(right.id) > 0;
}

const propertyFailures = [];
let propertyChecks = 0;
for (let seed = 1; seed <= 200; seed++) {
  const rand = makePrng(seed);
  const directories = ['/repo/a', '/repo/b', '/repo/c'];
  const candidates = [];
  const count = 1 + sampleInt(rand, 18);
  for (let i = 0; i < count; i++) {
    const directory = directories[sampleInt(rand, directories.length)];
    candidates.push(candidate(`${directory === '/repo/a' ? 'a' : directory === '/repo/b' ? 'b' : 'c'}-${seed}-${i}`, {
      directory,
      offset: 31_000 + sampleInt(rand, 900_000),
      parentId: rand() < 0.15 ? `parent-${i}` : null,
      hasStatusSignal: rand() < 0.12,
      hasBlockingRequest: rand() < 0.08,
      hasActiveTool: rand() < 0.10,
      hasProcessSessionId: rand() < 0.10,
    }));
  }
  const directoryAllocationCounts = Object.fromEntries(directories.map((directory) => [directory, sampleInt(rand, 4)]));
  const propertyDecisions = allocateOpenCodeLiveness(candidates, directoryAllocationCounts, NOW);
  const allocated = new Set([...propertyDecisions.entries()]
    .filter(([, decision]) => decision.visibilityReason === 'cwd_allocated')
    .map(([id]) => id));

  propertyChecks += 1;
  for (const direct of candidates.filter(hasDirectSignal)) {
    // A hasProcessSessionId candidate is legitimately suppressed when another
    // session in the same directory has hasStatusSignal (stale argv after /new).
    if (direct.hasProcessSessionId && !direct.hasStatusSignal && direct.directory) {
      const hasConflictingStatusSignal = candidates.some(
        (c) => c.id !== direct.id && c.directory === direct.directory && c.hasStatusSignal,
      );
      if (hasConflictingStatusSignal) continue;
    }
    if (propertyDecisions.get(direct.id)?.instanceAlive !== true) {
      propertyFailures.push({
        seed,
        id: direct.id,
        property: 'direct session signal remains live',
        decision: propertyDecisions.get(direct.id),
      });
    }
  }
  for (const directory of directories) {
    const eligible = candidates.filter((c) => c.directory === directory && !c.parentId && !hasDirectSignal(c));
    const allocatedInDirectory = eligible.filter((c) => allocated.has(c.id));
    const expectedAllocationLimit = Math.min(directoryAllocationCounts[directory], eligible.length);
    propertyChecks += 1;
    if (allocatedInDirectory.length > directoryAllocationCounts[directory]) {
      propertyFailures.push({
        seed,
        directory,
        property: 'cwd allocations do not exceed observed process count',
        processCount: directoryAllocationCounts[directory],
        allocatedInDirectory: allocatedInDirectory.map((c) => c.id),
      });
    }
    propertyChecks += 1;
    if (allocatedInDirectory.length !== expectedAllocationLimit) {
      propertyFailures.push({
        seed,
        directory,
        property: 'cwd allocation fills available non-direct capacity',
        expectedAllocationLimit,
        allocatedInDirectory: allocatedInDirectory.map((c) => c.id),
      });
    }
    for (const allocatedCandidate of allocatedInDirectory) {
      propertyChecks += 1;
      const skippedNewer = eligible.find((other) => ranksBefore(other, allocatedCandidate) && !allocated.has(other.id));
      if (skippedNewer) {
        propertyFailures.push({
          seed,
          directory,
          property: 'cwd allocation prefers newest eligible sessions',
          allocated: allocatedCandidate.id,
          skippedNewer: skippedNewer.id,
        });
      }
    }
  }
}
assert(
  propertyFailures.length === 0,
  `allocation properties passed for ${propertyChecks} generated checks`,
  propertyFailures.slice(0, 5),
);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);

rmSync(OUT_DIR, { recursive: true, force: true });
logStream.end();
process.exit(failed === 0 ? 0 : 1);
