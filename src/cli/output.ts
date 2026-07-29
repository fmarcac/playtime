/**
 * Machine-readable output.
 *
 * Every format is built from the same rows, so a CSV column and a template
 * token and a `--field` path all name the same number. Durations are
 * deduplicated in `open`, `busy` and `blocked` and summed per session in
 * `sessionTime`, `busyStacked` and `blockedStacked`, and both are always
 * present: machine output does not depend on the counting mode.
 */

import type { Harness } from '../core/events.js';
import { formatDuration } from '../core/format.js';
import { concurrency } from '../core/rollup.js';
import type { Rollup, Totals } from '../core/rollup.js';
import type { DayTotals } from '../core/daily.js';

export const OUTPUT_FORMATS = ['text', 'json', 'jsonl', 'csv', 'tsv', 'template', 'field'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const ROW_SHAPES = ['totals', 'harnesses', 'projects', 'days'] as const;
export type RowShape = (typeof ROW_SHAPES)[number];

export const UNITS = ['human', 'ms', 's', 'm', 'h'] as const;
export type Units = (typeof UNITS)[number];

export const SORT_KEYS = [
  'open',
  'busy',
  'blocked',
  'sessionTime',
  'sessions',
  'turns',
  'last',
  'name',
  'date',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface OutputOptions {
  format: OutputFormat;
  shape?: RowShape | undefined;
  units?: Units | undefined;
  header: boolean;
  limit?: number | undefined;
  sort?: SortKey | undefined;
  reverse: boolean;
  template?: string | undefined;
  field?: string | undefined;
  /** Text report only: layout width and whether colour is allowed. */
  width?: number | undefined;
  color?: boolean | undefined;
}

export function defaultOutput(): OutputOptions {
  return { format: 'text', header: true, reverse: false };
}

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

const MEASURES = [
  'open',
  'busy',
  'blocked',
  'sessionTime',
  'busyStacked',
  'blockedStacked',
  'concurrency',
  'share',
  'sessions',
  'turns',
] as const;

export const COLUMNS: Record<RowShape, readonly string[]> = {
  totals: [...MEASURES, 'lastPlayed'],
  harnesses: ['harness', ...MEASURES, 'lastPlayed'],
  projects: ['project', 'harnesses', ...MEASURES, 'lastPlayed'],
  days: ['date', 'start', 'end', ...MEASURES],
};

/** The shape a format reports when none was asked for. */
export function shapeFor(options: OutputOptions): RowShape {
  return options.shape ?? (options.format === 'text' ? 'totals' : 'projects');
}

/** Human durations suit a template a person reads; everything else is a number. */
function unitsFor(options: OutputOptions): Units {
  return options.units ?? (options.format === 'template' ? 'human' : 'ms');
}

const DIVISORS: Record<Exclude<Units, 'human'>, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

export function formatUnits(ms: number, units: Units): string | number {
  if (units === 'human') return formatDuration(ms);
  if (units === 'ms') return Math.round(ms);
  if (units === 's') return Math.round(ms / 1000);
  return Number((ms / DIVISORS[units]).toFixed(2));
}

/** Timestamps are always ISO 8601 in UTC, so they sort and parse anywhere. */
function timestamp(ts: number | null | undefined): string | null {
  return ts === null || ts === undefined ? null : new Date(ts).toISOString();
}

type Source = Totals & {
  harness?: Harness;
  project?: string;
  harnesses?: Harness[];
  date?: string;
  start?: number;
  end?: number;
  lastPlayed?: number | null;
};

function sources(data: Rollup, days: readonly DayTotals[], shape: RowShape): Source[] {
  switch (shape) {
    case 'totals':
      return [{ ...data.total, lastPlayed: data.lastPlayed }];
    case 'harnesses':
      return [...data.harnesses];
    case 'projects':
      return [...data.projects];
    case 'days':
      return [...days];
  }
}

function nameOf(source: Source): string {
  return source.project ?? source.harness ?? source.date ?? '';
}

/** Numbers read best largest first; names and dates read best in order. */
function descending(key: SortKey): boolean {
  return key !== 'name' && key !== 'date';
}

function compare(key: SortKey, a: Source, b: Source): number {
  switch (key) {
    case 'name':
      return nameOf(a).localeCompare(nameOf(b));
    case 'date':
      return (a.date ?? '').localeCompare(b.date ?? '');
    case 'last':
      return (a.lastPlayed ?? 0) - (b.lastPlayed ?? 0);
    default:
      return a[key] - b[key];
  }
}

function ordered(items: Source[], options: OutputOptions): Source[] {
  const key = options.sort;

  if (key !== undefined) {
    const direction = descending(key) ? -1 : 1;
    items.sort((a, b) => compare(key, a, b) * direction);
  }

  if (options.reverse) items.reverse();
  return options.limit === undefined ? items : items.slice(0, options.limit);
}

/** Built in column order, so a JSON object reads like its CSV row. */
function toRow(source: Source, shape: RowShape, units: Units): Row {
  const duration = (ms: number): Cell => formatUnits(ms, units);
  const row: Row = {};

  if (shape === 'harnesses') row['harness'] = source.harness ?? '';
  if (shape === 'projects') {
    row['project'] = source.project ?? '';
    row['harnesses'] = (source.harnesses ?? []).join('|');
  }
  if (shape === 'days') {
    row['date'] = source.date ?? '';
    row['start'] = timestamp(source.start);
    row['end'] = timestamp(source.end);
  }

  Object.assign(row, {
    open: duration(source.open),
    busy: duration(source.busy),
    blocked: duration(source.blocked),
    sessionTime: duration(source.sessionTime),
    busyStacked: duration(source.busyStacked),
    blockedStacked: duration(source.blockedStacked),
    concurrency: Number(concurrency(source).toFixed(2)),
    share: source.open > 0 ? Number(((source.busy / source.open) * 100).toFixed(1)) : 0,
    sessions: source.sessions,
    turns: source.turns,
  });

  if (shape !== 'days') row['lastPlayed'] = timestamp(source.lastPlayed);

  return row;
}

export function buildRows(
  data: Rollup,
  days: readonly DayTotals[],
  options: OutputOptions,
): { shape: RowShape; columns: readonly string[]; rows: Row[] } {
  const shape = shapeFor(options);
  const units = unitsFor(options);
  const rows = ordered(sources(data, days, shape), options).map((source) =>
    toRow(source, shape, units),
  );

  return { shape, columns: COLUMNS[shape], rows };
}

function text(cell: Cell): string {
  return cell === null ? '' : String(cell);
}

function csvCell(cell: Cell): string {
  const value = text(cell);
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Tabs and newlines cannot be quoted in TSV, so they become spaces. */
function tsvCell(cell: Cell): string {
  return text(cell).replace(/[\t\r\n]+/g, ' ');
}

export function toDelimited(
  rows: readonly Row[],
  columns: readonly string[],
  options: { delimiter: string; header: boolean },
): string {
  const escape = options.delimiter === '\t' ? tsvCell : csvCell;
  const lines = options.header ? [columns.join(options.delimiter)] : [];

  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column] ?? null)).join(options.delimiter));
  }

  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export function fillTemplate(template: string, row: Row): string {
  return template.replace(/\{(\w+)\}/g, (token, name: string) => {
    const cell = row[name];
    return cell === undefined ? token : text(cell);
  });
}

