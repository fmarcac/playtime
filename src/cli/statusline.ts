/**
 * The status line renderer.
 *
 * Reads only the daemon's snapshot, never session history, so a status line
 * refreshing every few seconds stays cheap.
 */

import { basename } from 'node:path';

import { HARNESS_LABELS } from '../core/events.js';
import { formatCompact } from '../core/format.js';
import { concurrency } from '../core/rollup.js';
import type { LiveSnapshot } from '../store/live.js';

/**
 * Both numbers carry their own label. A status line is read at a glance and out
 * of context, so a bare glyph between two durations tells you nothing about
 * which is which.
 */
export const DEFAULT_STATUSLINE_FORMAT = '{open} open · {busy} busy';

/** What the default format degrades to when the terminal cannot fit it. */
const NARROW_FORMAT = '{open} open';

export interface StatuslineOptions {
  format?: string | undefined;
  /** Terminal width, which ccstatusline supplies on stdin. */
  width?: number | undefined;
  /** Window whose totals the bare tokens refer to. */
  window?: 'today' | 'week' | 'allTime' | undefined;
}

function fill(format: string, snapshot: LiveSnapshot, window: 'today' | 'week' | 'allTime'): string {
  const totals = snapshot[window];

  // With several sessions live, the newest is the one you are most likely looking at.
  const current = [...snapshot.sessions].sort((a, b) => b.startedAt - a.startedAt)[0];

  const values: Record<string, string> = {
    open: formatCompact(totals.open),
    busy: formatCompact(totals.busy),
    blocked: formatCompact(totals.blocked),
    sessions: String(totals.sessions),
    turns: String(totals.turns),
    total: formatCompact(snapshot.allTime.open),
    concurrency: `${concurrency(totals).toFixed(1)}x`,
    live: String(snapshot.sessions.length),
    project: current ? basename(current.project) : '',
    harness: current ? HARNESS_LABELS[current.harness] : '',
  };

  return format.replace(/\{(\w+)\}/g, (token, name: string) => values[name] ?? token);
}

export function renderStatusline(
  snapshot: LiveSnapshot | null,
  options: StatuslineOptions = {},
): string {
  // A status line should show nothing rather than an error when there is no data yet.
  if (!snapshot) return '';

  const window = options.window ?? 'today';
  const rendered = fill(options.format ?? DEFAULT_STATUSLINE_FORMAT, snapshot, window);

  // A format the user chose is theirs to fit; only the default is allowed to shrink.
  const shrinkable = options.format === undefined && options.width !== undefined;
  if (shrinkable && rendered.length > (options.width ?? Infinity)) {
    return fill(NARROW_FORMAT, snapshot, window);
  }

  return rendered;
}

export function statuslineJson(snapshot: LiveSnapshot | null): string {
  if (!snapshot) return JSON.stringify({ available: false });

  return JSON.stringify({
    available: true,
    updatedAt: snapshot.updatedAt,
    live: snapshot.sessions.length,
    today: snapshot.today,
    week: snapshot.week,
    allTime: snapshot.allTime,
  });
}
