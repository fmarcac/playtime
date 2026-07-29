import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWhen } from './when.js';

const NOW = new Date('2026-07-29T15:20:00').getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('a relative span counts back from now', () => {
  assert.equal(parseWhen('7d', NOW), NOW - 7 * DAY);
  assert.equal(parseWhen('90m', NOW), NOW - 90 * 60_000);
  assert.equal(parseWhen('2w', NOW), NOW - 14 * DAY);
  assert.equal(parseWhen('1.5h', NOW), NOW - 1.5 * HOUR);
});

test('a bare date is local midnight, not UTC', () => {
  assert.equal(parseWhen('2026-07-01', NOW), new Date('2026-07-01T00:00:00').getTime());
});

test('a full timestamp is taken as written', () => {
  assert.equal(parseWhen('2026-07-01T09:30:00Z', NOW), Date.parse('2026-07-01T09:30:00Z'));
});

test('the words a person would type mean what they say', () => {
  assert.equal(parseWhen('now', NOW), NOW);
  assert.equal(parseWhen('today', NOW), new Date('2026-07-29T00:00:00').getTime());
  assert.equal(parseWhen('yesterday', NOW), new Date('2026-07-28T00:00:00').getTime());
});

test('epochs are accepted in seconds and in milliseconds', () => {
  assert.equal(parseWhen('1753440000', NOW), 1_753_440_000_000);
  assert.equal(parseWhen('1753440000000', NOW), 1_753_440_000_000);
});

test('anything unreadable is null rather than a silent NaN', () => {
  assert.equal(parseWhen('whenever', NOW), null);
  assert.equal(parseWhen('', NOW), null);
  assert.equal(parseWhen('7', NOW), null);
  assert.equal(parseWhen('7y', NOW), null);
});
