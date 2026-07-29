import test from 'node:test';
import assert from 'node:assert/strict';

import { daily } from '../core/daily.js';
import { rollup } from '../core/rollup.js';
import type { Rollup } from '../core/rollup.js';
import type { SessionRecord } from '../core/session.js';
import type { Harness } from '../core/events.js';
import {
  buildRows,
  defaultOutput,
  fillTemplate,
  formatUnits,
  pick,
  renderOutput,
  toDelimited,
} from './output.js';
import type { OutputOptions, Row } from './output.js';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-07-29T18:00:00').getTime();

let counter = 0;

function session(options: {
  harness?: Harness;
  project?: string;
  hours: number;
  busyHours?: number;
  endsHoursAgo?: number;
  turns?: number;
}): SessionRecord {
  const end = NOW - (options.endsHoursAgo ?? 0) * HOUR;
  const start = end - options.hours * HOUR;

  return {
    id: `s${++counter}`,
    harness: options.harness ?? 'claude-code',
    project: options.project ?? '/home/dev/work/api',
    start,
    end,
    open: [[start, end]],
    busy: options.busyHours ? [[start, start + options.busyHours * HOUR]] : [],
    blocked: [],
    turns: options.turns ?? 0,
  };
}

const RECORDS = [
  session({ hours: 4, busyHours: 2, turns: 10 }),
  session({ hours: 2, project: '/home/dev/work/dash, board', endsHoursAgo: 5, turns: 3 }),
  session({ harness: 'codex', hours: 1, project: '/home/dev/infra', endsHoursAgo: 9 }),
];

const DATA: Rollup = rollup(RECORDS);

function options(partial: Partial<OutputOptions> = {}): OutputOptions {
  return { ...defaultOutput(), ...partial };
}

function rowsOf(partial: Partial<OutputOptions>): Row[] {
  return buildRows(DATA, [], options(partial)).rows;
}

test('durations convert to whichever unit was asked for', () => {
  assert.equal(formatUnits(90 * 60_000, 'ms'), 5_400_000);
  assert.equal(formatUnits(90 * 60_000, 's'), 5400);
  assert.equal(formatUnits(90 * 60_000, 'm'), 90);
  assert.equal(formatUnits(90 * 60_000, 'h'), 1.5);
  assert.equal(formatUnits(90 * 60_000, 'human'), '1h 30m');
});

test('machine output carries both the deduplicated and the stacked totals', () => {
  const overlapping = [session({ hours: 4 }), session({ hours: 4 })];
  const row = buildRows(rollup(overlapping), [], options({ format: 'csv', shape: 'totals' })).rows[0];

  assert.equal(row?.['open'], 4 * HOUR);
  assert.equal(row?.['sessionTime'], 8 * HOUR);
  assert.equal(row?.['concurrency'], 2);
});

test('rows default to projects for machine formats', () => {
  const built = buildRows(DATA, [], options({ format: 'csv' }));

  assert.equal(built.shape, 'projects');
  assert.equal(built.rows.length, 3);
});

test('each shape names what its rows are', () => {
  assert.equal(rowsOf({ format: 'jsonl', shape: 'harnesses' })[0]?.['harness'], 'claude-code');
  assert.equal(rowsOf({ format: 'jsonl', shape: 'projects' })[0]?.['project'], '/home/dev/work/api');
  assert.equal(rowsOf({ format: 'jsonl', shape: 'totals' })[0]?.['project'], undefined);
});

test('a project row lists the harnesses that touched it', () => {
  const row = rowsOf({ format: 'jsonl', shape: 'projects' }).find(
    (candidate) => candidate['project'] === '/home/dev/infra',
  );

  assert.equal(row?.['harnesses'], 'codex');
});

test('timestamps are ISO 8601 so anything can parse them', () => {
  const row = rowsOf({ format: 'jsonl', shape: 'totals' })[0];

  assert.equal(row?.['lastPlayed'], new Date(NOW).toISOString());
});

test('sorting and reversing work on the raw numbers, not the printed text', () => {
  const byTurns = rowsOf({ format: 'jsonl', sort: 'turns' }).map((row) => row['turns']);
  assert.deepEqual(byTurns, [10, 3, 0]);

  const reversed = rowsOf({ format: 'jsonl', sort: 'turns', reverse: true }).map((row) => row['turns']);
  assert.deepEqual(reversed, [0, 3, 10]);
});

test('sorting by name is alphabetical rather than largest first', () => {
  const names = rowsOf({ format: 'jsonl', sort: 'name' }).map((row) => row['project']);

  assert.deepEqual(names, ['/home/dev/infra', '/home/dev/work/api', '/home/dev/work/dash, board']);
});

