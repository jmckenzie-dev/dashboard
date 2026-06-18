import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync('logs', { recursive: true });

const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const logStream = createWriteStream(join('logs', `property_test_agents_api_${timestamp}.log`), { flags: 'a' });
const write = (level, args) => {
  const line = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)).join(' ');
  logStream.write(`${line}\n`);
  globalThis.console[level](...args);
};

const originalConsole = { log: console.log, error: console.error };
globalThis.console.log = (...args) => {
  const line = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)).join(' ');
  logStream.write(`${line}\n`);
  originalConsole.log(...args);
};
globalThis.console.error = (...args) => {
  const line = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)).join(' ');
  logStream.write(`${line}\n`);
  originalConsole.error(...args);
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertValidTimestamp(value, label) {
  assert(typeof value === 'string', `${label} must be an ISO string`);
  const parsed = Date.parse(value);
  assert(Number.isFinite(parsed), `${label} must parse as a date`);
  return parsed;
}

async function main() {
  const url = process.env.DASHBOARD_AGENTS_URL || 'http://127.0.0.1:35001/api/agents';
  console.log(`Checking dashboard agent API invariants at ${url}`);

  const response = await fetch(url);
  assert(response.ok, `Expected ${url} to return 2xx, got ${response.status}`);

  const payload = await response.json();
  assert(Array.isArray(payload.sessions), 'payload.sessions must be an array');
  assert(payload.counts && typeof payload.counts === 'object', 'payload.counts must be an object');
  assertValidTimestamp(payload.timestamp, 'payload.timestamp');

  const statuses = [
    'working', 'blocked', 'blocked_permission', 'blocked_question',
    'blocked_review', 'complete', 'idle', 'retry'
  ];
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
  const now = Date.now();

  for (const session of payload.sessions) {
    assert(typeof session.id === 'string' && session.id.length > 0, 'session.id must be non-empty');
    assert(['opencode', 'claude', 'codex', 'gemini'].includes(session.type), `${session.id} has invalid type`);
    assert(statuses.includes(session.status), `${session.id} has invalid status`);
    assert(typeof session.name === 'string', `${session.id} must have a name`);
    assert(Array.isArray(session.messages), `${session.id} messages must be an array`);

    const updated = assertValidTimestamp(session.lastActivity, `${session.id}.lastActivity`);
    assert(updated <= now + 5 * 60 * 1000, `${session.id} lastActivity is unexpectedly far in the future`);

    if (session.type === 'opencode') {
      assert(session.id.startsWith('opencode-ses_'), `${session.id} must use the OpenCode session prefix`);
      assert(typeof session.directory === 'string' && session.directory.length > 0, `${session.id} must include a directory`);
      assert(typeof session.canSendInput === 'boolean', `${session.id} canSendInput must be boolean`);
    }

    for (const message of session.messages) {
      assert(typeof message.id === 'string' && message.id.length > 0, `${session.id} has a message without id`);
      assert(['user', 'assistant', 'system'].includes(message.role), `${session.id} has invalid message role`);
      assert(typeof message.content === 'string', `${session.id} has non-string message content`);
      assertValidTimestamp(message.timestamp, `${session.id}.${message.id}.timestamp`);
    }

    counts[session.status] += 1;
  }

  for (const status of statuses) {
    assert(payload.counts[status] === counts[status], `count mismatch for ${status}`);
  }

  console.log(JSON.stringify({ sessions: payload.sessions.length, counts }, null, 2));
}

main()
  .then(() => {
    console.log('Property-style dashboard API invariant check passed.');
    logStream.end();
  })
  .catch((error) => {
    console.error('Property-style dashboard API invariant check failed:', error);
    logStream.end(() => process.exit(1));
  });
