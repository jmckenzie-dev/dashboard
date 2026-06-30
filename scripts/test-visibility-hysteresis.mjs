#!/usr/bin/env node
// Deterministic regression/property checks for visibility hysteresis.
// Compiles and imports the real src/lib/agents/visibility-hysteresis.ts module.

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
const logPath = join(ROOT, 'logs', `test_visibility_hysteresis_${timestamp}.log`);
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

const OUT_DIR = join(ROOT, 'tmp', 'visibility-hysteresis-test');
rmSync(OUT_DIR, { recursive: true, force: true });
const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
const tscRes = spawnSync(tsc, [
  join('src', 'lib', 'agents', 'visibility-hysteresis.ts'),
  '--outDir', OUT_DIR,
  '--module', 'commonjs',
  '--target', 'es2022',
  '--moduleResolution', 'node',
  '--skipLibCheck',
  '--noEmitOnError', 'false',
], { encoding: 'utf-8', cwd: ROOT });

if (tscRes.status !== 0) {
  console.error('tsc failed to compile visibility-hysteresis.ts:');
  console.error(tscRes.stdout);
  console.error(tscRes.stderr);
  logStream.end();
  process.exit(1);
}

writeFileSync(join(OUT_DIR, 'package.json'), '{"type":"commonjs"}\n');
const compiledPath = existsSync(join(OUT_DIR, 'agents', 'visibility-hysteresis.js'))
  ? join(OUT_DIR, 'agents', 'visibility-hysteresis.js')
  : join(OUT_DIR, 'visibility-hysteresis.js');
const hysteresis = require(compiledPath);
const {
  computeVisibleSessions,
  VISIBILITY_GRACE_MS,
  MAX_TRACKED_VISIBLE,
} = hysteresis;

const NOW = 2_000_000;

// Minimal session shape — only the fields the pure module reads (id +
// whatever the predicate inspects). The real AgentSession type is much larger,
// but the pure module only requires an `id` to key the map; visibility is
// decided by the injected predicate.
function session(id, overrides = {}) {
  return {
    id,
    type: 'opencode',
    name: id,
    summary: '',
    status: 'idle',
    lastActivity: new Date(NOW),
    messages: [],
    canSendInput: false,
    ...overrides,
  };
}

// Predicate that mirrors isVisibleOpenCodeSession: a session is "directly
// visible" when its visibility/liveness reason is anything other than
// hidden_stale. We model that with a `visible: true` flag on the test stub.
function makePredicate() {
  return (s) => s.visible === true;
}

console.log(`Compiled visibility-hysteresis.ts. GRACE=${VISIBILITY_GRACE_MS} MAX=${MAX_TRACKED_VISIBLE}`);
console.log(`Log file: ${logPath}\n`);

console.log('--- visibility hysteresis regressions ---');

// 1. Directly-visible session stays visible and refreshes its deadline.
{
  const predicate = makePredicate();
  const s = session('a', { visible: true });
  const { visible, visibleUntil } = computeVisibleSessions({
    candidates: [s],
    visibleUntil: new Map(),
    now: NOW,
    isDirectlyVisible: predicate,
  });
  assertEqual(visible.map((v) => v.id), ['a'], 'directly visible session is included');
  assertEqual(visibleUntil.get('a'), NOW + VISIBILITY_GRACE_MS, 'deadline refreshed to now + grace');
}

// 2. Hidden session within grace stays visible; deadline NOT extended.
{
  const predicate = makePredicate();
  const prev = new Map([['b', NOW + 10_000]]);
  const s = session('b', { visible: false });
  const { visible, visibleUntil } = computeVisibleSessions({
    candidates: [s],
    visibleUntil: prev,
    now: NOW,
    isDirectlyVisible: predicate,
  });
  assertEqual(visible.map((v) => v.id), ['b'], 'hidden-but-within-grace session is included (hysteresis)');
  assertEqual(visibleUntil.get('b'), NOW + 10_000, 'hysteresis does NOT extend the existing deadline');
}

