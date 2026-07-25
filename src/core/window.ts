import type { Interval } from './intervals.js';

export const WINDOW_KINDS = ['all', 'today', 'week', 'month'] as const;

export type WindowKind = (typeof WINDOW_KINDS)[number];

export function isWindowKind(value: string): value is WindowKind {
  return (WINDOW_KINDS as readonly string[]).includes(value);
}

/** Local midnight at the start of the day containing `ts`. */
export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The clipping window for a view. Rolling windows start at local midnight so
 * "week" means seven whole days rather than 168 hours ending mid-afternoon.
 */
export function windowFor(kind: WindowKind, now: number): Interval | null {
  switch (kind) {
    case 'all':
      return null;
    case 'today':
      return [startOfDay(now), now];
    case 'week':
      return [startOfDay(now) - 6 * DAY, now];
    case 'month':
      return [startOfDay(now) - 29 * DAY, now];
  }
}
