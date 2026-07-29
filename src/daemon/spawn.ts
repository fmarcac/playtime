import { spawn } from 'node:child_process';
import { mkdir, stat, truncate } from 'node:fs/promises';
import { openSync, writeSync } from 'node:fs';
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
 * What to start the daemon with.
 *
 * `process.execPath` only names a JavaScript runtime when this is itself
 * running under Node. Inside the OpenCode plugin it is OpenCode's own compiled
 * binary, which reads the entrypoint as a directory to open rather than a
 * script to run, so the daemon never starts and nothing is ever tracked. The
 * shell shim already resolves `PLAYTIME_NODE` or `node`; this agrees with it.
 */
export function daemonRuntime(
  execPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env['PLAYTIME_NODE'];
  if (override !== undefined && override !== '') return override;

  const name = (/[^/\\]+$/.exec(execPath)?.[0] ?? '').toLowerCase();
  return name === 'node' || name === 'node.exe' || name === 'nodejs' ? execPath : 'node';
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

  const runtime = daemonRuntime();
  const child = spawn(runtime, [entrypoint], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, PLAYTIME_HOME: paths.home },
  });

  // A runtime that is not there emits this asynchronously, and an unhandled
  // error event throws. A tracker must never take the harness down with it.
  child.on('error', (error: Error) => {
    writeSync(log, `playtime: could not start the daemon with ${runtime}: ${error.message}\n`);
  });

  child.unref();

  return 'started';
}
