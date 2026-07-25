import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Paths } from './paths.js';

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export interface LockHandle {
  info: LockInfo;
  release(): Promise<void>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(paths.lock, JSON.stringify(info), { flag: 'wx' });
      return {
        info,
        release: async () => {
          await rm(paths.lock, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const holder = await readLock(paths);
      if (holder && isAlive(holder.pid)) return null;

      await rm(paths.lock, { force: true });
    }
  }

  return null;
}
