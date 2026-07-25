#!/usr/bin/env node
/** Daemon entrypoint. Holds the single-instance lock and runs until idle. */

import { acquireLock } from '../store/lock.js';
import { resolvePaths } from '../store/paths.js';
import { configFromEnv, runDaemon } from './daemon.js';
import { aliveProbe, processStartTime } from './proc.js';

const paths = resolvePaths();

const lock = await acquireLock(paths, {
  pid: process.pid,
  startedAt: processStartTime(process.pid) ?? Date.now(),
});

// Another daemon owns the lock and is doing the work. Nothing to do here.
if (!lock) process.exit(0);

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

try {
  await runDaemon(
    paths,
    configFromEnv(),
    { now: Date.now, isAlive: aliveProbe, pid: process.pid },
    controller.signal,
  );
} finally {
  await lock.release();
}
