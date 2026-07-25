import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { processIsAlive } from '../daemon/proc.js';
import type { Paths } from './paths.js';

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export interface LockHandle {
  info: LockInfo;
  release(): Promise<void>;
}

export async function readLock(paths: Paths): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.lock, 'utf8')) as LockInfo;
    return typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Takes the single-instance daemon lock, or returns null if a live daemon
 * already holds it. A lock left behind by a killed daemon, or one corrupted on
 * disk, is reclaimed rather than blocking every future daemon.
 */
export async function acquireLock(
  paths: Paths,
  info: LockInfo,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<LockHandle | null> {
  await mkdir(dirname(paths.lock), { recursive: true });
  const staging = `${paths.lock}.claim.${info.pid}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    // Publish by linking a fully written file into place. Creating the lock and
    // filling it in are then one atomic step, so a competing daemon can never
    // read an empty lock and mistake it for a corrupt one worth stealing.
    await writeFile(staging, JSON.stringify(info), 'utf8');

    try {
      await link(staging, paths.lock);
      return { info, release: () => release(paths, info) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const holder = await readLock(paths);
      if (holder && isAlive(holder.pid)) return null;

      // The holder is gone, or the lock is unreadable. Either way, reclaim it.
      await rm(paths.lock, { force: true });
    } finally {
      await rm(staging, { force: true });
    }
  }

  return null;
}

/** Only ever removes our own lock, never one a successor has already taken. */
async function release(paths: Paths, info: LockInfo): Promise<void> {
  const holder = await readLock(paths);
  if (holder?.pid === info.pid) await rm(paths.lock, { force: true });
}
