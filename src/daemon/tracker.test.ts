import test from 'node:test';
import assert from 'node:assert/strict';

import { Tracker } from './tracker.js';
import type { AliveProbe } from './tracker.js';
import { total } from '../core/intervals.js';
import type { EventKind, PlaytimeEvent } from '../core/events.js';

const T0 = 1_753_440_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const TICK = 15 * SECOND;

const OPTIONS = { maxAdvanceMs: 2 * TICK, staleSessionMs: 5 * MINUTE };

const ALWAYS_ALIVE: AliveProbe = () => true;
const NEVER_ALIVE: AliveProbe = () => false;

function event(kind: EventKind, offsetMs: number, extra: Partial<PlaytimeEvent> = {}): PlaytimeEvent {
  return {
    ts: T0 + offsetMs,
    harness: 'claude-code',
    event: kind,
    sessionId: 'sess_1',
    pid: 4242,
    pidStart: 99,
    cwd: '/home/dev/git/playtime',
    ...extra,
  };
}

test('a session_start opens a tracked session', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0));

  assert.equal(tracker.size, 1);
  assert.equal(tracker.live()[0]?.project, '/home/dev/git/playtime');
});

test('ticking accrues open time while the process is alive', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0));

  assert.deepEqual(tracker.tick(T0 + TICK, ALWAYS_ALIVE), []);
  assert.deepEqual(tracker.tick(T0 + 2 * TICK, ALWAYS_ALIVE), []);

  assert.equal(total(tracker.live()[0]?.open ?? []), 2 * TICK);
});

test('a dead process closes the session at the last confirmed-alive moment', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0));
  tracker.tick(T0 + TICK, ALWAYS_ALIVE);

  const closed = tracker.tick(T0 + 2 * TICK, NEVER_ALIVE);

  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.end, T0 + TICK);
  assert.equal(total(closed[0]?.open ?? []), TICK);
  assert.equal(tracker.size, 0);
});

test('a closed session is reported once and then forgotten', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0));
  tracker.tick(T0 + TICK, NEVER_ALIVE);

  assert.deepEqual(tracker.tick(T0 + 2 * TICK, NEVER_ALIVE), []);
});

test('a reported session_end closes the session on the next tick', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0));
  tracker.apply(event('session_end', 10 * SECOND));

  const closed = tracker.tick(T0 + TICK, ALWAYS_ALIVE);

  assert.equal(closed.length, 1);
  assert.equal(total(closed[0]?.open ?? []), 10 * SECOND);
});

test('a pid recycled by an unrelated process does not keep the session alive', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0));
  tracker.tick(T0 + TICK, ALWAYS_ALIVE);

  const sameKernelPidDifferentProcess: AliveProbe = (_pid, pidStart) => pidStart === 12345;
  const closed = tracker.tick(T0 + 2 * TICK, sameKernelPidDifferentProcess);

  assert.equal(closed.length, 1);
});

test('sessions are tracked independently', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0));
  tracker.apply(event('session_start', 0, { sessionId: 'sess_2', pid: 5555, cwd: '/other' }));

  const onlyFirstAlive: AliveProbe = (pid) => pid === 4242;
  const closed = tracker.tick(T0 + TICK, onlyFirstAlive);

  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.id, 'sess_2');
  assert.equal(tracker.size, 1);
});

test('an event for an unknown session starts tracking it', () => {
  // The daemon was started midway through an existing session.
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('turn_start', 0));

  assert.equal(tracker.size, 1);
  assert.equal(tracker.live()[0]?.turns, 1);
});

test('a session_end for an unknown session is ignored', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_end', 0));

  assert.equal(tracker.size, 0);
});

test('a later event fills in a pid the first event did not carry', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('turn_start', 0, { pid: undefined, pidStart: undefined }));
  tracker.apply(event('turn_end', SECOND));

  assert.equal(tracker.live()[0]?.pid, 4242);
});

test('a session with no process to probe accrues time only from its own events', () => {
  const tracker = new Tracker(OPTIONS);
  const noPid = { pid: undefined, pidStart: undefined };
  tracker.apply(event('session_start', 0, noPid));
  tracker.apply(event('turn_start', 10 * SECOND, noPid));

  tracker.tick(T0 + 60 * SECOND, ALWAYS_ALIVE);

  assert.equal(total(tracker.live()[0]?.open ?? []), 10 * SECOND);
});

test('a session with no process is closed once it goes silent', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0, { pid: undefined, pidStart: undefined }));

  assert.deepEqual(tracker.tick(T0 + 4 * MINUTE, ALWAYS_ALIVE), []);

  const closed = tracker.tick(T0 + 6 * MINUTE, ALWAYS_ALIVE);

  assert.equal(closed.length, 1);
});

test('closeAll finalizes everything still open', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0));
  tracker.apply(event('session_start', 0, { sessionId: 'sess_2' }));
  tracker.tick(T0 + TICK, ALWAYS_ALIVE);

  const closed = tracker.closeAll(T0 + TICK);

  assert.equal(closed.length, 2);
  assert.equal(tracker.size, 0);
});

test('busy time survives the session being closed by process death', () => {
  const tracker = new Tracker(OPTIONS);
  tracker.apply(event('session_start', 0));
  tracker.apply(event('turn_start', SECOND));
  tracker.apply(event('turn_end', 6 * SECOND));
  tracker.tick(T0 + TICK, ALWAYS_ALIVE);

  const closed = tracker.tick(T0 + 2 * TICK, NEVER_ALIVE);

  assert.equal(total(closed[0]?.busy ?? []), 5 * SECOND);
  assert.equal(closed[0]?.turns, 1);
});
