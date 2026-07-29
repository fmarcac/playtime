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
import { concurrency, measure } from '../core/rollup.js';
import type { HarnessRollup, ProjectRollup, Rollup, Totals } from '../core/rollup.js';
import type { CountMode } from '../core/settings.js';
import type { LiveSnapshot } from '../store/live.js';
import type { WindowKind } from '../core/window.js';

export interface ViewContext {
  now: number;
  /** Home directory, so project paths can be shortened to `~/...`. */
  home: string;
  width: number;
  window: WindowKind;
  count: CountMode;
  projectLimit?: number | undefined;
  color?: boolean | undefined;
  /** The windows offered as tabs. Absent when the output is not being browsed. */
  tabs?: readonly WindowKind[] | undefined;
}

const WINDOW_LABELS: Record<WindowKind, string> = {
  all: 'all time',
  today: 'today',
  week: 'past 7 days',
  month: 'this month',
  year: 'this year',
};

const DEFAULT_PROJECT_ROWS = 12;
const BAR_WIDTH = 18;

const DIM = '2';
const BOLD = '1';
const CYAN = '36';
const GREEN = '32';

function paint(text: string, code: string, ctx: ViewContext): string {
  return ctx.color ? `[${code}m${text}[0m` : text;
}

function header(title: string, right: string, ctx: ViewContext): string {
  if (right === '') return paint(title, BOLD, ctx);

  const gap = Math.max(1, ctx.width - title.length - right.length);
  return `${paint(title, BOLD, ctx)}${' '.repeat(gap)}${paint(right, DIM, ctx)}`;
}

/**
 * Stacked totals look wrong unless the view says that is what they are. With a
 * tab strip on screen the window is already named there, so only the counting
 * mode is left to say.
 */
function windowLabel(ctx: ViewContext): string {
  if (ctx.tabs) return ctx.count === 'stacked' ? 'stacked' : '';

  const window = WINDOW_LABELS[ctx.window];
  return ctx.count === 'stacked' ? `${window} · stacked` : window;
}

const TAB_HINT = 'tab / shift-tab · q quits';

/**
 * The tab strip. The active tab is bracketed rather than only coloured, so it
 * is still the obvious one under NO_COLOR, and every cell keeps the same width
 * either way so the strip does not shift as tabs change.
 */
