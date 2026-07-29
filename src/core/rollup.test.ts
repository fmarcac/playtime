import test from 'node:test';
import assert from 'node:assert/strict';

import { concurrency, measure, rollup } from './rollup.js';
import type { SessionRecord } from './session.js';
import type { Harness } from './events.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE = new Date('2026-07-20T00:00:00Z').getTime();

let counter = 0;

function session(options: {
  harness?: Harness;
  project?: string;
  from: number;
  to: number;
  busy?: [number, number][];
  blocked?: [number, number][];
  turns?: number;
}): SessionRecord {
  const { from, to } = options;
  return {
    id: `sess_${++counter}`,
    harness: options.harness ?? 'claude-code',
    project: options.project ?? '/home/dev/work/api',
    start: from,
    end: to,
    open: [[from, to]],
    busy: options.busy ?? [],
    blocked: options.blocked ?? [],
    turns: options.turns ?? 0,
  };
}

test('no sessions produce zeroed totals', () => {
  const result = rollup([]);

  assert.equal(result.total.open, 0);
  assert.equal(result.total.sessions, 0);
  assert.deepEqual(result.harnesses, []);
  assert.deepEqual(result.projects, []);
  assert.equal(result.lastPlayed, null);
});

test('a single session rolls up into its harness and its project', () => {
  const result = rollup([session({ from: BASE, to: BASE + 2 * HOUR, turns: 5 })]);

  assert.equal(result.total.open, 2 * HOUR);
  assert.equal(result.total.turns, 5);
  assert.equal(result.harnesses.length, 1);
  assert.equal(result.harnesses[0]?.harness, 'claude-code');
  assert.equal(result.harnesses[0]?.open, 2 * HOUR);
  assert.equal(result.projects[0]?.project, '/home/dev/work/api');
  assert.equal(result.projects[0]?.open, 2 * HOUR);
});

test('concurrent sessions in one harness report wall clock, not the sum', () => {
  const result = rollup([
    session({ from: BASE + 14 * HOUR, to: BASE + 15 * HOUR }),
    session({ from: BASE + 14.5 * HOUR, to: BASE + 15.5 * HOUR }),
  ]);

  assert.equal(result.harnesses[0]?.open, 1.5 * HOUR);
  assert.equal(result.harnesses[0]?.sessionTime, 2 * HOUR);
  assert.equal(result.harnesses[0]?.sessions, 2);
});

test('the grand total deduplicates across different harnesses too', () => {
  const result = rollup([
    session({ harness: 'claude-code', from: BASE + 14 * HOUR, to: BASE + 15 * HOUR }),
    session({ harness: 'codex', from: BASE + 14.5 * HOUR, to: BASE + 15.5 * HOUR }),
  ]);

  assert.equal(result.harnesses.length, 2);
  assert.equal(result.total.open, 1.5 * HOUR);
  assert.equal(result.total.sessionTime, 2 * HOUR);
});

test('harness rows are ordered by open time, longest first', () => {
  const result = rollup([
    session({ harness: 'codex', from: BASE, to: BASE + 1 * HOUR }),
    session({ harness: 'claude-code', from: BASE, to: BASE + 5 * HOUR }),
    session({ harness: 'opencode', from: BASE, to: BASE + 3 * HOUR }),
  ]);

  assert.deepEqual(
    result.harnesses.map((h) => h.harness),
    ['claude-code', 'opencode', 'codex'],
  );
});

test('project rows are ordered by open time and list the harnesses used', () => {
  const result = rollup([
    session({ project: '/a', harness: 'claude-code', from: BASE, to: BASE + 1 * HOUR }),
    session({ project: '/b', harness: 'claude-code', from: BASE, to: BASE + 4 * HOUR }),
    session({ project: '/b', harness: 'codex', from: BASE + 5 * HOUR, to: BASE + 6 * HOUR }),
  ]);

  assert.deepEqual(
    result.projects.map((p) => p.project),
    ['/b', '/a'],
  );
  assert.deepEqual(result.projects[0]?.harnesses, ['claude-code', 'codex']);
  assert.equal(result.projects[0]?.open, 5 * HOUR);
});

test('busy and blocked time are unioned the same way as open time', () => {
  const result = rollup([
    session({
      from: BASE,
      to: BASE + 2 * HOUR,
      busy: [[BASE, BASE + HOUR]],
      blocked: [[BASE, BASE + 0.25 * HOUR]],
    }),
    session({
      from: BASE,
      to: BASE + 2 * HOUR,
      busy: [[BASE + 0.5 * HOUR, BASE + 1.5 * HOUR]],
      blocked: [[BASE + 0.1 * HOUR, BASE + 0.2 * HOUR]],
    }),
  ]);

  assert.equal(result.total.busy, 1.5 * HOUR);
  assert.equal(result.total.blocked, 0.25 * HOUR);
});

