import { readFile } from 'node:fs/promises';

import type { Harness } from '../core/events.js';
import type { Totals } from '../core/rollup.js';
import type { SessionState } from '../core/session.js';
import type { Paths } from './paths.js';
import { writeAtomic } from './jsonl.js';

export interface LiveSessionSummary {
  id: string;
  harness: Harness;
  project: string;
  startedAt: number;
  open: number;
  busy: number;
  busyNow: boolean;
}

/**
 * The status line's entire input, and the daemon's crash checkpoint.
 *
 * The daemon keeps the windowed totals current so a status line refresh never
 * has to read session history. It also writes full session state, so a daemon
 * that is killed does not take its in-flight sessions down with it: the next
 * daemon restores them and either keeps tracking or closes them at their last
 * confirmed-alive moment.
 */
export interface LiveSnapshot {
  v: 1;
  updatedAt: number;
  daemonPid: number | null;
  tracking: SessionState[];
  sessions: LiveSessionSummary[];
  today: Totals;
  week: Totals;
  allTime: Totals;
}

export async function writeLive(paths: Paths, snapshot: LiveSnapshot): Promise<void> {
  await writeAtomic(paths.live, JSON.stringify(snapshot));
}

export async function readLive(paths: Paths): Promise<LiveSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.live, 'utf8')) as LiveSnapshot;
    return parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}