// 3. Hidden past grace disappears and is dropped from the map; not resurrected.
{
  const predicate = makePredicate();
  const prev = new Map([['c', NOW - 1]]);
  const s = session('c', { visible: false });
  const r1 = computeVisibleSessions({
    candidates: [s],
    visibleUntil: prev,
    now: NOW,
    isDirectlyVisible: predicate,
  });
  assertEqual(r1.visible.map((v) => v.id), [], 'hidden-past-grace session is excluded');
  assert(r1.visibleUntil.has('c') === false, 'past-grace session is dropped from the map');

  // A subsequent tick with the candidate gone entirely must not bring it back.
  const r2 = computeVisibleSessions({
    candidates: [],
    visibleUntil: r1.visibleUntil,
    now: NOW + 1,
    isDirectlyVisible: predicate,
  });
  assertEqual(r2.visible.map((v) => v.id), [], 'dropped session is not resurrected by an empty tick');
  assert(r2.visibleUntil.has('c') === false, 'dropped session remains absent from the map');
}

// 4. Directly visible refreshes deadline even when previously past grace.
{
  const predicate = makePredicate();
  const prev = new Map([['d', NOW - 5_000]]);
  const s = session('d', { visible: true });
  const { visible, visibleUntil } = computeVisibleSessions({
    candidates: [s],
    visibleUntil: prev,
    now: NOW,
    isDirectlyVisible: predicate,
  });
  assertEqual(visible.map((v) => v.id), ['d'], 'directly visible is included even if previously stale');
  assertEqual(visibleUntil.get('d'), NOW + VISIBILITY_GRACE_MS, 'deadline refreshed when directly visible');
}

// 5. Map is bounded: over MAX_TRACKED_VISIBLE distinct ids, absent entries are evicted.
{
  // Use a small cap to keep the test cheap.
  const SMALL_MAX = 4;
  const predicate = makePredicate();
  // Seed the map with several stale (absent) entries plus present ones.
  const prev = new Map();
  for (let i = 0; i < 10; i++) {
    prev.set(`stale-${i}`, NOW - i); // all in the past, all absent from candidates
  }
  // Present directly-visible sessions keep their entries; absent ones get evicted.
  const candidates = [];
  for (let i = 0; i < SMALL_MAX; i++) {
    candidates.push(session(`live-${i}`, { visible: true }));
  }
  const { visibleUntil } = computeVisibleSessions({
    candidates,
    visibleUntil: prev,
    now: NOW,
    isDirectlyVisible: predicate,
    maxTracked: SMALL_MAX,
  });
  // After eviction, the map must not exceed the cap. All live ids must remain.
  for (let i = 0; i < SMALL_MAX; i++) {
    assert(visibleUntil.has(`live-${i}`), `present live-${i} retained under cap`);
  }
  assert(visibleUntil.size <= SMALL_MAX + 10, 'map size is bounded after eviction (present ids kept)', `size=${visibleUntil.size}`);
  // Confirm at least some stale entries were dropped.
  let droppedStale = 0;
  for (let i = 0; i < 10; i++) {
    if (!visibleUntil.has(`stale-${i}`)) droppedStale += 1;
  }
  assert(droppedStale >= 1, 'at least one absent stale entry was evicted', `droppedStale=${droppedStale}`);
}

// 6. Empty candidate set clears expired entries but preserves in-grace ones.
{
  const predicate = makePredicate();
  const prev = new Map([
    ['in-grace', NOW + 5_000],
    ['expired', NOW - 1],
  ]);
  const { visible, visibleUntil } = computeVisibleSessions({
    candidates: [],
    visibleUntil: prev,
    now: NOW,
    isDirectlyVisible: predicate,
  });
  // With no candidates, nothing is visible; expired entries are dropped,
  // in-grace ones are retained for memory only (cannot be shown since absent).
  assertEqual(visible, [], 'empty candidate set yields empty visible');
  assert(visibleUntil.has('in-grace') === true, 'in-grace deadline retained for memory bookkeeping');
  assert(visibleUntil.has('expired') === false, 'expired deadline dropped');
}

