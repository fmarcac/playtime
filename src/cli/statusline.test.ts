import test from 'node:test';
import assert from 'node:assert/strict';

import { renderStatusline, statuslineJson } from './statusline.js';
import type { LiveSnapshot } from '../store/live.js';
import type { Totals } from '../core/rollup.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function totals(partial: Partial<Totals> = {}): Totals {
  return {
    open: 0,
    busy: 0,
    blocked: 0,
    sessionTime: 0,
    busyStacked: 0,
    blockedStacked: 0,
    sessions: 0,
    turns: 0,
    ...partial,
  };
}

function snapshot(partial: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    v: 1,
    updatedAt: 1_753_440_000_000,
    daemonPid: 123,
    tracking: [],
    sessions: [],
    today: totals({ open: 4 * HOUR + 12 * MINUTE, busy: HOUR + 7 * MINUTE, sessions: 3, turns: 57 }),
    week: totals({ open: 21 * HOUR }),
    allTime: totals({ open: 412 * HOUR + 18 * MINUTE, turns: 2481 }),
    ...partial,
  };
}

test('no snapshot renders nothing, so a status line shows no error', () => {
  assert.equal(renderStatusline(null), '');
});

test('the default format labels both numbers rather than using a glyph', () => {
  assert.equal(renderStatusline(snapshot()), '4h12m open · 1h07m busy');
});

test('a custom format substitutes the tokens it names', () => {
  const result = renderStatusline(snapshot(), { format: '{open} open, {busy} busy' });

  assert.equal(result, '4h12m open, 1h07m busy');
});

test('the all-time total is available as its own token', () => {
  assert.equal(renderStatusline(snapshot(), { format: '{total}' }), '412h18m');
});

test('the session count and turn count come from the selected window', () => {
  assert.equal(renderStatusline(snapshot(), { format: '{sessions}/{turns}' }), '3/57');
});

test('the window option repoints the bare tokens', () => {
  assert.equal(renderStatusline(snapshot(), { format: '{open}', window: 'week' }), '21h00m');
});

test('an unknown token is left alone rather than blanked out', () => {
  assert.equal(renderStatusline(snapshot(), { format: '{nope}' }), '{nope}');
});

test('the current project is shown when exactly one session is live', () => {
  const withSession = snapshot({
    sessions: [
      {
        id: 'a',
        harness: 'claude-code',
        project: '/home/dev/work/api',
        startedAt: 0,
        open: 2 * HOUR,
        busy: 0,
        busyNow: false,
      },
    ],
  });

  assert.equal(renderStatusline(withSession, { format: '{project}' }), 'api');
});

test('the project token is blank when nothing is live', () => {
  assert.equal(renderStatusline(snapshot(), { format: '{project}' }), '');
});

test('a narrow terminal falls back to open time alone, still labelled', () => {
  assert.equal(renderStatusline(snapshot(), { width: 12 }), '4h12m open');
});

test('a wide terminal keeps the full format', () => {
  assert.equal(renderStatusline(snapshot(), { width: 200 }), '4h12m open · 1h07m busy');
});

test('json output exposes every window', () => {
  const parsed = JSON.parse(statuslineJson(snapshot())) as Record<string, unknown>;

  assert.equal((parsed['today'] as Totals).open, 4 * HOUR + 12 * MINUTE);
  assert.equal((parsed['allTime'] as Totals).turns, 2481);
  assert.equal(parsed['live'], 0);
});

test('json output for a missing snapshot is still valid json', () => {
  const parsed = JSON.parse(statuslineJson(null)) as Record<string, unknown>;

  assert.equal(parsed['available'], false);
});

test('stacked mode reports summed time rather than deduplicated time', () => {
  const stacked = snapshot({
    today: totals({ open: HOUR, busy: 30 * MINUTE, sessionTime: 3 * HOUR, busyStacked: 90 * MINUTE }),
  });

  assert.equal(renderStatusline(stacked, { count: 'wallclock' }), '1h00m open · 30m busy');
  assert.equal(renderStatusline(stacked, { count: 'stacked' }), '3h00m open · 1h30m busy');
});
