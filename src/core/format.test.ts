import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bar,
  displayProject,
  formatCompact,
  formatDuration,
  formatPercent,
  formatRelative,
  plural,
} from './format.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('durations under a minute are shown in seconds', () => {
  assert.equal(formatDuration(42 * SECOND), '42s');
});

test('durations under an hour are shown in minutes', () => {
  assert.equal(formatDuration(38 * MINUTE), '38m');
});

test('durations of an hour or more are shown as hours and minutes', () => {
  assert.equal(formatDuration(412 * HOUR + 18 * MINUTE), '412h 18m');
});

test('a whole number of hours still shows its zero minutes', () => {
  assert.equal(formatDuration(3 * HOUR), '3h 00m');
});

test('zero is shown as zero minutes', () => {
  assert.equal(formatDuration(0), '0m');
});

test('negative durations are treated as zero', () => {
  assert.equal(formatDuration(-5000), '0m');
});

test('compact form drops the space for status lines', () => {
  assert.equal(formatCompact(4 * HOUR + 12 * MINUTE), '4h12m');
  assert.equal(formatCompact(38 * MINUTE), '38m');
  assert.equal(formatCompact(45 * SECOND), '45s');
});

test('relative time names today and yesterday', () => {
  const now = new Date('2026-07-25T15:00:00').getTime();

  assert.equal(formatRelative(new Date('2026-07-25T09:00:00').getTime(), now), 'today');
  assert.equal(formatRelative(new Date('2026-07-24T23:00:00').getTime(), now), 'yesterday');
});

test('relative time counts days, then weeks, then months', () => {
  const now = new Date('2026-07-25T15:00:00').getTime();

  assert.equal(formatRelative(now - 3 * DAY, now), '3 days ago');
  assert.equal(formatRelative(now - 14 * DAY, now), '2 weeks ago');
  assert.equal(formatRelative(now - 70 * DAY, now), '2 months ago');
});

test('never played reads as never', () => {
  assert.equal(formatRelative(null, Date.now()), 'never');
});

test('percentages round to whole numbers', () => {
  assert.equal(formatPercent(36, 100), '36%');
  assert.equal(formatPercent(1, 3), '33%');
});

test('a percentage of nothing is zero, not NaN', () => {
  assert.equal(formatPercent(5, 0), '0%');
});

test('bars scale to the widest value', () => {
  assert.equal(bar(10, 10, 4), '████');
  assert.equal(bar(5, 10, 4), '██');
  assert.equal(bar(0, 10, 4), '');
});

test('a nonzero value always draws at least one block', () => {
  assert.equal(bar(1, 1000, 10), '▏');
});

test('counts are pluralised', () => {
  assert.equal(plural(1, 'turn'), '1 turn');
  assert.equal(plural(2, 'turn'), '2 turns');
  assert.equal(plural(0, 'turn'), '0 turns');
});

test('large counts get thousands separators', () => {
  assert.equal(plural(2481, 'turn'), '2,481 turns');
});

test('project paths under home are shown with a tilde', () => {
  assert.equal(displayProject('/home/dev/git/playtime', '/home/dev'), '~/git/playtime');
});

test('project paths outside home are shown in full', () => {
  assert.equal(displayProject('/opt/work/thing', '/home/dev'), '/opt/work/thing');
});

test('home itself is shown as a bare tilde', () => {
  assert.equal(displayProject('/home/dev', '/home/dev'), '~');
});
