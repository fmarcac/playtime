/**
 * Tests the daemon as its own process.
 *
 * In-process tests cannot catch a daemon that fails to keep its own event loop
 * alive, because the test runner keeps it alive for them. Only a real spawned
 * process shows that up, so the loop gets checked here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { appendEnvelope } from '../store/inbox.js';
import { readLive } from '../store/live.js';
import { resolvePaths } from '../store/paths.js';
import type { Paths } from '../store/paths.js';
import type { Envelope } from '../core/events.js';

const MAIN = fileURLToPath(new URL('./main.js', import.meta.url));
const TICK_MS = 50;

function startDaemon(home: string): ChildProcess {
  return spawn(process.execPath, [MAIN], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PLAYTIME_HOME: home,
      PLAYTIME_TICK_MS: String(TICK_MS),
      PLAYTIME_IDLE_EXIT_MS: '600000',
    },
  });
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await delay(20);
  }
  return null;
}

async function withDaemon(body: (paths: Paths, child: ChildProcess) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'playtime-e2e-'));
  const paths = resolvePaths({ PLAYTIME_HOME: home });
  await mkdir(dirname(paths.inbox), { recursive: true });

  const child = startDaemon(home);
  try {
    await body(paths, child);
  } finally {
    child.kill('SIGTERM');
    await delay(50);
    child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
}

function envelope(hook: string, pid: number): Envelope {
  return {
    v: 1,
    ts: Date.now(),
    harness: 'claude-code',
    hook,
    pid,
    payload: { session_id: 'sess_live', cwd: '/home/dev/git/playtime' },
  };
}

test('a spawned daemon keeps ticking rather than exiting after one pass', async () => {
  await withDaemon(async (paths, child) => {
    // The test runner itself stands in for a harness process that stays alive.
    await appendEnvelope(paths, envelope('SessionStart', process.pid));

    const first = await waitFor(async () => {
      const live = await readLive(paths);
      return live && live.sessions.length > 0 ? live : null;
    }, 5000);

    assert.ok(first, 'the daemon never picked the session up');

    // Several more ticks must land, which only happens if the loop stays alive.
    await delay(TICK_MS * 6);
    const later = await readLive(paths);

    assert.ok(later, 'the snapshot disappeared');
    assert.ok(
      later.updatedAt > first.updatedAt,
      'the daemon stopped ticking after its first pass',
    );
    assert.ok(
      (later.sessions[0]?.open ?? 0) > (first.sessions[0]?.open ?? 0),
      'open time stopped accruing',
    );
    assert.equal(child.exitCode, null, 'the daemon process exited early');
  });
});

test('a spawned daemon shuts down promptly on SIGTERM', async () => {
  await withDaemon(async (paths, child) => {
    await appendEnvelope(paths, envelope('SessionStart', process.pid));
    await waitFor(async () => {
      const live = await readLive(paths);
      return live && live.sessions.length > 0 ? live : null;
    }, 5000);

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');

    // A tick interval plus slack. An unabortable sleep would blow well past this.
    const raced = await Promise.race([exited.then(() => 'exited'), delay(2000).then(() => 'hung')]);

    assert.equal(raced, 'exited');
  });
});