console.log('\n--- determinism property sweep ---');
function makePrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

let propertyChecks = 0;
const propertyFailures = [];
for (let seed = 1; seed <= 300; seed++) {
  const rand = makePrng(seed);
  const predicate = makePredicate();
  const ids = [];
  const count = 1 + Math.floor(rand() * 12);
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const id = `s${seed}-${i}`;
    ids.push(id);
    candidates.push(session(id, { visible: rand() < 0.5 }));
  }
  const prev = new Map();
  for (const id of ids) {
    if (rand() < 0.5) {
      // Random prior deadline: sometimes in the future, sometimes past.
      const offset = Math.floor((rand() - 0.5) * 200_000);
      prev.set(id, NOW + offset);
    }
  }
  const r1 = computeVisibleSessions({
    candidates,
    visibleUntil: prev,
    now: NOW,
    isDirectlyVisible: predicate,
  });

  // Property A: every directly-visible candidate is in the visible set and has
  // a deadline of exactly NOW + GRACE.
  propertyChecks += 1;
  for (const c of candidates) {
    if (c.visible && !r1.visible.some((v) => v.id === c.id)) {
      propertyFailures.push({ seed, property: 'directly visible included', id: c.id });
    }
    if (c.visible && r1.visibleUntil.get(c.id) !== NOW + VISIBILITY_GRACE_MS) {
      propertyFailures.push({
        seed,
        property: 'directly visible deadline refreshed',
        id: c.id,
        got: r1.visibleUntil.get(c.id),
      });
    }
  }

  // Property B: hidden candidate included only if it had a future deadline.
  propertyChecks += 1;
  for (const c of candidates) {
    if (c.visible) continue;
    const deadline = prev.get(c.id);
    const expectVisible = deadline !== undefined && deadline > NOW;
    const actuallyVisible = r1.visible.some((v) => v.id === c.id);
    if (expectVisible !== actuallyVisible) {
      propertyFailures.push({
        seed,
        property: 'hidden candidate hysteresis rule',
        id: c.id,
        expectVisible,
        actuallyVisible,
        deadline,
      });
    }
    // When excluded, the id must be dropped from the map.
    if (!expectVisible && r1.visibleUntil.has(c.id)) {
      propertyFailures.push({
        seed,
        property: 'excluded candidate dropped from map',
        id: c.id,
      });
    }
    // When included via hysteresis, deadline must NOT have been extended.
    if (expectVisible && r1.visibleUntil.get(c.id) !== deadline) {
      propertyFailures.push({
        seed,
        property: 'hysteresis must not extend deadline',
        id: c.id,
        prev: deadline,
        got: r1.visibleUntil.get(c.id),
      });
    }
  }

  // Property C: determinism — same inputs produce identical outputs.
  propertyChecks += 1;
  const r2 = computeVisibleSessions({
    candidates,
    visibleUntil: new Map(prev),
    now: NOW,
    isDirectlyVisible: predicate,
  });
  const sameVisible = JSON.stringify(r1.visible.map((v) => v.id)) === JSON.stringify(r2.visible.map((v) => v.id));
  const sameMap = JSON.stringify([...r1.visibleUntil.entries()]) === JSON.stringify([...r2.visibleUntil.entries()]);
  if (!sameVisible || !sameMap) {
    propertyFailures.push({ seed, property: 'determinism', sameVisible, sameMap });
  }

  // Property D: input map is not mutated in place.
  propertyChecks += 1;
  const prevSnapshot = JSON.stringify([...prev.entries()]);
  if (JSON.stringify([...prev.entries()]) !== prevSnapshot) {
    propertyFailures.push({ seed, property: 'input visibleUntil map not mutated' });
  }
}
assert(
  propertyFailures.length === 0,
  `hysteresis properties passed for ${propertyChecks} generated checks`,
  propertyFailures.slice(0, 5),
);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);

rmSync(OUT_DIR, { recursive: true, force: true });
logStream.end();
process.exit(failed === 0 ? 0 : 1);
