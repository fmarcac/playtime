import { spawn } from 'node:child_process';
import { mkdir, stat, truncate } from 'node:fs/promises';
import { openSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLock } from '../store/lock.js';
import type { Paths } from '../store/paths.js';
import { processIsAlive } from './proc.js';

const MAX_LOG_BYTES = 1024 * 1024;

async function prepareLog(paths: Paths): Promise<number> {
  await mkdir(dirname(paths.log), { recursive: true });

  const size = await stat(paths.log).then(
    (info) => info.size,
    () => 0,
  );
  if (size > MAX_LOG_BYTES) await truncate(paths.log, 0);

  return openSync(paths.log, 'a');
}

/**
 * Starts the daemon unless one is already running.
 *
 * Called from `SessionStart`, so opening any harness brings tracking up without
 * the user having to run a service. The child is detached and its parent exits
 * immediately, so the hook stays fast.
 */
export async function ensureDaemon(paths: Paths): Promise<'running' | 'started'> {
  const holder = await readLock(paths);
  if (holder && processIsAlive(holder.pid)) return 'running';

  const entrypoint = fileURLToPath(new URL('./main.js', import.meta.url));
  const log = await prepareLog(paths);

  const child = spawn(process.execPath, [entrypoint], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, PLAYTIME_HOME: paths.home },
  });
  child.unref();

  return 'started';
}
