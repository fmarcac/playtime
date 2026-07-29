/**
 * Per-day totals, for time series.
 *
 * Days are local calendar days and they do not overlap, so a day's open time is
 * deduplicated within the day and the days still add up to the window total.
 */

import type { Interval } from './intervals.js';
import { rollup } from './rollup.js';
import type { Totals } from './rollup.js';
import type { SessionRecord } from './session.js';
import { startOfDay } from './window.js';

export interface DayTotals extends Totals {
  /** Local calendar date, as YYYY-MM-DD. */
  date: string;
  /** The slice of the day actually covered, which the window can cut short. */
  start: number;
  end: number;
}

/** Local midnight after the day containing `ts`, which is 23 or 25 hours on a DST boundary. */
export function nextDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function isoDate(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** A corrupt record from 1970 must not turn a report into an infinite loop. */
const MAX_DAYS = 20_000;

const EMPTY: Totals = rollup([]).total;

export function daily(
  records: readonly SessionRecord[],
  window: Interval | null,
  now: number,
): DayTotals[] {
  if (records.length === 0) return [];

  const from = window ? window[0] : Math.min(...records.map((record) => record.start));
  const to = window ? window[1] : now;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  // Bucketing first means an empty day costs nothing but a row.
  const byDay = new Map<number, SessionRecord[]>();
  for (const record of records) {
    const last = Math.min(record.end, to);
    let day = startOfDay(Math.max(record.start, from));

    for (let guard = 0; day <= last && guard < MAX_DAYS; guard += 1) {
      const bucket = byDay.get(day);
      if (bucket) bucket.push(record);
      else byDay.set(day, [record]);
      day = nextDay(day);
    }
  }

  const days: DayTotals[] = [];
  let day = startOfDay(from);

  while (day < to && days.length < MAX_DAYS) {
    const boundary = nextDay(day);
    const slice: Interval = [Math.max(day, from), Math.min(boundary, to)];
    const inDay = byDay.get(day);

    days.push({
      date: isoDate(day),
      start: slice[0],
      end: slice[1],
      ...(inDay ? rollup(inDay, slice).total : EMPTY),
    });

    day = boundary;
  }

  return days;
}
