import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { configFromEnv, Daemon, DEFAULT_DAEMON_CONFIG, runDaemon } from './daemon.js';
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
    payload: { session_id: sessionId, cwd: '/home/dev/work/api' },
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
    assert.equal(live?.sessions[0]?.project, '/home/dev/work/api');
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

test('an empty environment gives the default cadence', () => {
  assert.deepEqual(configFromEnv({}), DEFAULT_DAEMON_CONFIG);
});

test('shortening the tick tightens the interpolation clamp with it', () => {
  const config = configFromEnv({ PLAYTIME_TICK_MS: '1000' });

  assert.equal(config.tickMs, 1000);
  assert.equal(config.maxAdvanceMs, 2000);
});

test('an explicit clamp overrides the one derived from the tick', () => {
  const config = configFromEnv({ PLAYTIME_TICK_MS: '1000', PLAYTIME_MAX_ADVANCE_MS: '9000' });

  assert.equal(config.maxAdvanceMs, 9000);
});

test('the idle timeout and stale timeout can be set independently', () => {
  const config = configFromEnv({ PLAYTIME_IDLE_EXIT_MS: '5000', PLAYTIME_STALE_SESSION_MS: '7000' });

  assert.equal(config.idleExitMs, 5000);
  assert.equal(config.staleSessionMs, 7000);
});

test('a nonsense value falls back to the default rather than breaking the daemon', () => {
  assert.equal(configFromEnv({ PLAYTIME_TICK_MS: 'soon' }).tickMs, DEFAULT_DAEMON_CONFIG.tickMs);
  assert.equal(configFromEnv({ PLAYTIME_TICK_MS: '-5' }).tickMs, DEFAULT_DAEMON_CONFIG.tickMs);
  assert.equal(configFromEnv({ PLAYTIME_TICK_MS: '0' }).tickMs, DEFAULT_DAEMON_CONFIG.tickMs);
});

test('the daemon loop keeps ticking until the work is done', async () => {
  await withTempHome(async (paths) => {
    // Short real-time cadence: this exercises the loop itself, not just one tick.
    const config: DaemonConfig = {
      tickMs: 5,
      maxAdvanceMs: 1000,
      idleExitMs: 20,
      staleSessionMs: 60_000,
      checkpointEveryMs: 60_000,
    };

    let probes = 0;
    const diesOnThirdProbe: AliveProbe = () => ++probes < 3;

    await appendEnvelope(paths, envelope('SessionStart', Date.now()));
    await runDaemon(paths, config, { now: Date.now, isAlive: diesOnThirdProbe, pid: 1 });

    assert.ok(probes >= 3, `expected the loop to tick repeatedly, it probed ${probes} times`);
    assert.equal((await readSessions(paths)).items.length, 1);
  });
});

test('the daemon loop stops promptly when aborted', async () => {
  await withTempHome(async (paths) => {
    const config: DaemonConfig = {
      tickMs: 60_000,
      maxAdvanceMs: 1000,
      idleExitMs: 60_000,
      staleSessionMs: 60_000,
      checkpointEveryMs: 60_000,
    };

    const controller = new AbortController();
    await appendEnvelope(paths, envelope('SessionStart', Date.now()));

    const running = runDaemon(paths, config, { now: Date.now, isAlive: ALIVE, pid: 1 }, controller.signal);
    setTimeout(() => controller.abort(), 20);

    // Without an abortable sleep this would hang for the full tick interval.
    await running;

    assert.equal((await readSessions(paths)).items.length, 1);
  });
});

test('a tick that cannot write keeps the daemon alive', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const daemon = await Daemon.start(paths, CONFIG, { now: clock.now, isAlive: ALIVE });
    await appendEnvelope(paths, envelope('SessionStart', T0));
    await daemon.tick();

    // Standing in for the transient ENOSPC that killed the real daemon.
    const { mkdir, rm } = await import('node:fs/promises');
    await rm(paths.live, { force: true });
    await mkdir(paths.live, { recursive: true });

    clock.advance(TICK);
    await assert.doesNotReject(daemon.tick());

    await rm(paths.live, { recursive: true, force: true });
    clock.advance(TICK);
    await daemon.tick();

    assert.equal(daemon.trackedCount, 1, 'the session survived the failed write');
    assert.equal((await readLive(paths))?.sessions[0]?.open, 2 * TICK);
  });
});

test('an open session reaches durable history without waiting to close', async () => {
  await withTempHome(async (paths) => {
    const clock = fakeClock(T0);
    const config: DaemonConfig = { ...CONFIG, checkpointEveryMs: 2 * TICK };
    const daemon = await Daemon.start(paths, config, { now: clock.now, isAlive: ALIVE });

    await appendEnvelope(paths, envelope('SessionStart', T0));
    for (let i = 0; i < 4; i++) {
      clock.advance(TICK);
      await daemon.tick();
    }

    // Losing the checkpoint entirely must not lose the hours already accrued.
    const { rm } = await import('node:fs/promises');
    await rm(paths.live, { force: true });

    const stored = await readSessions(paths);
    assert.equal(stored.items.length, 1);
    assert.ok(
      total(stored.items[0]?.open ?? []) >= 3 * TICK,
      `expected accrued time in history, got ${total(stored.items[0]?.open ?? [])}`,
    );
  });
});

test('a checkpointed session is not counted twice after a restart', () => {
  // The successor reads the checkpoint from history and also restores the same
  // session from the snapshot, so it must not credit both copies.
  const clock = fakeClock(T0);
  return withTempHome(async (paths) => {
    const config: DaemonConfig = { ...CONFIG, checkpointEveryMs: TICK };
    const first = await Daemon.start(paths, config, { now: clock.now, isAlive: ALIVE });
    await appendEnvelope(paths, envelope('SessionStart', T0));
    clock.advance(TICK);
    await first.tick();
    clock.advance(TICK);
    await first.tick();

    const second = await Daemon.start(paths, config, { now: clock.now, isAlive: ALIVE });
    await second.tick();

    const live = await readLive(paths);
    assert.equal(live?.allTime.open, 2 * TICK);
    assert.equal(live?.allTime.sessionTime, 2 * TICK, 'stacked totals must not double count');
  });
});
