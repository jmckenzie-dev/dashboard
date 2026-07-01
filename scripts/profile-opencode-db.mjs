#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const root = join(import.meta.dirname, '..');
const logs = join(root, 'logs');
mkdirSync(logs, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const logPath = join(logs, `profile_opencode_db_${stamp}.log`);
const out = createWriteStream(logPath, { flags: 'a' });

function log(...args) {
  const line = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)).join(' ');
  console.log(line);
  out.write(`${line}\n`);
}

const dbPath = process.argv[2] || join(homedir(), '.local/share/opencode/opencode.db');
if (!existsSync(dbPath)) {
  log(`DB not found: ${dbPath}`);
  process.exitCode = 1;
  out.end();
  process.exit();
}

function time(label, fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  log(`${label}: ${elapsedMs.toFixed(2)}ms`);
  return result;
}

log(`Logging to ${logPath}`);
log(`DB: ${dbPath}`);

const writable = new Database(dbPath, { fileMustExist: true, timeout: 10000 });
time('create dashboard indexes', () => writable.exec(`
  CREATE INDEX IF NOT EXISTS dashboard_session_root_activity_idx
  ON session (
    COALESCE(time_updated, time_created) DESC,
    time_created DESC,
    id DESC
  )
  WHERE time_archived IS NULL AND parent_id IS NULL;

  CREATE INDEX IF NOT EXISTS dashboard_part_session_activity_idx
  ON part (
    session_id,
    COALESCE(time_updated, time_created) DESC,
    time_created DESC,
    id DESC
  );
`));
writable.close();

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
log('sqlite_version', db.prepare('select sqlite_version() as v').get());
log('tables', db.prepare("select name from sqlite_master where type='table' order by name").all());
log('part indexes', db.prepare("pragma index_list('part')").all());
log('session indexes', db.prepare("pragma index_list('session')").all());
log('counts', {
  sessions: db.prepare('select count(*) as c from session').get().c,
  rootSessions: db.prepare('select count(*) as c from session where time_archived is null and parent_id is null').get().c,
  parts: db.prepare('select count(*) as c from part').get().c,
});

const sessionQuery = `
  SELECT id, project_id, parent_id, directory, title, time_created, time_updated
  FROM session
  WHERE time_archived IS NULL AND parent_id IS NULL
  ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
  LIMIT 200
`;

const partsWindowQuery = `
  WITH ranked_parts AS (
    SELECT id, session_id, message_id, time_created, time_updated, data,
           ROW_NUMBER() OVER (
             PARTITION BY session_id
             ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
           ) as rn
    FROM part
    WHERE session_id IN (
      SELECT id FROM session WHERE time_archived IS NULL AND parent_id IS NULL
      ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
      LIMIT 200
    )
  )
  SELECT id, session_id, message_id, time_created, time_updated, data
  FROM ranked_parts
  WHERE rn <= 80
  ORDER BY session_id, rn ASC
`;

log('session plan', db.prepare(`EXPLAIN QUERY PLAN ${sessionQuery}`).all());
log('parts window plan', db.prepare(`EXPLAIN QUERY PLAN ${partsWindowQuery}`).all());

const sessions = time('session query', () => db.prepare(sessionQuery).all());
log('sessions returned', sessions.length);
const allParts = time('window parts query', () => db.prepare(partsWindowQuery).all());
log('parts returned', allParts.length);

const scanIds = sessions.slice(0, 40).map((s) => s.id);
const limitedWindowQuery = `
  WITH ranked_parts AS (
    SELECT id, session_id, message_id, time_created, time_updated, data,
           ROW_NUMBER() OVER (
             PARTITION BY session_id
             ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
           ) as rn
    FROM part
    WHERE session_id IN (${scanIds.map(() => '?').join(',')})
  )
  SELECT id, session_id, message_id, time_created, time_updated, data
  FROM ranked_parts
  WHERE rn <= 80
  ORDER BY session_id, rn ASC
`;
log('limited parts plan', db.prepare(`EXPLAIN QUERY PLAN ${limitedWindowQuery}`).all(...scanIds));
const limitedParts = time('limited window parts query', () => db.prepare(limitedWindowQuery).all(...scanIds));
log('limited parts returned', limitedParts.length);

const ids = sessions.map((s) => s.id);
const perSession = db.transaction((sessionIds) => {
  const stmt = db.prepare(`
    SELECT id, session_id, message_id, time_created, time_updated, data
    FROM part
    WHERE session_id = ?
    ORDER BY COALESCE(time_updated, time_created) DESC, time_created DESC, id DESC
    LIMIT 80
  `);
  const rows = [];
  for (const id of sessionIds) rows.push(...stmt.all(id));
  return rows;
});
const perRows = time('per-session parts queries', () => perSession(ids));
log('per-session parts returned', perRows.length);

db.close();
out.end();