test('the limit keeps the first rows of whatever order is in force', () => {
  assert.equal(rowsOf({ format: 'jsonl', limit: 2 }).length, 2);
  assert.equal(rowsOf({ format: 'jsonl', limit: 0 }).length, 0);
});

test('csv quotes a field containing its own delimiter', () => {
  const text = renderOutput(DATA, [], options({ format: 'csv' })).text;

  assert.match(text, /"\/home\/dev\/work\/dash, board"/);
});

test('csv leads with a header unless it is turned off', () => {
  const withHeader = renderOutput(DATA, [], options({ format: 'csv' })).text.split('\n')[0] ?? '';
  const without = renderOutput(DATA, [], options({ format: 'csv', header: false })).text;

  assert.match(withHeader, /^project,harnesses,open,busy/);
  assert.doesNotMatch(without.split('\n')[0] ?? '', /^project,/);
});

test('tsv replaces a tab inside a value rather than corrupting the row', () => {
  const text = toDelimited([{ project: 'a\tb', open: 1 }], ['project', 'open'], {
    delimiter: '\t',
    header: false,
  });

  assert.equal(text, 'a b\t1\n');
});

test('a null cell is empty in a delimited file and null in jsonl', () => {
  const csv = toDelimited([{ lastPlayed: null }], ['lastPlayed'], { delimiter: ',', header: false });
  const jsonl = renderOutput(rollup([]), [], options({ format: 'jsonl', shape: 'totals' })).text;

  assert.equal(csv, '\n');
  assert.match(jsonl, /"lastPlayed":null/);
});

test('jsonl is one object per line and nothing when there is nothing', () => {
  const text = renderOutput(DATA, [], options({ format: 'jsonl' })).text;

  assert.equal(text.trimEnd().split('\n').length, 3);
  assert.equal(renderOutput(rollup([]), [], options({ format: 'jsonl' })).text, '');
});

test('json without a shape is still the whole rollup', () => {
  const text = renderOutput(DATA, [], options({ format: 'json' })).text;
  const parsed = JSON.parse(text) as Rollup;

  assert.equal(parsed.total.open, DATA.total.open);
  assert.ok(Array.isArray(parsed.projects));
});

test('json with a shape is an array of those rows', () => {
  const text = renderOutput(DATA, [], options({ format: 'json', shape: 'harnesses' })).text;
  const parsed = JSON.parse(text) as Row[];

  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0]?.['harness'], 'claude-code');
});

test('a template fills its tokens per row and leaves unknown ones alone', () => {
  assert.equal(fillTemplate('{project} {open} {nope}', { project: 'api', open: '4h 00m' }), 'api 4h 00m {nope}');
});

test('a template defaults to human durations, since a person reads it', () => {
  const text = renderOutput(DATA, [], options({ format: 'template', template: '{open}' })).text;

  assert.match(text, /4h 00m/);
});

test('a field walks a dotted path and can index an array', () => {
  assert.equal(pick(DATA, 'total.open'), DATA.total.open);
  assert.equal(pick(DATA, 'projects.0.project'), '/home/dev/work/api');
  assert.equal(pick(DATA, 'projects.-1.project'), DATA.projects.at(-1)?.project);
  assert.equal(pick(DATA, 'total.nothing'), undefined);
  assert.equal(pick(DATA, 'projects.nope'), undefined);
});

test('a field that is not there reports itself as missing', () => {
  const found = renderOutput(DATA, [], options({ format: 'field', field: 'total.open' }));
  const missing = renderOutput(DATA, [], options({ format: 'field', field: 'total.nope' }));

  assert.equal(found.found, true);
  assert.equal(found.text, `${DATA.total.open}\n`);
  assert.equal(missing.found, false);
  assert.equal(missing.text, '');
});

test('a field is converted only when units were asked for', () => {
  const raw = renderOutput(DATA, [], options({ format: 'field', field: 'total.open' })).text;
  const hours = renderOutput(
    DATA,
    [],
    options({ format: 'field', field: 'total.open', units: 'h' }),
  ).text;

  // The three sessions do not overlap, so all time is the sum of their hours.
  assert.equal(raw, `${7 * HOUR}\n`);
  assert.equal(hours, '7\n');
});

test('day rows come from the daily series', () => {
  const days = daily(RECORDS, null, NOW);
  const text = renderOutput(DATA, days, options({ format: 'csv', shape: 'days' })).text;

  assert.match(text.split('\n')[0] ?? '', /^date,start,end,open/);
  assert.equal(text.trimEnd().split('\n').length, days.length + 1);
});
