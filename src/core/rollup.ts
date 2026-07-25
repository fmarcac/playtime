/**
 * Aggregation from session records to the numbers the CLI renders.
 *
 * Durations are unions within whatever scope is being reported, so concurrent
 * sessions never stack. Counts are per session, and a session is included when
 * any of its open time falls inside the window.
 */

import { clip, normalize, total } from './intervals.js';
import type { Interval } from './intervals.js';
import type { Harness } from './events.js';
import type { SessionRecord } from './session.js';
import type { CountMode } from './settings.js';

export interface Totals {
  /** Deduplicated wall-clock time the harness was open. */
  open: number;
  /** Deduplicated time the agent was working. */
  busy: number;
  /** Deduplicated time the agent was waiting on you, a subset of busy. */
  blocked: number;
  /** Undeduplicated sum of session durations. Divided by open, this is concurrency. */
  sessionTime: number;
  /** Busy and blocked time summed per session rather than unioned. */
  busyStacked: number;
  blockedStacked: number;
  sessions: number;
  turns: number;
}

/**
 * Picks the trio of durations a view should show.
 *
 * Both are always computed, so the counting mode is purely a presentation
 * choice and switching it never needs the history re-read.
 */
export function measure(
  totals: Totals,
  mode: CountMode,
): { open: number; busy: number; blocked: number } {
  if (mode === 'stacked') {
    return { open: totals.sessionTime, busy: totals.busyStacked, blocked: totals.blockedStacked };
  }
  return { open: totals.open, busy: totals.busy, blocked: totals.blocked };
}

export interface HarnessRollup extends Totals {
  harness: Harness;
  lastPlayed: number | null;
}

export interface ProjectRollup extends Totals {
  project: string;
  harnesses: Harness[];
  lastPlayed: number | null;
}

export interface Rollup {
  total: Totals;
  harnesses: HarnessRollup[];
  projects: ProjectRollup[];
  lastPlayed: number | null;
}

interface Bucket {
  open: Interval[];
  busy: Interval[];
  blocked: Interval[];
  sessionTime: number;
  busyStacked: number;
  blockedStacked: number;
  sessions: number;
  turns: number;
  lastPlayed: number | null;
  harnesses: Set<Harness>;
}

function emptyBucket(): Bucket {
  return {
    open: [],
    busy: [],
    blocked: [],
    sessionTime: 0,
    busyStacked: 0,
    blockedStacked: 0,
    sessions: 0,
    turns: 0,
    lastPlayed: null,
    harnesses: new Set(),
  };
}

interface ClippedSession {
  open: Interval[];
  busy: Interval[];
  blocked: Interval[];
  end: number;
  turns: number;
  harness: Harness;
}

function accumulate(bucket: Bucket, session: ClippedSession): void {
  bucket.open.push(...session.open);
  bucket.busy.push(...session.busy);
  bucket.blocked.push(...session.blocked);
  bucket.sessionTime += total(session.open);
  bucket.busyStacked += total(session.busy);
  bucket.blockedStacked += total(session.blocked);
  bucket.sessions += 1;
  bucket.turns += session.turns;
  bucket.harnesses.add(session.harness);
  if (bucket.lastPlayed === null || session.end > bucket.lastPlayed) {
    bucket.lastPlayed = session.end;
  }
}

function totals(bucket: Bucket): Totals {
  return {
    open: total(bucket.open),
    busy: total(bucket.busy),
    blocked: total(bucket.blocked),
    sessionTime: bucket.sessionTime,
    busyStacked: bucket.busyStacked,
    blockedStacked: bucket.blockedStacked,
    sessions: bucket.sessions,
    turns: bucket.turns,
  };
}

function upsert<K>(map: Map<K, Bucket>, key: K): Bucket {
  const existing = map.get(key);
  if (existing) return existing;
  const created = emptyBucket();
  map.set(key, created);
  return created;
}

export function rollup(records: Iterable<SessionRecord>, window: Interval | null = null): Rollup {
  const grand = emptyBucket();
  const byHarness = new Map<Harness, Bucket>();
  const byProject = new Map<string, Bucket>();

  for (const record of records) {
    const open = window ? clip(record.open, window) : normalize(record.open);
    if (open.length === 0) continue;

    const session: ClippedSession = {
      open,
      busy: window ? clip(record.busy, window) : normalize(record.busy),
      blocked: window ? clip(record.blocked, window) : normalize(record.blocked),
      end: window ? Math.min(record.end, window[1]) : record.end,
      turns: record.turns,
      harness: record.harness,
    };

    accumulate(grand, session);
    accumulate(upsert(byHarness, record.harness), session);
    accumulate(upsert(byProject, record.project), session);
  }

  const harnesses: HarnessRollup[] = [...byHarness].map(([harness, bucket]) => ({
    harness,
    lastPlayed: bucket.lastPlayed,
    ...totals(bucket),
  }));

  const projects: ProjectRollup[] = [...byProject].map(([project, bucket]) => ({
    project,
    harnesses: [...bucket.harnesses],
    lastPlayed: bucket.lastPlayed,
    ...totals(bucket),
  }));

  const byOpenDescending = (a: Totals, b: Totals): number => b.open - a.open;
  harnesses.sort(byOpenDescending);
  projects.sort(byOpenDescending);

  return { total: totals(grand), harnesses, projects, lastPlayed: grand.lastPlayed };
}

/** How many sessions of work fit inside each hour of wall clock. */
export function concurrency(totals: Totals): number {
  if (totals.open <= 0) return 0;
  return totals.sessionTime / totals.open;
}
