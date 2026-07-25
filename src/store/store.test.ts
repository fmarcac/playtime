import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolvePaths } from './paths.js';
import type { Paths } from './paths.js';
import { appendJsonl, parseJsonl, readJsonl, toJsonl, writeAtomic } from './jsonl.js';
import { appendEnvelope, drainInbox } from './inbox.js';
import { appendSessions, readSessions } from './sessions.js';
import { readLive, writeLive } from './live.js';
import type { LiveSnapshot } from './live.js';
import { acquireLock, readLock } from './lock.js';
import type { Envelope } from '../core/events.js';
import type { SessionRecord } from '../core/session.js';

async function withTempHome(body: (paths: Paths) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'playtime-test-'));
  try {
    const paths = resolvePaths({ PLAYTIME_HOME: home });
    await mkdir(dirname(paths.inbox), { recursive: true });
    await body(paths);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function envelope(hook: string, ts: number): Envelope {
  return { v: 1, ts, harness: 'claude-code', hook, pid: 42, payload: { session_id: 'sess_1' } };
}

function record(id: string, from: number, to: number): SessionRecord {
  return {
    id,
    harness: 'claude-code',
    project: '/home/dev/git/playtime',
    start: from,
    end: to,
    open: [[from, to]],
    busy: [],
    blocked: [],
    turns: 1,
  };
}

const EMPTY_TOTALS = {
  open: 0,
  busy: 0,
  blocked: 0,
  sessionTime: 0,
  sessions: 0,
  turns: 0,
};

test('PLAYTIME_HOME overrides every other location', () => {
  const paths = resolvePaths({ PLAYTIME_HOME: '/custom/spot' });

  assert.equal(paths.home, '/custom/spot');
  assert.equal(paths.sessions, '/custom/spot/sessions.jsonl');
  assert.equal(paths.inbox, '/custom/spot/inbox/events.jsonl');
});

test('the XDG data directory is used when PLAYTIME_HOME is unset', () => {
  const paths = resolvePaths({ XDG_DATA_HOME: '/xdg' });

  assert.equal(paths.home, '/xdg/playtime');
});

test('parseJsonl skips corrupt lines and counts them', () => {
  const result = parseJsonl<{ a: number }>('{"a":1}\nnot json\n{"a":2}\n');

  assert.deepEqual(result.items, [{ a: 1 }, { a: 2 }]);
  assert.equal(result.corrupt, 1);
});

test('parseJsonl ignores blank lines without counting them as corrupt', () => {
  const result = parseJsonl<{ a: number }>('{"a":1}\n\n   \n{"a":2}\n');

  assert.equal(result.items.length, 2);
  assert.equal(result.corrupt, 0);
});

test('parseJsonl handles a file with no trailing newline', () => {
  assert.equal(parseJsonl<{ a: number }>('{"a":1}').items.length, 1);
});

test('toJsonl emits one line per item, newline terminated', () => {
  assert.equal(toJsonl([{ a: 1 }, { a: 2 }]), '{"a":1}\n{"a":2}\n');
});

test('toJsonl of nothing is the empty string, so appends stay no-ops', () => {
  assert.equal(toJsonl([]), '');
});

test('reading a file that does not exist yields nothing rather than throwing', async () => {
  await withTempHome(async (paths) => {
    const result = await readJsonl(join(paths.home, 'absent.jsonl'));

    assert.deepEqual(result.items, []);
    assert.equal(result.corrupt, 0);
  });
});

test('appends accumulate across calls', async () => {
  await withTempHome(async (paths) => {
    const file = join(paths.home, 'log.jsonl');
    await appendJsonl(file, [{ a: 1 }]);
    await appendJsonl(file, [{ a: 2 }, { a: 3 }]);

    const result = await readJsonl<{ a: number }>(file);

    assert.deepEqual(
      result.items.map((item) => item.a),
      [1, 2, 3],
    );
  });
});

test('appending creates missing parent directories', async () => {
  await withTempHome(async (paths) => {
    const file = join(paths.home, 'deep', 'nested', 'log.jsonl');
    await appendJsonl(file, [{ a: 1 }]);

    assert.equal((await readJsonl(file)).items.length, 1);
  });
});

test('writeAtomic leaves no temporary file behind', async () => {
  await withTempHome(async (paths) => {
    const file = join(paths.home, 'snapshot.json');
    await writeAtomic(file, '{"ok":true}');

    assert.equal(await readFile(file, 'utf8'), '{"ok":true}');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(paths.home);
    assert.deepEqual(entries.filter((name) => name.includes('.tmp')), []);
  });
});

test('draining the inbox returns everything and clears it', async () => {
  await withTempHome(async (paths) => {
    await appendEnvelope(paths, envelope('SessionStart', 1000));
    await appendEnvelope(paths, envelope('Stop', 2000));

    const first = await drainInbox(paths);
    const second = await drainInbox(paths);

    assert.equal(first.items.length, 2);
    assert.equal(first.items[0]?.hook, 'SessionStart');
    assert.equal(second.items.length, 0);
  });
});

test('draining an inbox that was never created is not an error', async () => {
  await withTempHome(async (paths) => {
    const result = await drainInbox(paths);

    assert.deepEqual(result.items, []);
  });
});

test('a corrupt inbox line does not lose the good lines around it', async () => {
  await withTempHome(async (paths) => {
    await appendEnvelope(paths, envelope('SessionStart', 1000));
    await writeFile(paths.inbox, 'truncated {\n', { flag: 'a' });
    await appendEnvelope(paths, envelope('Stop', 2000));

    const result = await drainInbox(paths);

    assert.equal(result.items.length, 2);
    assert.equal(result.corrupt, 1);
  });
});

test('events appended while a drain is in flight survive into the next drain', async () => {
  await withTempHome(async (paths) => {
    await appendEnvelope(paths, envelope('SessionStart', 1000));

    const draining = drainInbox(paths);
    await appendEnvelope(paths, envelope('Stop', 2000));
    const first = await draining;
    const second = await drainInbox(paths);

    assert.equal(first.items.length + second.items.length, 2);
  });
});

test('session records round trip through storage', async () => {
  await withTempHome(async (paths) => {
    await appendSessions(paths, [record('a', 1000, 2000)]);
    await appendSessions(paths, [record('b', 3000, 4000)]);

    const result = await readSessions(paths);

    assert.deepEqual(
      result.items.map((item) => item.id),
      ['a', 'b'],
    );
    assert.deepEqual(result.items[0]?.open, [[1000, 2000]]);
  });
});

test('the live snapshot round trips', async () => {
  await withTempHome(async (paths) => {
    const snapshot: LiveSnapshot = {
      v: 1,
      updatedAt: 5000,
      daemonPid: 99,
      tracking: [
        {
          id: 'sess_1',
          harness: 'claude-code',
          project: '/home/dev/git/playtime',
          pid: 42,
          pidStart: 7,
          startedAt: 1000,
          lastAlive: 5000,
          open: [[1000, 5000]],
          busy: [[1500, 2500]],
          blocked: [],
          openTurnAt: null,
          openBlockAt: null,
          turns: 3,
          ended: false,
        },
      ],
      sessions: [
        {
          id: 'sess_1',
          harness: 'claude-code',
          project: '/home/dev/git/playtime',
          startedAt: 1000,
          open: 4000,
          busy: 1000,
          busyNow: true,
        },
      ],
      today: { ...EMPTY_TOTALS, open: 4000 },
      week: { ...EMPTY_TOTALS },
      allTime: { ...EMPTY_TOTALS },
    };

    await writeLive(paths, snapshot);

    assert.deepEqual(await readLive(paths), snapshot);
  });
});

test('a missing live snapshot reads as null', async () => {
  await withTempHome(async (paths) => {
    assert.equal(await readLive(paths), null);
  });
});

test('a corrupt live snapshot reads as null rather than throwing', async () => {
  await withTempHome(async (paths) => {
    await writeFile(paths.live, '{ this is not json');

    assert.equal(await readLive(paths), null);
  });
});

test('the daemon lock admits only one holder', async () => {
  await withTempHome(async (paths) => {
    const alive = () => true;
    const first = await acquireLock(paths, { pid: 1, startedAt: 100 }, alive);
    const second = await acquireLock(paths, { pid: 2, startedAt: 200 }, alive);

    assert.ok(first);
    assert.equal(second, null);
    assert.deepEqual(await readLock(paths), { pid: 1, startedAt: 100 });
  });
});

test('a lock left behind by a killed daemon is reclaimed', async () => {
  await withTempHome(async (paths) => {
    const first = await acquireLock(paths, { pid: 1, startedAt: 100 }, () => true);
    assert.ok(first);

    const second = await acquireLock(paths, { pid: 2, startedAt: 200 }, (pid) => pid !== 1);

    assert.ok(second);
    assert.deepEqual(await readLock(paths), { pid: 2, startedAt: 200 });
  });
});

test('releasing the lock lets the next daemon take it', async () => {
  await withTempHome(async (paths) => {
    const first = await acquireLock(paths, { pid: 1, startedAt: 100 }, () => true);
    await first?.release();

    const second = await acquireLock(paths, { pid: 2, startedAt: 200 }, () => true);

    assert.ok(second);
  });
});

test('concurrent daemons produce exactly one lock holder', async () => {
  await withTempHome(async (paths) => {
    const contenders = Array.from({ length: 8 }, (_, index) =>
      acquireLock(paths, { pid: index + 1, startedAt: index }, () => true),
    );

    const winners = (await Promise.all(contenders)).filter(Boolean);

    assert.equal(winners.length, 1);
  });
});

test('a lock file is never visible before it has been written', async () => {
  await withTempHome(async (paths) => {
    // Whoever loses the race must read complete contents, never an empty file,
    // otherwise it would mistake a lock being taken for a corrupt one and steal it.
    const [, holder] = await Promise.all([
      acquireLock(paths, { pid: 1, startedAt: 100 }, () => true),
      readLock(paths),
    ]);

    assert.ok(holder === null || typeof holder.pid === 'number');
    assert.deepEqual(await readLock(paths), { pid: 1, startedAt: 100 });
  });
});

test('releasing a lock that another daemon has since taken leaves theirs alone', async () => {
  await withTempHome(async (paths) => {
    const first = await acquireLock(paths, { pid: 1, startedAt: 100 }, () => true);
    const second = await acquireLock(paths, { pid: 2, startedAt: 200 }, (pid) => pid !== 1);

    await first?.release();

    assert.deepEqual(await readLock(paths), { pid: 2, startedAt: 200 });
    assert.ok(second);
  });
});

test('a lock file corrupted on disk does not wedge the daemon out forever', async () => {
  await withTempHome(async (paths) => {
    await writeFile(paths.lock, 'garbage');

    const handle = await acquireLock(paths, { pid: 7, startedAt: 700 }, () => true);

    assert.ok(handle);
  });
});
