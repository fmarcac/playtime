import test from 'node:test';
import assert from 'node:assert/strict';

import { daily, isoDate, nextDay } from './daily.js';
import { rollup } from './rollup.js';
import type { SessionRecord } from './session.js';
import { windowFor } from './window.js';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-07-29T15:00:00').getTime();

let counter = 0;

function session(from: string, to: string): SessionRecord {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();

  return {
    id: `s${++counter}`,
    harness: 'claude-code',
    project: '/home/dev/work/api',
    start,
    end,
    open: [[start, end]],
    busy: [[start, start + (end - start) / 2]],
    blocked: [],
    turns: 1,
  };
}

test('a session inside one day produces one day', () => {
  const days = daily([session('2026-07-29T09:00:00', '2026-07-29T11:00:00')], null, NOW);

  assert.equal(days.length, 1);
  assert.equal(days[0]?.date, '2026-07-29');
  assert.equal(days[0]?.open, 2 * HOUR);
  assert.equal(days[0]?.busy, HOUR);
});

test('a session over midnight is split at the boundary', () => {
  const days = daily([session('2026-07-28T23:00:00', '2026-07-29T02:00:00')], null, NOW);

  assert.deepEqual(
    days.map((day) => [day.date, day.open]),
    [
      ['2026-07-28', HOUR],
      ['2026-07-29', 2 * HOUR],
    ],
  );
});

test('a day with nothing in it is still a row, so a series has no holes', () => {
  const days = daily(
    [
      session('2026-07-26T10:00:00', '2026-07-26T11:00:00'),
      session('2026-07-29T10:00:00', '2026-07-29T11:00:00'),
    ],
    null,
    NOW,
  );

  assert.deepEqual(
    days.map((day) => day.date),
    ['2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29'],
  );
  assert.equal(days[1]?.open, 0);
  assert.equal(days[1]?.sessions, 0);
});

test('days are deduplicated within themselves and add up to the window total', () => {
  const records = [
    session('2026-07-28T10:00:00', '2026-07-28T14:00:00'),
    // Fully inside the first, so the day must count four hours, not eight.
    session('2026-07-28T11:00:00', '2026-07-28T13:00:00'),
    session('2026-07-29T09:00:00', '2026-07-29T10:00:00'),
  ];

  const window = windowFor('month', NOW);
  const days = daily(records, window, NOW);
  const summed = days.reduce((sum, day) => sum + day.open, 0);

  assert.equal(days.find((day) => day.date === '2026-07-28')?.open, 4 * HOUR);
  assert.equal(summed, rollup(records, window).total.open);
});

test('the window clips the first and last day rather than the whole day', () => {
  const records = [session('2026-07-29T08:00:00', '2026-07-29T14:00:00')];
  const since = new Date('2026-07-29T10:00:00').getTime();

  const days = daily(records, [since, NOW], NOW);

  assert.equal(days.length, 1);
  assert.equal(days[0]?.open, 4 * HOUR);
  assert.equal(days[0]?.start, since);
});

test('no records means no days rather than a decade of zeroes', () => {
  assert.deepEqual(daily([], null, NOW), []);
});

test('the day after a day is the next local midnight', () => {
  assert.equal(nextDay(new Date('2026-07-29T23:59:59').getTime()), new Date('2026-07-30T00:00:00').getTime());
  assert.equal(isoDate(new Date('2026-01-05T13:00:00').getTime()), '2026-01-05');
});
