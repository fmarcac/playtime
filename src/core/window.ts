import type { Interval } from './intervals.js';

/** Widest first, which is also the order the tab strip walks. */
export const WINDOW_KINDS = ['all', 'year', 'month', 'week', 'today'] as const;

export type WindowKind = (typeof WINDOW_KINDS)[number];

/** The windows the interactive report offers as tabs. */
export const TAB_WINDOWS = ['all', 'year', 'month', 'today'] as const;

export function isWindowKind(value: string): value is WindowKind {
  return (WINDOW_KINDS as readonly string[]).includes(value);
}

/**
 * The tabs to show while `current` is open. A window reached by name but left
 * out of the strip, such as `week`, joins it rather than vanishing when the
 * report is browsed interactively.
 */
export function tabsFor(current: WindowKind): WindowKind[] {
  return WINDOW_KINDS.filter(
    (kind) => (TAB_WINDOWS as readonly string[]).includes(kind) || kind === current,
  );
}

/** Local midnight at the start of the day containing `ts`. */
export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight on the first of the month containing `ts`. */
export function startOfMonth(ts: number): number {
  const date = new Date(ts);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight on January 1st of the year containing `ts`. */
export function startOfYear(ts: number): number {
  const date = new Date(ts);
  date.setMonth(0, 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The clipping window for a view. Today, the month and the year are calendar
 * periods, so they mean what a person means by them and reset on the boundary.
 * The week stays a rolling seven days, and starts at local midnight so it is
 * seven whole days rather than 168 hours ending mid-afternoon.
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
      return [startOfMonth(now), now];
    case 'year':
      return [startOfYear(now), now];
  }
}
