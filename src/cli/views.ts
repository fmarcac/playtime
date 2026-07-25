/** Pure renderers. Everything returns a string so views can be tested directly. */

import { HARNESS_LABELS } from '../core/events.js';
import {
  bar,
  displayProject,
  formatDuration,
  formatPercent,
  formatRelative,
  plural,
} from '../core/format.js';
import { concurrency } from '../core/rollup.js';
import type { HarnessRollup, ProjectRollup, Rollup, Totals } from '../core/rollup.js';
import type { LiveSnapshot } from '../store/live.js';
import type { WindowKind } from '../core/window.js';

export interface ViewContext {
  now: number;
  /** Home directory, so project paths can be shortened to `~/...`. */
  home: string;
  width: number;
  window: WindowKind;
  color?: boolean | undefined;
}

const WINDOW_LABELS: Record<WindowKind, string> = {
  all: 'all time',
  today: 'today',
  week: 'past 7 days',
  month: 'past 30 days',
};

const MAX_PROJECT_ROWS = 12;
const BAR_WIDTH = 18;

const DIM = '2';
const BOLD = '1';
const CYAN = '36';
const GREEN = '32';

function paint(text: string, code: string, ctx: ViewContext): string {
  return ctx.color ? `[${code}m${text}[0m` : text;
}

function header(title: string, right: string, ctx: ViewContext): string {
  const gap = Math.max(1, ctx.width - title.length - right.length);
  return `${paint(title, BOLD, ctx)}${' '.repeat(gap)}${paint(right, DIM, ctx)}`;
}

function widest(values: readonly string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

function nothingYet(ctx: ViewContext): string[] {
  return [
    '  No playtime recorded yet.',
    paint('  Run `playtime doctor` to check that the hooks are installed.', DIM, ctx),
  ];
}

function harnessRows(harnesses: readonly HarnessRollup[], ctx: ViewContext): string[] {
  const labels = harnesses.map((row) => HARNESS_LABELS[row.harness]);
  const opens = harnesses.map((row) => formatDuration(row.open));
  const busies = harnesses.map((row) => formatDuration(row.busy));

  const labelWidth = widest(labels);
  const openWidth = widest(opens);
  const busyWidth = widest(busies);

  return harnesses.map((row, index) => {
    const label = paint((labels[index] ?? '').padEnd(labelWidth), CYAN, ctx);
    const open = (opens[index] ?? '').padStart(openWidth);
    const busy = `busy ${(busies[index] ?? '').padStart(busyWidth)}`;
    const share = formatPercent(row.busy, row.open).padStart(4);
    const seen = formatRelative(row.lastPlayed, ctx.now);

    return `  ${label}   ${open}   ${paint(`${busy} ${share}`, DIM, ctx)}   ${paint(seen, DIM, ctx)}`;
  });
}

function projectRows(projects: readonly ProjectRollup[], ctx: ViewContext): string[] {
  const shown = projects.slice(0, MAX_PROJECT_ROWS);
  const names = shown.map((row) => displayProject(row.project, ctx.home));
  const opens = shown.map((row) => formatDuration(row.open));

  const nameWidth = Math.min(widest(names), Math.max(20, ctx.width - 34));
  const openWidth = widest(opens);
  const most = shown[0]?.open ?? 0;

  const rows = shown.map((row, index) => {
    const name = (names[index] ?? '').padEnd(nameWidth);
    const open = (opens[index] ?? '').padStart(openWidth);
    return `    ${name}  ${open}  ${paint(bar(row.open, most, BAR_WIDTH), DIM, ctx)}`;
  });

  const hidden = projects.length - shown.length;
  if (hidden > 0) rows.push(paint(`    and ${hidden} more`, DIM, ctx));

  return rows;
}

function footer(totals: Totals, ctx: ViewContext): string {
  const parts = [
    `${formatDuration(totals.open)} open`,
    `${formatDuration(totals.busy)} busy`,
    `${concurrency(totals).toFixed(1)}x sessions deep`,
    plural(totals.turns, 'turn'),
  ];
  return paint(`  ${parts.join('  ·  ')}`, DIM, ctx);
}

function nowPlaying(live: LiveSnapshot, ctx: ViewContext): string[] {
  if (live.sessions.length === 0) return [];

  return [
    '',
    ...live.sessions.map((session) => {
      const label = HARNESS_LABELS[session.harness];
      const project = displayProject(session.project, ctx.home);
      const state = session.busyNow ? ' · working' : '';
      return `  ${paint('now playing', GREEN, ctx)}  ${label}  ${project}  ${formatDuration(session.open)}${state}`;
    }),
  ];
}

export function renderLibrary(
  data: Rollup,
  live: LiveSnapshot | null,
  ctx: ViewContext,
): string {
  const lines = [header('PLAYTIME', WINDOW_LABELS[ctx.window], ctx), ''];

  if (data.total.sessions === 0) {
    lines.push(...nothingYet(ctx));
    if (live) lines.push(...nowPlaying(live, ctx));
    return `${lines.join('\n')}\n`;
  }

  lines.push(...harnessRows(data.harnesses, ctx));
  lines.push('', `  ${paint('Hours used', BOLD, ctx)}`);
  lines.push(...projectRows(data.projects, ctx));
  lines.push('', footer(data.total, ctx));

  if (live) lines.push(...nowPlaying(live, ctx));

  return `${lines.join('\n')}\n`;
}

export function renderDetail(title: string, data: Rollup, ctx: ViewContext): string {
  const lines = [header(title, WINDOW_LABELS[ctx.window], ctx), ''];

  if (data.total.sessions === 0) {
    lines.push('  No playtime recorded for this one yet.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(footer(data.total, ctx), '');
  lines.push(...harnessRows(data.harnesses, ctx));

  // A single project adds nothing the title has not already said.
  if (data.projects.length > 1) {
    lines.push('', `  ${paint('Hours used', BOLD, ctx)}`);
    lines.push(...projectRows(data.projects, ctx));
  }

  return `${lines.join('\n')}\n`;
}