test('lastPlayed is the most recent session end', () => {
  const result = rollup([
    session({ from: BASE, to: BASE + HOUR }),
    session({ from: BASE + 10 * HOUR, to: BASE + 11 * HOUR }),
  ]);

  assert.equal(result.lastPlayed, BASE + 11 * HOUR);
});

test('a window clips sessions that straddle its edge', () => {
  const result = rollup(
    [session({ from: BASE - 2 * HOUR, to: BASE + 2 * HOUR })],
    [BASE, BASE + DAY],
  );

  assert.equal(result.total.open, 2 * HOUR);
});

test('a window excludes sessions that fall entirely outside it', () => {
  const result = rollup([session({ from: BASE - 5 * DAY, to: BASE - 5 * DAY + HOUR })], [
    BASE,
    BASE + DAY,
  ]);

  assert.equal(result.total.open, 0);
  assert.equal(result.total.sessions, 0);
  assert.deepEqual(result.harnesses, []);
});

test('a window clips busy time as well as open time', () => {
  const result = rollup(
    [
      session({
        from: BASE - HOUR,
        to: BASE + HOUR,
        busy: [[BASE - HOUR, BASE + 0.5 * HOUR]],
      }),
    ],
    [BASE, BASE + DAY],
  );

  assert.equal(result.total.busy, 0.5 * HOUR);
});

test('concurrency is the ratio of session time to wall clock', () => {
  const result = rollup([
    session({ from: BASE, to: BASE + HOUR }),
    session({ from: BASE, to: BASE + HOUR }),
    session({ from: BASE, to: BASE + HOUR }),
  ]);

  assert.equal(concurrency(result.total), 3);
});

test('concurrency of nothing is zero rather than infinity', () => {
  assert.equal(concurrency(rollup([]).total), 0);
});

test('stacked totals add overlapping sessions up instead of unioning them', () => {
  const result = rollup([
    session({ from: BASE, to: BASE + HOUR, busy: [[BASE, BASE + HOUR]] }),
    session({ from: BASE, to: BASE + HOUR, busy: [[BASE, BASE + HOUR]] }),
    session({ from: BASE, to: BASE + HOUR, busy: [[BASE, BASE + HOUR]] }),
  ]);

  assert.equal(measure(result.total, 'wallclock').open, HOUR);
  assert.equal(measure(result.total, 'stacked').open, 3 * HOUR);
  assert.equal(measure(result.total, 'wallclock').busy, HOUR);
  assert.equal(measure(result.total, 'stacked').busy, 3 * HOUR);
});

test('stacked blocked time is summed the same way', () => {
  const result = rollup([
    session({ from: BASE, to: BASE + HOUR, blocked: [[BASE, BASE + 0.5 * HOUR]] }),
    session({ from: BASE, to: BASE + HOUR, blocked: [[BASE, BASE + 0.5 * HOUR]] }),
  ]);

  assert.equal(measure(result.total, 'wallclock').blocked, 0.5 * HOUR);
  assert.equal(measure(result.total, 'stacked').blocked, HOUR);
});

test('with no overlap the two modes agree', () => {
  const result = rollup([
    session({ from: BASE, to: BASE + HOUR, busy: [[BASE, BASE + 0.5 * HOUR]] }),
    session({ from: BASE + 5 * HOUR, to: BASE + 6 * HOUR }),
  ]);

  assert.deepEqual(measure(result.total, 'stacked'), measure(result.total, 'wallclock'));
});

test('stacked totals are clipped by a window like every other total', () => {
  const result = rollup(
    [
      session({ from: BASE - 2 * HOUR, to: BASE + 2 * HOUR }),
      session({ from: BASE - 2 * HOUR, to: BASE + 2 * HOUR }),
    ],
    [BASE, BASE + DAY],
  );

  assert.equal(measure(result.total, 'stacked').open, 4 * HOUR);
});

test('harness and project rows carry stacked totals too', () => {
  const result = rollup([
    session({ project: '/a', from: BASE, to: BASE + HOUR }),
    session({ project: '/a', from: BASE, to: BASE + HOUR }),
  ]);

  assert.equal(measure(result.harnesses[0]!, 'stacked').open, 2 * HOUR);
  assert.equal(measure(result.projects[0]!, 'stacked').open, 2 * HOUR);
});
