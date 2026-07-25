/**
 * The per-session fold from lifecycle events plus liveness observations to a
 * finished record. Pure: the daemon owns the clock and the process probing, this
 * module owns the arithmetic.
 */

import { intersect, normalize } from './intervals.js';
import type { Interval } from './intervals.js';
import type { Harness, PlaytimeEvent } from './events.js';

/**
 * Liveness between two observations is interpolated only when they are close
 * together. A wider gap means the machine slept or the daemon was not running,
 * and that time is excluded rather than guessed at.
 */
export const DEFAULT_MAX_ADVANCE_MS = 30_000;

export interface SessionState {
  id: string;
  harness: Harness;
  project: string;
  pid: number | null;
  pidStart: number | null;
  startedAt: number;
  /** Last moment the harness process was confirmed running. */
  lastAlive: number;
  open: Interval[];
  busy: Interval[];
  blocked: Interval[];
  openTurnAt: number | null;
  openBlockAt: number | null;
  turns: number;
  ended: boolean;
}

export interface SessionRecord {
  id: string;
  harness: Harness;
  project: string;
  start: number;
  end: number;
  open: Interval[];
  busy: Interval[];
  blocked: Interval[];
  turns: number;
}

export function createSession(event: PlaytimeEvent): SessionState {
  return {
    id: event.sessionId,
    harness: event.harness,
    project: event.cwd ?? 'unknown',
    pid: event.pid ?? null,
    pidStart: event.pidStart ?? null,
    startedAt: event.ts,
    lastAlive: event.ts,
    open: [[event.ts, event.ts]],
    busy: [],
    blocked: [],
    openTurnAt: null,
    openBlockAt: null,
    turns: 0,
    ended: false,
  };
}

/**
 * Records that the harness process was running at `now`, extending the current
 * open segment. A gap wider than `maxAdvanceMs` starts a fresh segment instead,
 * so unobserved time is never credited.
 */
export function observeAlive(
  state: SessionState,
  now: number,
  maxAdvanceMs: number = DEFAULT_MAX_ADVANCE_MS,
): SessionState {
  if (state.ended) return state;
  if (!Number.isFinite(now) || now <= state.lastAlive) return state;

  const open = [...state.open];
  const current = open[open.length - 1];

  if (current && now - state.lastAlive <= maxAdvanceMs) {
    open[open.length - 1] = [current[0], now];
  } else {
    open.push([now, now]);
  }

  return { ...state, open, lastAlive: now };
}

export function applyEvent(
  state: SessionState,
  event: PlaytimeEvent,
  maxAdvanceMs: number = DEFAULT_MAX_ADVANCE_MS,
): SessionState {
  // Any event from a session is itself proof the harness was alive at that moment.
  const alive = observeAlive(state, event.ts, maxAdvanceMs);

  switch (event.event) {
    case 'session_start':
      return alive;

    case 'session_end':
      return { ...alive, ended: true };

    case 'turn_start':
      if (alive.openTurnAt !== null) return alive;
      return { ...alive, openTurnAt: event.ts, turns: alive.turns + 1 };

    case 'turn_end':
      return { ...alive, busy: closeSpan(alive.busy, alive.openTurnAt, event.ts), openTurnAt: null };

    case 'blocked_start':
      if (alive.openBlockAt !== null) return alive;
      return { ...alive, openBlockAt: event.ts };

    case 'blocked_end':
      return {
        ...alive,
        blocked: closeSpan(alive.blocked, alive.openBlockAt, event.ts),
        openBlockAt: null,
      };

    default:
      return alive;
  }
}

/** Appends `[openedAt, closedAt)`, ignoring orphan and out-of-order closes. */
function closeSpan(spans: Interval[], openedAt: number | null, closedAt: number): Interval[] {
  if (openedAt === null || closedAt <= openedAt) return spans;
  return [...spans, [openedAt, closedAt]];
}

/**
 * Produces the durable record. Spans still open are closed at `at`, then busy is
 * clipped to observed open time and blocked to busy, so no view can ever report
 * the agent working while the harness was not running.
 */
export function finalize(state: SessionState, at: number): SessionRecord {
  const settled = observeAlive(state, at);

  const open = normalize(settled.open);
  const busy = intersect(closeSpan(settled.busy, settled.openTurnAt, at), open);
  const blocked = intersect(closeSpan(settled.blocked, settled.openBlockAt, at), busy);

  return {
    id: settled.id,
    harness: settled.harness,
    project: settled.project,
    start: settled.startedAt,
    end: settled.lastAlive,
    open,
    busy,
    blocked,
    turns: settled.turns,
  };
}
