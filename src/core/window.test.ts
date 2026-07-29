import test from 'node:test';
import assert from 'node:assert/strict';

import { isWindowKind, startOfDay, tabsFor, windowFor } from './window.js';

// Mid-afternoon on a day that is neither the first of the month nor of the year,
// so a calendar window and a rolling one cannot accidentally agree.
const NOW = new Date('2026-07-29T15:20:00').getTime();

function startOf(iso: string): number {
  return new Date(iso).getTime();
}

test('all time has no window at all, so nothing is clipped', () => {
  assert.equal(windowFor('all', NOW), null);
});

test('today runs from local midnight to now', () => {
  assert.deepEqual(windowFor('today', NOW), [startOf('2026-07-29T00:00:00'), NOW]);
});

test('the month is the calendar month to date, not the last thirty days', () => {
  assert.deepEqual(windowFor('month', NOW), [startOf('2026-07-01T00:00:00'), NOW]);
});

test('the year is the calendar year to date', () => {
  assert.deepEqual(windowFor('year', NOW), [startOf('2026-01-01T00:00:00'), NOW]);
});

test('the week stays a rolling seven whole days', () => {
  assert.deepEqual(windowFor('week', NOW), [startOf('2026-07-23T00:00:00'), NOW]);
});

test('a calendar window starts on the boundary even when today is the boundary', () => {
  const newYear = new Date('2026-01-01T00:30:00').getTime();

  assert.deepEqual(windowFor('year', newYear), [startOfDay(newYear), newYear]);
  assert.deepEqual(windowFor('month', newYear), [startOfDay(newYear), newYear]);
});

test('year is a window name the command line accepts', () => {
  assert.equal(isWindowKind('year'), true);
  assert.equal(isWindowKind('decade'), false);
});

test('the tabs run widest to narrowest', () => {
  assert.deepEqual(tabsFor('all'), ['all', 'year', 'month', 'today']);
});

test('a window outside the strip joins it rather than disappearing', () => {
  assert.deepEqual(tabsFor('week'), ['all', 'year', 'month', 'week', 'today']);
});
