import test from 'node:test';
import assert from 'node:assert/strict';

import { applyEvent, createSession, finalize, observeAlive } from './session.js';
import type { SessionState } from './session.js';
import { total } from './intervals.js';
import type { EventKind, PlaytimeEvent } from './events.js';

const T0 = 1_753_440_000_000;
const SECOND = 1000;
const TICK = 15 * SECOND;
const MAX_ADVANCE = 2 * TICK;

function event(kind: EventKind, offsetMs: number, extra: Partial<PlaytimeEvent> = {}): PlaytimeEvent {
  return {
    ts: T0 + offsetMs,
    harness: 'claude-code',
    event: kind,
    sessionId: 'sess_1',
    pid: 4242,
    pidStart: 99,
    cwd: '/home/dev/work/api',
    ...extra,
  };
}

function started(): SessionState {
  return createSession(event('session_start', 0));
}

/** Applies a sequence of events, so tests read as a timeline. */
function play(state: SessionState, events: PlaytimeEvent[]): SessionState {
  return events.reduce((acc, next) => applyEvent(acc, next), state);
}

/** Ticks the daemon clock forward in whole intervals, as the real daemon does. */
function tickTo(state: SessionState, offsetMs: number): SessionState {
  let current = state;
  for (let at = current.lastAlive + TICK; at < T0 + offsetMs; at += TICK) {
    current = observeAlive(current, at, MAX_ADVANCE);
  }
  return observeAlive(current, T0 + offsetMs, MAX_ADVANCE);
}

test('createSession records harness, project and process identity', () => {
  const state = started();

  assert.equal(state.id, 'sess_1');
  assert.equal(state.harness, 'claude-code');
  assert.equal(state.project, '/home/dev/work/api');
  assert.equal(state.pid, 4242);
  assert.equal(state.pidStart, 99);
  assert.equal(state.startedAt, T0);
  assert.equal(state.ended, false);
});

test('a session with no observations yet has no open time', () => {
  assert.equal(total(started().open), 0);
});

test('observing the process alive extends open time', () => {
  const state = observeAlive(started(), T0 + TICK, MAX_ADVANCE);

  assert.equal(total(state.open), TICK);
  assert.equal(state.lastAlive, T0 + TICK);
});

test('consecutive observations accumulate into one interval', () => {
  let state = started();
  state = observeAlive(state, T0 + TICK, MAX_ADVANCE);
  state = observeAlive(state, T0 + 2 * TICK, MAX_ADVANCE);

  assert.equal(state.open.length, 1);
  assert.equal(total(state.open), 2 * TICK);
});

test('a gap longer than the clamp is excluded rather than interpolated', () => {
  let state = started();
  state = observeAlive(state, T0 + TICK, MAX_ADVANCE);

  // The laptop slept for eight hours: the daemon never observed anything.
  const wake = T0 + TICK + 8 * 60 * 60 * SECOND;
  state = observeAlive(state, wake, MAX_ADVANCE);
  state = observeAlive(state, wake + TICK, MAX_ADVANCE);

  assert.equal(state.open.length, 2);
  assert.equal(total(state.open), 2 * TICK);
});

test('observations after the session ended are ignored', () => {
  let state = play(started(), [event('session_end', TICK)]);
  state = observeAlive(state, T0 + 10 * TICK, MAX_ADVANCE);

  assert.equal(total(state.open), TICK);
});

test('session_end closes open time at the reported moment', () => {
  const state = play(started(), [event('session_end', 7 * SECOND)]);

  assert.equal(state.ended, true);
  assert.equal(total(state.open), 7 * SECOND);
});

test('a completed turn becomes one busy interval', () => {
  const state = play(started(), [event('turn_start', SECOND), event('turn_end', 31 * SECOND)]);

  assert.deepEqual(state.busy, [[T0 + SECOND, T0 + 31 * SECOND]]);
  assert.equal(state.turns, 1);
});

