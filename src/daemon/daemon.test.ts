import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Daemon, DEFAULT_DAEMON_CONFIG } from './daemon.js';
import type { DaemonConfig } from './daemon.js';
import type { AliveProbe } from './tracker.js';
import { resolvePaths } from '../store/paths.js';
import type { Paths } from '../store/paths.js';
import { appendEnvelope } from '../store/inbox.js';
import { readSessions } from '../store/sessions.js';
import { readLive } from '../store/live.js';
import { total } from '../core/intervals.js';
import type { Envelope } from '../core/events.js';

const T0 = 1_753_440_000_000;
const SECOND = 1000;
const TICK = 15 * SECOND;

const CONFIG: DaemonConfig = { ...DEFAULT_DAEMON_CONFIG, tickMs: TICK, maxAdvanceMs: 2 * TICK };

const ALIVE: AliveProbe = () => true;
const DEAD: AliveProbe = () => false;

/** A clock the test drives by hand, so ticks never depend on real time. */
function fakeClock(start: number) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

async function withTempHome(body: (paths: Paths) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'playtime-daemon-'));
  try {
    const paths = resolvePaths({ PLAYTIME_HOME: home });
    await mkdir(dirname(paths.inbox), { recursive: true });
    await body(paths);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function envelope(hook: string, ts: number, sessionId = 'sess_1'): Envelope {
  return {
    v: 1,
    ts,
    harness: 'claude-code',
    hook,
    pid: 4242,
    pidStart: 99,
    payload: { session_id: sessionId, cwd: '/home/dev/git/playtime' },
  };
}

test('a tick with an empty inbox still writes a snapshot', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const daemon = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE, pid: 1 });

    await daemon.tick();

    const live = await readLive(paths);
    assert.equal(live?.updatedAt, T0);
    assert.deepEqual(live?.sessions, []);
    assert.equal(live?.daemonPid, 1);
  });
});

test('a session_start in the inbox becomes a tracked session', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const daemon = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });
    await appendEnvelope(paths, envelope('SessionStart', T0));

    await daemon.tick();

    assert.equal(daemon.trackedCount, 1);
    const live = await readLive(paths);
    assert.equal(live?.sessions[0]?.project, '/home/dev/git/playtime');
    assert.equal(live?.sessions[0]?.harness, 'claude-code');
  });
});

test('open time accrues across ticks and shows up in the snapshot', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const daemon = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });
    await appendEnvelope(paths, envelope('SessionStart', T0));
    await daemon.tick();

    clock.advance(TICK);
    await daemon.tick();
    clock.advance(TICK);
    await daemon.tick();

    const live = await readLive(paths);
    assert.equal(live?.sessions[0]?.open, 2 * TICK);
    assert.equal(live?.today.open, 2 * TICK);
  });
});

test('a session whose process dies is written to history', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    let probe: AliveProbe = ALIVE;
    const daemon = await Daemon.start(paths, CONFIG, {
      now: clock.now,
      isAlive: (pid, start) => probe(pid, start),
    });

    await appendEnvelope(paths, envelope('SessionStart', T0));
    await daemon.tick();
    clock.advance(TICK);
    await daemon.tick();

    probe = DEAD;
    clock.advance(TICK);
    const closed = await daemon.tick();

    assert.equal(closed.length, 1);
    assert.equal(daemon.trackedCount, 0);

    const stored = await readSessions(paths);
    assert.equal(stored.items.length, 1);
    assert.equal(total(stored.items[0]?.open ?? []), TICK);
  });
});

test('turn events recorded between ticks become busy time', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const daemon = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });

    await appendEnvelope(paths, envelope('SessionStart', T0));
    await appendEnvelope(paths, envelope('UserPromptSubmit', T0 + 2 * SECOND));
    await appendEnvelope(paths, envelope('Stop', T0 + 9 * SECOND));

    clock.advance(TICK);
    await daemon.tick();

    const live = await readLive(paths);
    assert.equal(live?.sessions[0]?.busy, 7 * SECOND);
    assert.equal(live?.today.busy, 7 * SECOND);
  });
});

test('history from earlier sessions is included in the totals', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    let probe: AliveProbe = ALIVE;
    const first = await Daemon.start(paths, CONFIG, {
      now: clock.now,
      isAlive: (pid, start) => probe(pid, start),
    });

    await appendEnvelope(paths, envelope('SessionStart', T0));
    await first.tick();
    clock.advance(TICK);
    await first.tick();
    probe = DEAD;
    clock.advance(TICK);
    await first.tick();

    const second = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });
    await second.tick();

    const live = await readLive(paths);
    assert.equal(live?.today.open, TICK);
    assert.equal(live?.allTime.open, TICK);
  });
});

test('a killed daemon does not take its in-flight sessions with it', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const doomed = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });
    await appendEnvelope(paths, envelope('SessionStart', T0));
    await doomed.tick();
    clock.advance(TICK);
    await doomed.tick();
    // No shutdown: this daemon is killed outright.

    const successor = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });

    assert.equal(successor.trackedCount, 1);

    clock.advance(TICK);
    await successor.tick();

    const live = await readLive(paths);
    assert.equal(live?.sessions[0]?.open, 2 * TICK);
  });
});

test('a session whose process died while no daemon ran is closed at its last confirmed moment', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const doomed = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });
    await appendEnvelope(paths, envelope('SessionStart', T0));
    await doomed.tick();
    clock.advance(TICK);
    await doomed.tick();

    // Hours pass with no daemon and the harness exits somewhere in there.
    clock.advance(4 * 60 * 60 * SECOND);
    const successor = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: DEAD });
    await successor.tick();

    const stored = await readSessions(paths);
    assert.equal(stored.items.length, 1);
    assert.equal(total(stored.items[0]?.open ?? []), TICK);
    assert.equal(successor.trackedCount, 0);
  });
});

test('the daemon asks to exit only after the idle timeout has passed', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const daemon = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });

    await daemon.tick();
    assert.equal(daemon.shouldExit, false);

    clock.advance(CONFIG.idleExitMs + SECOND);
    await daemon.tick();

    assert.equal(daemon.shouldExit, true);
  });
});

test('a busy daemon never asks to exit', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const daemon = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });
    await appendEnvelope(paths, envelope('SessionStart', T0));

    await daemon.tick();
    clock.advance(CONFIG.idleExitMs + SECOND);
    await daemon.tick();

    assert.equal(daemon.shouldExit, false);
  });
});

test('shutdown flushes sessions that were still open', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const daemon = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });
    await appendEnvelope(paths, envelope('SessionStart', T0));
    await daemon.tick();
    clock.advance(TICK);
    await daemon.tick();

    await daemon.shutdown();

    const stored = await readSessions(paths);
    assert.equal(stored.items.length, 1);
    assert.equal(total(stored.items[0]?.open ?? []), TICK);

    const live = await readLive(paths);
    assert.deepEqual(live?.tracking, []);
  });
});

test('a corrupt inbox line does not stop the surrounding events being tracked', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const daemon = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });

    await appendEnvelope(paths, envelope('SessionStart', T0));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(paths.inbox, 'not json at all\n', { flag: 'a' });
    await appendEnvelope(paths, envelope('UserPromptSubmit', T0 + SECOND));

    await daemon.tick();

    assert.equal(daemon.trackedCount, 1);
  });
});
