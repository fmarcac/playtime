import test from 'node:test';
import assert from 'node:assert/strict';

import { renderDetail, renderLibrary } from './views.js';
import type { ViewContext } from './views.js';
import { rollup } from '../core/rollup.js';
import type { SessionRecord } from '../core/session.js';
import type { Harness } from '../core/events.js';
import type { LiveSnapshot } from '../store/live.js';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-07-25T18:00:00').getTime();

const CTX: ViewContext = { now: NOW, home: '/home/dev', width: 100, window: 'all' };

let counter = 0;

function session(options: {
  harness?: Harness;
  project?: string;
  hours: number;
  busyHours?: number;
  endsDaysAgo?: number;
  turns?: number;
}): SessionRecord {
  const end = NOW - (options.endsDaysAgo ?? 0) * 24 * HOUR;
  const start = end - options.hours * HOUR;
  return {
    id: `s${++counter}`,
    harness: options.harness ?? 'claude-code',
    project: options.project ?? '/home/dev/git/playtime',
    start,
    end,
    open: [[start, end]],
    busy: options.busyHours ? [[start, start + options.busyHours * HOUR]] : [],
    blocked: [],
    turns: options.turns ?? 0,
  };
}

function emptySnapshot(sessions: LiveSnapshot['sessions']): LiveSnapshot {
  const zero = { open: 0, busy: 0, blocked: 0, sessionTime: 0, sessions: 0, turns: 0 };
  return {
    v: 1,
    updatedAt: NOW,
    daemonPid: 1,
    tracking: [],
    sessions,
    today: zero,
    week: zero,
    allTime: zero,
  };
}

test('an empty library says so instead of printing an empty table', () => {
  const output = renderLibrary(rollup([]), null, CTX);

  assert.match(output, /PLAYTIME/);
  assert.match(output, /No playtime recorded yet/i);
});

test('the empty library points at doctor so the user can check the install', () => {
  assert.match(renderLibrary(rollup([]), null, CTX), /playtime doctor/);
});

test('each harness gets a row with its label and open time', () => {
  const output = renderLibrary(
    rollup([
      session({ harness: 'claude-code', hours: 10 }),
      session({ harness: 'codex', hours: 3, project: '/home/dev/git/other' }),
    ]),
    null,
    CTX,
  );

  assert.match(output, /Claude Code\s+10h 00m/);
  assert.match(output, /Codex\s+3h 00m/);
});

test('harness rows show busy time and its share of open time', () => {
  const output = renderLibrary(rollup([session({ hours: 10, busyHours: 4 })]), null, CTX);

  assert.match(output, /4h 00m/);
  assert.match(output, /40%/);
});

test('harness rows show how recently the harness was used', () => {
  const output = renderLibrary(
    rollup([session({ hours: 1 }), session({ harness: 'codex', hours: 1, endsDaysAgo: 3 })]),
    null,
    CTX,
  );

  assert.match(output, /today/);
  assert.match(output, /3 days ago/);
});

test('projects appear under an Hours used heading', () => {
  const output = renderLibrary(
    rollup([
      session({ project: '/home/dev/git/playtime', hours: 8 }),
      session({ project: '/home/dev/git/dashboard', hours: 5 }),
    ]),
    null,
    CTX,
  );

  assert.match(output, /Hours used/);
  assert.match(output, /~\/git\/playtime/);
  assert.match(output, /~\/git\/dashboard/);
});

test('the project with the most time is listed first', () => {
  const output = renderLibrary(
    rollup([
      session({ project: '/home/dev/small', hours: 2 }),
      session({ project: '/home/dev/big', hours: 9 }),
    ]),
    null,
    CTX,
  );

  assert.ok(output.indexOf('~/big') < output.indexOf('~/small'));
});

test('the footer reports deduplicated open time next to raw session time', () => {
  const output = renderLibrary(
    rollup([session({ hours: 4, turns: 10 }), session({ hours: 4, turns: 5 })]),
    null,
    CTX,
  );

  // Both sessions cover the same four hours, so the wall clock stays at four.
  assert.match(output, /4h 00m open/);
  assert.match(output, /15 turns/);
});

test('the footer names the concurrency multiplier when sessions overlapped', () => {
  const output = renderLibrary(
    rollup([session({ hours: 4 }), session({ hours: 4 })]),
    null,
    CTX,
  );

  assert.match(output, /2\.0. sessions deep/);
});

test('a live session is called out as now playing', () => {
  const live = emptySnapshot([
    {
      id: 'a',
      harness: 'claude-code',
      project: '/home/dev/git/playtime',
      startedAt: NOW - 2 * HOUR,
      open: 2 * HOUR,
      busy: 0,
      busyNow: false,
    },
  ]);

  const output = renderLibrary(rollup([session({ hours: 1 })]), live, CTX);

  assert.match(output, /now playing/i);
  assert.match(output, /~\/git\/playtime/);
});

test('a session whose agent is working right now says so', () => {
  const live = emptySnapshot([
    {
      id: 'a',
      harness: 'claude-code',
      project: '/home/dev/git/playtime',
      startedAt: NOW - 2 * HOUR,
      open: 2 * HOUR,
      busy: HOUR,
      busyNow: true,
    },
  ]);

  assert.match(renderLibrary(rollup([session({ hours: 1 })]), live, CTX), /working/i);
});

test('the header names the window being shown', () => {
  assert.match(renderLibrary(rollup([]), null, { ...CTX, window: 'week' }), /past 7 days/);
  assert.match(renderLibrary(rollup([]), null, { ...CTX, window: 'today' }), /today/);
});

test('a detail view leads with the title it was given', () => {
  const output = renderDetail('~/git/playtime', rollup([session({ hours: 6, busyHours: 2 })]), CTX);

  assert.match(output, /~\/git\/playtime/);
  assert.match(output, /6h 00m/);
});

test('a detail view breaks the time down by harness', () => {
  const output = renderDetail(
    '~/git/playtime',
    rollup([
      session({ harness: 'claude-code', hours: 6 }),
      session({ harness: 'codex', hours: 2, endsDaysAgo: 1 }),
    ]),
    CTX,
  );

  assert.match(output, /Claude Code/);
  assert.match(output, /Codex/);
});

test('a detail view with nothing in it says so', () => {
  assert.match(renderDetail('~/git/nothing', rollup([]), CTX), /No playtime recorded/i);
});