test('two turns are counted and recorded separately', () => {
  const state = play(started(), [
    event('turn_start', 1 * SECOND),
    event('turn_end', 5 * SECOND),
    event('turn_start', 20 * SECOND),
    event('turn_end', 30 * SECOND),
  ]);

  assert.equal(state.turns, 2);
  assert.equal(total(state.busy), 14 * SECOND);
});

test('a repeated turn_start keeps the earliest start and does not double the count', () => {
  const state = play(started(), [
    event('turn_start', 1 * SECOND),
    event('turn_start', 4 * SECOND),
    event('turn_end', 10 * SECOND),
  ]);

  assert.equal(state.turns, 1);
  assert.deepEqual(state.busy, [[T0 + SECOND, T0 + 10 * SECOND]]);
});

test('a turn_end with no matching turn_start is ignored', () => {
  const state = play(started(), [event('turn_end', 10 * SECOND)]);

  assert.deepEqual(state.busy, []);
  assert.equal(state.turns, 0);
});

test('an event timestamped before the open turn does not create an inverted interval', () => {
  const state = play(started(), [event('turn_start', 10 * SECOND), event('turn_end', 4 * SECOND)]);

  assert.deepEqual(state.busy, []);
});

test('a permission wait becomes a blocked interval', () => {
  const state = play(started(), [
    event('turn_start', 1 * SECOND),
    event('blocked_start', 5 * SECOND),
    event('blocked_end', 20 * SECOND),
    event('turn_end', 30 * SECOND),
  ]);

  assert.equal(total(state.blocked), 15 * SECOND);
});

test('finalize closes a turn that was still running', () => {
  let state = play(started(), [event('turn_start', 5 * SECOND)]);
  state = tickTo(state, 60 * SECOND);

  const record = finalize(state, T0 + 60 * SECOND);

  assert.equal(total(record.busy), 55 * SECOND);
});

test('finalize clips busy time to observed open time', () => {
  // The turn is reported as running past the last confirmed-alive moment.
  let state = play(started(), [event('turn_start', 0)]);
  state = observeAlive(state, T0 + 10 * SECOND, MAX_ADVANCE);
  state = play(state, [event('turn_end', 90 * SECOND)]);

  const record = finalize(state, T0 + 10 * SECOND);

  assert.equal(total(record.open), 10 * SECOND);
  assert.equal(total(record.busy), 10 * SECOND);
});

test('finalize clips blocked time to busy time', () => {
  let state = play(started(), [
    event('blocked_start', 0),
    event('turn_start', 5 * SECOND),
    event('turn_end', 10 * SECOND),
    event('blocked_end', 20 * SECOND),
  ]);
  state = observeAlive(state, T0 + 30 * SECOND, MAX_ADVANCE);

  const record = finalize(state, T0 + 30 * SECOND);

  assert.equal(total(record.busy), 5 * SECOND);
  assert.equal(total(record.blocked), 5 * SECOND);
});

test('finalize reports the span from first start to last observed moment', () => {
  const state = tickTo(started(), 45 * SECOND);

  const record = finalize(state, T0 + 45 * SECOND);

  assert.equal(record.start, T0);
  assert.equal(record.end, T0 + 45 * SECOND);
  assert.equal(record.id, 'sess_1');
  assert.equal(record.project, '/home/dev/work/api');
});

test('finalize never reports more busy time than open time', () => {
  let state = play(started(), [event('turn_start', 0)]);
  state = observeAlive(state, T0 + 5 * SECOND, MAX_ADVANCE);
  const wake = T0 + 5 * SECOND + 4 * 60 * 60 * SECOND;
  state = observeAlive(state, wake, MAX_ADVANCE);
  state = observeAlive(state, wake + 5 * SECOND, MAX_ADVANCE);

  const record = finalize(state, wake + 5 * SECOND);

  assert.ok(total(record.busy) <= total(record.open));
});
