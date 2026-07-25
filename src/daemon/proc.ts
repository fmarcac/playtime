import { readFileSync } from 'node:fs';

import type { AliveProbe } from './tracker.js';

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A value that changes when the kernel recycles a pid, so a new process cannot
 * inherit a dead session's identity.
 *
 * Read from `/proc/<pid>/stat` field 22. Other platforms have no equally cheap
 * source, so they get null and fall back to the pid alone. The comm field can
 * contain spaces and parentheses, hence splitting after the last `)`.
 */
export function processStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const startTime = Number(afterComm.split(' ')[19]);
    return Number.isFinite(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

export const aliveProbe: AliveProbe = (pid, pidStart) => {
  if (!processIsAlive(pid)) return false;
  if (pidStart === null) return true;

  const current = processStartTime(pid);
  return current === null || current === pidStart;
};
