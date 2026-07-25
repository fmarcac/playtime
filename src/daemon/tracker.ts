/**
 * The set of sessions the daemon believes are open, and the rules for closing
 * them. Pure: the clock and the process probe are both injected.
 */

import type { PlaytimeEvent } from '../core/events.js';
import { applyEvent, createSession, finalize, observeAlive } from '../core/session.js';
import type { SessionRecord, SessionState } from '../core/session.js';

export type AliveProbe = (pid: number, pidStart: number | null) => boolean;

export interface TrackerOptions {
  /** Liveness is interpolated across gaps no wider than this. */
  maxAdvanceMs: number;
  /** A session with no process to probe is closed after this much silence. */
  staleSessionMs: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  maxAdvanceMs: 30_000,
  staleSessionMs: 5 * 60_000,
};

export class Tracker {
  readonly #sessions = new Map<string, SessionState>();
  readonly #options: TrackerOptions;

  constructor(options: TrackerOptions = DEFAULT_TRACKER_OPTIONS) {
    this.#options = options;
  }

  restore(states: Iterable<SessionState>): void {
    for (const state of states) {
      if (!state.ended) this.#sessions.set(state.id, state);
    }
  }

  apply(event: PlaytimeEvent): void {
    const known = this.#sessions.get(event.sessionId);

    // A session we have never seen ending is nothing we can account for.
    if (!known && event.event === 'session_end') return;

    const base = known ? backfill(known, event) : createSession(event);
    this.#sessions.set(event.sessionId, applyEvent(base, event, this.#options.maxAdvanceMs));
  }

  /** Advances every session to `now`, returning the records of any that closed. */
  tick(now: number, isAlive: AliveProbe): SessionRecord[] {
    const closed: SessionRecord[] = [];

    for (const [id, state] of this.#sessions) {
      const reason = this.#closeReason(state, now, isAlive);

      if (reason !== null) {
        closed.push(finalize(state, state.lastAlive));
        this.#sessions.delete(id);
        continue;
      }

      // With no process to probe, only the session's own events prove liveness.
      if (state.pid !== null) {
        this.#sessions.set(id, observeAlive(state, now, this.#options.maxAdvanceMs));
      }
    }

    return closed;
  }

  #closeReason(state: SessionState, now: number, isAlive: AliveProbe): string | null {
    if (state.ended) return 'reported';
    if (state.pid !== null) {
      return isAlive(state.pid, state.pidStart) ? null : 'process gone';
    }
    return now - state.lastAlive > this.#options.staleSessionMs ? 'silent' : null;
  }

  /** Closes every remaining session, for a clean daemon shutdown. */
  closeAll(now: number): SessionRecord[] {
    const closed = [...this.#sessions.values()].map((state) =>
      finalize(state, Math.min(now, state.lastAlive)),
    );
    this.#sessions.clear();
    return closed;
  }

  live(): SessionState[] {
    return [...this.#sessions.values()];
  }

  get size(): number {
    return this.#sessions.size;
  }
}

/** Later events can carry identity the first one lacked, for example a pid. */
function backfill(state: SessionState, event: PlaytimeEvent): SessionState {
  const patched = { ...state };

  if (patched.pid === null && event.pid !== undefined) {
    patched.pid = event.pid;
    patched.pidStart = event.pidStart ?? null;
  }
  if (patched.project === 'unknown' && event.cwd !== undefined) {
    patched.project = event.cwd;
  }

  return patched;
}