/** Walks a dotted path, with numbers indexing arrays. Undefined means missing. */
export function pick(document: unknown, path: string): unknown {
  let current = document;

  for (const step of path.split('.')) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const index = Number(step);
      if (!Number.isInteger(index)) return undefined;
      current = current[index < 0 ? current.length + index : index];
      continue;
    }

    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[step];
  }

  return current;
}

function fieldText(value: unknown, options: OutputOptions): string {
  if (typeof value === 'number' && options.units !== undefined) {
    return String(formatUnits(value, options.units));
  }
  if (value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface Rendered {
  text: string;
  /** False when `--field` named something that is not there. */
  found: boolean;
}

/**
 * Everything except the human report, which stays in views.ts because it needs
 * a terminal width and colour.
 */
export function renderOutput(
  data: Rollup,
  days: readonly DayTotals[],
  options: OutputOptions,
): Rendered {
  const { columns, rows } = buildRows(data, days, options);

  switch (options.format) {
    case 'json': {
      // Without an explicit shape, the whole rollup is the document, which is
      // what --json has always printed.
      const document = options.shape === undefined ? data : rows;
      return { text: `${JSON.stringify(document, null, 2)}\n`, found: true };
    }

    case 'jsonl':
      return { text: rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''), found: true };

    case 'csv':
      return {
        text: toDelimited(rows, columns, { delimiter: ',', header: options.header }),
        found: true,
      };

    case 'tsv':
      return {
        text: toDelimited(rows, columns, { delimiter: '\t', header: options.header }),
        found: true,
      };

    case 'template': {
      const template = options.template ?? '';
      const lines = rows.map((row) => fillTemplate(template, row));
      return { text: lines.length === 0 ? '' : `${lines.join('\n')}\n`, found: true };
    }

    case 'field': {
      const document = options.shape === undefined ? data : rows;
      const value = pick(document, options.field ?? '');
      if (value === undefined) return { text: '', found: false };
      return { text: `${fieldText(value, options)}\n`, found: true };
    }

    case 'text':
      return { text: '', found: true };
  }
}
