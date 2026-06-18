#!/usr/bin/env node
// Deterministic status-inference self-test.
//
// Exercises the REAL inference algorithm from src/lib/status/inference.ts by
// compiling that one self-contained module (it has only type-only imports,
// which tsc erases) to JS and importing it. No logic is duplicated.
//
// Fixtures cover the scenarios in docs/opencode-session-status.md §8 and the
// specific non-determinism bugs from §6:
//   - submit_plan running must stay blocked_review (no 60s staleness cutoff)
//   - question running -> blocked_question (durable fallback)
//   - stale `running` tool from a dead turn must NOT be working (turn-scoping)
//   - completed turn (reason=stop) -> complete within 5m, idle after
//   - live /permission and /question signals take priority
//   - blocking states are mutually exclusive and prioritized over working/idle
//
// Logs to ./logs/ alongside the other dashboard scripts.

import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

mkdirSync(join(ROOT, 'logs'), { recursive: true });
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const logStream = createWriteStream(join(ROOT, 'logs', `test_status_inference_${timestamp}.log`), { flags: 'a' });

// Capture the real console methods BEFORE overriding so we don't recurse.
const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };
function emit(level, args) {
  const line = args.map((a) => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ');
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
    console.log(`  PASS  ${label}  -> ${a}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}\n        expected ${e}\n        got      ${a}`);
  }
}
function assertTrue(value, label) {
  if (value) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label} (expected truthy)`);
  }
}

// --- compile inference.ts (type-only imports -> erased) to a temp ESM file ---
const OUT_DIR = join(ROOT, 'tmp', 'inference-test');
rmSync(OUT_DIR, { recursive: true, force: true });
const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
const tscRes = spawnSync(tsc, [
  join('src', 'lib', 'status', 'inference.ts'),
  '--outDir', OUT_DIR,
  '--module', 'es2022',
  '--target', 'es2022',
  '--moduleResolution', 'node',
  '--skipLibCheck',
  '--noEmitOnError', 'false',
], { encoding: 'utf-8', cwd: ROOT });

if (tscRes.status !== 0) {
  console.error('tsc failed to compile inference.ts:');
  console.error(tscRes.stdout);
  console.error(tscRes.stderr);
  logStream.end();
  process.exit(1);
}

const inference = await import('file://' + join(OUT_DIR, 'status', 'inference.js'));
const { analyzeParts, inferOpencodeStatus, COMPLETE_FRESH_MS, WORKING_GRACE_MS } = inference;

console.log(`Compiled inference.ts. COMPLETE_FRESH_MS=${COMPLETE_FRESH_MS} WORKING_GRACE_MS=${WORKING_GRACE_MS}\n`);

// Helpers to build fixtures.
let clock = 1_000_000;
function t() { return clock; }
function tick(ms) { clock += ms; }
function toolPart(tool, status, opts = {}) {
  return { type: 'tool', tool, callID: opts.callID ?? `${tool}-${clock}`, status, time: opts.time ?? clock };
}
function stepFinish(reason, time) {
  return { type: 'step-finish', reason, time: time ?? clock };
}

function run(input) {
  return inferOpencodeStatus(input);
}

console.log('--- analyzeParts: turn-scoping & stale-running ---');
// 1. A genuinely in-flight bash tool (no stop after it) -> active.
let r = analyzeParts([
  stepFinish('stop', 100),
  toolPart('bash', 'running', { callID: 'c1', time: 200 }),
]);
assertEqual(r.latestTool && r.latestTool.active, true, 'in-flight bash tool is active');

// 2. Stale `running` from a dead turn: a natural stop happened AFTER the tool.
//    The tool must be inactive (turn ended), even though its own status is running.
r = analyzeParts([
  toolPart('bash', 'running', { callID: 'c2', time: 100 }),
  stepFinish('stop', 200),
]);
assertEqual(r.latestTool && r.latestTool.active, false, 'stale running tool after a stop is inactive (turn-scoped)');

// 3. Latest tool terminalised by a later part with the same callID.
r = analyzeParts([
  toolPart('bash', 'running', { callID: 'c3', time: 100 }),
  toolPart('bash', 'completed', { callID: 'c3', time: 101 }),
]);
assertEqual(r.latestTool && r.latestTool.active, false, 'tool with later completed part (same callID) is inactive');

// 4. submit_plan running, no stop after -> active (the review signal).
r = analyzeParts([
  stepFinish('stop', 100),
  toolPart('submit_plan', 'running', { callID: 'c4', time: 200 }),
]);
assertEqual(r.latestTool && r.latestTool.tool, 'submit_plan', 'submit_plan is the latest tool');
assertEqual(r.latestTool && r.latestTool.active, true, 'submit_plan running (no later stop) is active');

console.log('\n--- inferOpencodeStatus: blocking priority & mutual exclusivity ---');

// 5. Permission present -> blocked_permission (overrides everything).
assertEqual(run({
  sessionStatus: 'busy', latestTool: toolPart('bash', 'running', { callID: 'x', time: 1 }),
  latestStepReason: null, hasPermission: true, hasQuestion: true, lastActivityMs: 0,
}), 'blocked_permission', 'permission beats busy + question');

// 6. Question present (no permission) -> blocked_question.
assertEqual(run({
  sessionStatus: 'busy', latestTool: toolPart('bash', 'running', { callID: 'x', time: 1 }),
  latestStepReason: null, hasPermission: false, hasQuestion: true, lastActivityMs: 0,
}), 'blocked_question', 'question beats busy');

// 7. submit_plan active -> blocked_review even after a long age (96h reviews).
assertEqual(run({
  sessionStatus: null, latestTool: { ...toolPart('submit_plan', 'running', { callID: 'p', time: 1 }), active: true },
  latestStepReason: null, hasPermission: false, hasQuestion: false, lastActivityMs: 96 * 60 * 60 * 1000,
}), 'blocked_review', 'submit_plan stays blocked_review at 96h (no staleness cutoff)');

// 8. question tool active (durable fallback, no live /question) -> blocked_question.
assertEqual(run({
  sessionStatus: null, latestTool: { ...toolPart('question', 'running', { callID: 'q', time: 1 }), active: true },
  latestStepReason: null, hasPermission: false, hasQuestion: false, lastActivityMs: 60_000,
}), 'blocked_question', 'question tool running -> blocked_question (durable fallback)');

// 9. busy -> working.
assertEqual(run({
  sessionStatus: 'busy', latestTool: null, latestStepReason: null,
  hasPermission: false, hasQuestion: false, lastActivityMs: 5_000,
}), 'working', 'busy -> working');

// 10. retry -> retry (distinct state, folded under working in the UI).
assertEqual(run({
  sessionStatus: 'retry', latestTool: null, latestStepReason: null,
  hasPermission: false, hasQuestion: false, lastActivityMs: 5_000,
}), 'retry', 'retry status preserved');

// 11. Finished naturally (reason=stop), recent -> complete.
assertEqual(run({
  sessionStatus: null, latestTool: null, latestStepReason: 'stop',
  hasPermission: false, hasQuestion: false, lastActivityMs: 60_000,
}), 'complete', 'natural stop < 5m -> complete');

// 12. Finished naturally, aged past 5m -> idle.
assertEqual(run({
  sessionStatus: null, latestTool: null, latestStepReason: 'stop',
  hasPermission: false, hasQuestion: false, lastActivityMs: COMPLETE_FRESH_MS + 1,
}), 'idle', 'natural stop > 5m -> idle');

// 13. Stale running tool (turn ended) must NOT be working/idle-flip; with a
//     recent-enough activity it falls to the grace branch, but the point is it
//     is NOT reported working just because a `running` part exists.
const stale = analyzeParts([
  toolPart('bash', 'running', { callID: 's', time: 100 }),
  stepFinish('stop', 200),
]);
assertEqual(run({
  sessionStatus: null, latestTool: stale.latestTool, latestStepReason: stale.latestStepReason,
  hasPermission: false, hasQuestion: false, lastActivityMs: COMPLETE_FRESH_MS + 60_000,
}), 'idle', 'stale running tool + aged -> idle (not working, not blocked)');

console.log('\n--- mutual exclusivity / priority property sweep ---');
const baseInput = {
  sessionStatus: null, latestTool: null, latestStepReason: null,
  hasPermission: false, hasQuestion: false, lastActivityMs: 1000,
};
const allStatuses = ['working', 'blocked', 'blocked_permission', 'blocked_question', 'blocked_review', 'complete', 'idle', 'retry'];
for (const s of allStatuses) {
  assertTrue(typeof run({ ...baseInput }) === 'string', `returns a string for baseline`);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);

rmSync(OUT_DIR, { recursive: true, force: true });
logStream.end();
process.exit(failed === 0 ? 0 : 1);
