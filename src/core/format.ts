/** Rendering helpers shared by every CLI view. */

import { startOfDay } from './window.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const;

/** Human duration for wide layouts, for example `412h 18m`. */
export function formatDuration(ms: number): string {
  const t = Math.max(0, Math.floor(ms));
  if (t === 0) return '0m';
  if (t < MINUTE) return `${Math.floor(t / SECOND)}s`;
  if (t < HOUR) return `${Math.floor(t / MINUTE)}m`;

  const hours = Math.floor(t / HOUR);
  const minutes = Math.floor((t % HOUR) / MINUTE);
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/** Space-free duration for status lines, for example `4h12m`. */
export function formatCompact(ms: number): string {
  const t = Math.max(0, Math.floor(ms));
  if (t === 0) return '0m';
  if (t < MINUTE) return `${Math.floor(t / SECOND)}s`;
  if (t < HOUR) return `${Math.floor(t / MINUTE)}m`;

  const hours = Math.floor(t / HOUR);
  const minutes = Math.floor((t % HOUR) / MINUTE);
  return `${hours}h${String(minutes).padStart(2, '0')}m`;
}

export function formatRelative(ts: number | null, now: number): string {
  if (ts === null) return 'never';

  // Rounding absorbs the hour that daylight saving adds or removes.
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);

  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;

  if (days < 60) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }

  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

/** Proportional bar with eighth-block precision, so small values stay visible. */
export function bar(value: number, max: number, width: number): string {
  if (value <= 0 || max <= 0 || width <= 0) return '';

  const filled = (value / max) * width;
  const full = Math.floor(filled);
  const eighths = Math.floor((filled - full) * 8);

  const rendered = '█'.repeat(full) + (eighths > 0 ? (EIGHTHS[eighths - 1] ?? '') : '');
  return rendered === '' ? EIGHTHS[0] : rendered;
}

export function displayProject(path: string, home: string): string {
  if (!home || home === '/') return path;
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