function tabStrip(ctx: ViewContext): string[] {
  if (!ctx.tabs || ctx.tabs.length === 0) return [];

  let plain = ' ';
  let painted = ' ';

  for (const window of ctx.tabs) {
    const active = window === ctx.window;
    const cell = active ? `[${WINDOW_LABELS[window]}]` : ` ${WINDOW_LABELS[window]} `;

    plain += ` ${cell}`;
    painted += ` ${paint(cell, active ? BOLD : DIM, ctx)}`;
  }

  // The hint sits beside the tabs when there is room and under them when there
  // is not, because a strip nobody knows how to move is worse than a wrapped one.
  const gap = ctx.width - plain.length - TAB_HINT.length;
  if (gap < 2) return [painted, paint(`  ${TAB_HINT}`, DIM, ctx)];

  return [`${painted}${' '.repeat(gap)}${paint(TAB_HINT, DIM, ctx)}`];
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

const OPEN_HEADING = 'open';
const BUSY_HEADING = 'agent busy';
const SEEN_HEADING = 'last used';

/** The harness table, with a header row so each column says what it is. */
function harnessTable(harnesses: readonly HarnessRollup[], ctx: ViewContext): string[] {
  if (harnesses.length === 0) return [];

  const measured = harnesses.map((row) => measure(row, ctx.count));
  const labels = harnesses.map((row) => HARNESS_LABELS[row.harness]);
  const opens = measured.map((row) => formatDuration(row.open));
  const busies = measured.map((row) => formatDuration(row.busy));
  const shares = measured.map((row) => formatPercent(row.busy, row.open));
  const seens = harnesses.map((row) => formatRelative(row.lastPlayed, ctx.now));

  const labelWidth = widest(labels);
  const openWidth = Math.max(widest(opens), OPEN_HEADING.length);
  const shareWidth = widest(shares);
  // Busy time and its share sit under one heading, so they are laid out as one column.
  const busyWidth = Math.max(widest(busies) + 2 + shareWidth, BUSY_HEADING.length);
  const seenWidth = Math.max(widest(seens), SEEN_HEADING.length);

  const header = [
    ' '.repeat(labelWidth),
    OPEN_HEADING.padStart(openWidth),
    BUSY_HEADING.padStart(busyWidth),
    SEEN_HEADING.padStart(seenWidth),
  ].join('   ');

  const rows = harnesses.map((_, index) => {
    const label = paint((labels[index] ?? '').padEnd(labelWidth), CYAN, ctx);
    const open = (opens[index] ?? '').padStart(openWidth);
    const busy = `${busies[index] ?? ''}  ${(shares[index] ?? '').padStart(shareWidth)}`.padStart(
      busyWidth,
    );
    const seen = (seens[index] ?? '').padStart(seenWidth);

    return `  ${label}   ${open}   ${paint(busy, DIM, ctx)}   ${paint(seen, DIM, ctx)}`;
  });

  return [paint(`  ${header}`, DIM, ctx), ...rows];
}

function projectRows(projects: readonly ProjectRollup[], ctx: ViewContext): string[] {
  const shown = projects.slice(0, ctx.projectLimit ?? DEFAULT_PROJECT_ROWS);
  const names = shown.map((row) => displayProject(row.project, ctx.home));
  const values = shown.map((row) => measure(row, ctx.count).open);
  const opens = values.map(formatDuration);

  const nameWidth = Math.min(widest(names), Math.max(20, ctx.width - 34));
  const openWidth = widest(opens);
  const most = values[0] ?? 0;

  const rows = shown.map((_, index) => {
    const name = (names[index] ?? '').padEnd(nameWidth);
    const open = (opens[index] ?? '').padStart(openWidth);
    const width = bar(values[index] ?? 0, most, BAR_WIDTH);
    return `    ${name}  ${open}  ${paint(width, DIM, ctx)}`;
  });

  const hidden = projects.length - shown.length;
  if (hidden > 0) rows.push(paint(`    and ${hidden} more`, DIM, ctx));

  return rows;
}

/**
 * The summary, in sentences rather than a row of unlabelled figures. Clauses
 * that would say nothing are left out: no overlap line when sessions never ran
 * concurrently, no waiting line when nothing ever blocked.
 */
function footer(totals: Totals, ctx: ViewContext): string[] {
  const shown = measure(totals, ctx.count);
  const share = formatPercent(shown.busy, shown.open);

  let headline = `${formatDuration(shown.open)} open, agent working ${formatDuration(shown.busy)} of it (${share})`;
  if (shown.blocked > 0) {
    headline += `, ${formatDuration(shown.blocked)} of that waiting on you`;
  }

  const lines = [headline];
  const overlap = concurrency(totals);

  // Each mode explains itself in terms of the other, so the relationship
  // between the two totals is always on screen.
  if (overlap > 1.05) {
    lines.push(
      ctx.count === 'stacked'
        ? `${overlap.toFixed(1)} sessions open at a time on average, ${formatDuration(totals.open)} of wall clock underneath`
        : `${overlap.toFixed(1)} sessions open at a time on average, ${formatDuration(totals.sessionTime)} of session time in total`,
    );
  }

  lines.push(plural(totals.turns, 'turn'));

  return lines.map((line) => paint(`  ${line}`, DIM, ctx));
}

function openNow(live: LiveSnapshot, ctx: ViewContext): string[] {
  if (live.sessions.length === 0) return [];

  return [
    '',
    ...live.sessions.map((session) => {
      const label = HARNESS_LABELS[session.harness];
      const project = displayProject(session.project, ctx.home);
      const state = session.busyNow ? ' · working' : '';
      return `  ${paint('open now', GREEN, ctx)}  ${label}  ${project}  ${formatDuration(session.open)}${state}`;
    }),
  ];
}

/** Title, tab strip if there is one, and the blank line under them. */
function heading(title: string, ctx: ViewContext): string[] {
  const strip = tabStrip(ctx);
  const first = header(title, windowLabel(ctx), ctx);

  return strip.length > 0 ? [first, '', ...strip, ''] : [first, ''];
}

export function renderLibrary(
  data: Rollup,
  live: LiveSnapshot | null,
  ctx: ViewContext,
): string {
  const lines = heading('PLAYTIME', ctx);

  if (data.total.sessions === 0) {
    lines.push(...nothingYet(ctx));
    if (live) lines.push(...openNow(live, ctx));
    return `${lines.join('\n')}\n`;
  }

  lines.push(...harnessTable(data.harnesses, ctx));
  lines.push('', `  ${paint('Hours used', BOLD, ctx)}`);
  lines.push(...projectRows(data.projects, ctx));
  lines.push('', ...footer(data.total, ctx));

  if (live) lines.push(...openNow(live, ctx));

  return `${lines.join('\n')}\n`;
}

export function renderDetail(title: string, data: Rollup, ctx: ViewContext): string {
  const lines = heading(title, ctx);

  if (data.total.sessions === 0) {
    lines.push('  No playtime recorded for this one yet.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(...footer(data.total, ctx), '');
  lines.push(...harnessTable(data.harnesses, ctx));

  // A single project adds nothing the title has not already said.
  if (data.projects.length > 1) {
    lines.push('', `  ${paint('Hours used', BOLD, ctx)}`);
    lines.push(...projectRows(data.projects, ctx));
  }

  return `${lines.join('\n')}\n`;
}
