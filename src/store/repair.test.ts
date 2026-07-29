import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRecord } from '../core/session.js';
import { resolvePaths } from './paths.js';
import type { Paths } from './paths.js';
import { carryOver, compact, repairSessions } from './repair.js';
import { readSessions } from './sessions.js';

async function withTempHome(body: (paths: Paths) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'playtime-repair-'));
  try {
    await body(resolvePaths({ PLAYTIME_HOME: home }));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function record(id: string, start: number, end: number): SessionRecord {
  return {
    id,
    harness: 'claude-code',
    project: '/home/dev/work/api',
    start,
    end,
    open: [[start, end]],
    busy: [],
    blocked: [],
    turns: 0,
  };
}

function lines(records: readonly SessionRecord[]): string {
  return `${records.map((item) => JSON.stringify(item)).join('\n')}\n`;
}

test('compaction keeps the last checkpoint of each session', () => {
  const text = lines([record('a', 100, 200), record('a', 100, 300), record('b', 400, 500)]);
  const result = compact(text);

  assert.equal(result.records.length, 2);
  assert.equal(result.superseded, 1);
  assert.equal(result.records[0]?.end, 300);
});

test('a session id reused by a later run stays its own session', () => {
  const result = compact(lines([record('a', 100, 200), record('a', 900, 950)]));

  assert.equal(result.records.length, 2);
  assert.equal(result.superseded, 0);
});

test('a line that is not json is counted as unreadable', () => {
  const result = compact(`${JSON.stringify(record('a', 1, 2))}\n{"id":"b","star\n`);

  assert.equal(result.records.length, 1);
  assert.equal(result.unreadable, 1);
});

test('json that is not a session record is unreadable too', () => {
  const result = compact('{"hello":"world"}\n');

  assert.equal(result.records.length, 0);
  assert.equal(result.unreadable, 1);
});

test('compaction sorts by when the session started', () => {
  const result = compact(lines([record('b', 900, 950), record('a', 100, 200)]));

  assert.deepEqual(
    result.records.map((item) => item.id),
    ['a', 'b'],
  );
});

test('repairing rewrites the file and keeps a backup', async () => {
  await withTempHome(async (paths) => {
    await writeFile(
      paths.sessions,
      `${lines([record('a', 100, 200), record('a', 100, 300)])}{"truncated\n`,
      'utf8',
    );

    const report = await repairSessions(paths);

    assert.equal(report.changed, true);
    assert.equal(report.kept, 1);
    assert.equal(report.unreadable, 1);
    assert.equal(report.superseded, 1);

    const after = await readSessions(paths);
    assert.equal(after.items.length, 1);
    assert.equal(after.corrupt, 0);
    assert.equal(after.items[0]?.end, 300);

    const backup = await readFile(report.backup ?? '', 'utf8');
    assert.match(backup, /truncated/);
  });
});

test('a clean file is left exactly as it was', async () => {
  await withTempHome(async (paths) => {
    const text = lines([record('a', 100, 200), record('b', 300, 400)]);
    await writeFile(paths.sessions, text, 'utf8');

    const report = await repairSessions(paths);

    assert.equal(report.changed, false);
    assert.equal(report.backup, null);
    assert.equal(await readFile(paths.sessions, 'utf8'), text);
  });
});

test('history that does not exist yet is not an error', async () => {
  await withTempHome(async (paths) => {
    const report = await repairSessions(paths);

    assert.equal(report.changed, false);
    assert.equal(report.kept, 0);
  });
});

test('anything appended mid-repair is carried across untouched', () => {
  const read = 'one\ntwo\n';

  assert.equal(carryOver(read, `${read}three\n`), 'three\n');
  assert.equal(carryOver(read, read), '');
  assert.equal(carryOver('', 'first\n'), 'first\n');
});

test('an append onto a truncated line is dropped with that line', () => {
  // The broken line belongs to the part being rewritten, so the append that
  // continued it cannot be kept either.
  assert.equal(carryOver('one\n{"half', 'one\n{"half{"whole":1}\n{"next":2}\n'), '{"next":2}\n');
  assert.equal(carryOver('one\n{"half', 'one\n{"half'), '');
});

test('a file whose start has changed underneath is refused', () => {
  assert.equal(carryOver('one\ntwo\n', 'different\n'), null);
});

test('a session appended before a repair survives it', async () => {
  await withTempHome(async (paths) => {
    await writeFile(paths.sessions, lines([record('a', 100, 200), record('a', 100, 300)]), 'utf8');
    await appendFile(paths.sessions, lines([record('c', 700, 800)]), 'utf8');

    await repairSessions(paths);

    const after = await readSessions(paths);
    assert.deepEqual(
      after.items.map((item) => item.id).sort(),
      ['a', 'c'],
    );
  });
});

test('a truncated last line does not glue itself to what came after', async () => {
  await withTempHome(async (paths) => {
    // Exactly what a failed write leaves: no newline, then the next append.
    await writeFile(paths.sessions, `${lines([record('a', 1, 2)])}{"id":"half`, 'utf8');
    await appendFile(paths.sessions, `${JSON.stringify(record('b', 5, 6))}\n`, 'utf8');

    await repairSessions(paths);

    const after = await readSessions(paths);
    assert.equal(after.corrupt, 0);
    assert.deepEqual(
      after.items.map((item) => item.id),
      ['a'],
    );
  });
});
