/** Parsing a point in time from the command line, for `--since` and `--until`. */

import { startOfDay } from './window.js';

const SPANS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const RELATIVE = /^(\d+(?:\.\d+)?)([smhdw])$/;
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight `days` before the day containing `ts`, DST included. */
function daysBack(ts: number, days: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.getTime();
}

/**
 * Accepts `2026-07-01`, an ISO timestamp, `90m`, `7d`, `today`, `yesterday`,
 * `now`, or epoch seconds or milliseconds. Returns null when it means nothing.
 *
 * A bare date is local midnight rather than UTC, because every other window in
 * Playtime is local and a script asking for a day means its own day.
 */
export function parseWhen(value: string, now: number): number | null {
  const text = value.trim();
  if (text === '') return null;

  if (text === 'now') return now;
  if (text === 'today') return startOfDay(now);
  if (text === 'yesterday') return daysBack(now, 1);

  const relative = RELATIVE.exec(text);
  if (relative) {
    const span = SPANS[relative[2] ?? ''];
    if (span !== undefined) return now - Number(relative[1]) * span;
  }

  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  // Date.parse reads a bare number as a year, which is never what was meant:
  // a number here is either an epoch or it is missing its unit.
  if (/^\d+$/.test(text)) return null;

  const day = CALENDAR_DAY.exec(text);
  if (day) {
    return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}
