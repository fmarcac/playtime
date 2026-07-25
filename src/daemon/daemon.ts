/**
 * The daemon loop: drain the inbox, probe liveness, persist what closed, and
 * refresh the snapshot the status line reads. All IO lives here; the clock and
 * the process probe are injected so the whole loop is testable without sleeping.
 */

import { normalizeEnvelope } from '../adapters/normalize.js';
import { total } from '../core/intervals.js';
import { rollup } from '../core/rollup.js';
import { finalize } from '../core/session.js';
import type { SessionRecord, SessionState } from '../core/session.js';
import { windowFor } from '../core/window.js';
import { drainInbox } from '../store/inbox.js';
import { readLive, writeLive } from '../store/live.js';
import type { LiveSessionSummary, LiveSnapshot } from '../store/live.js';
import type { Paths } from '../store/paths.js';
import { appendSessions, readSessions } from '../store/sessions.js';
import { Tracker } from './tracker.js';
import type { AliveProbe } from './tracker.js';

export interface DaemonConfig {
  tickMs: number;
  maxAdvanceMs: number;
  idleExitMs: number;
  staleSessionMs: number;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  tickMs: 15_000,
  maxAdvanceMs: 30_000,
  idleExitMs: 120_000,
  staleSessionMs: 5 * 60_000,
};

export interface DaemonDeps {
  now(): number;
  isAlive: AliveProbe;
  pid?: number;
}

export class Daemon {
  readonly #paths: Paths;
  readonly #config: DaemonConfig;
  readonly #deps: DaemonDeps;
  readonly #tracker: Tracker;
  readonly #history: SessionRecord[];
  #emptySince: number | null = null;

  private constructor(
    paths: Paths,
    config: DaemonConfig,
    deps: DaemonDeps,
    tracker: Tracker,
    history: SessionRecord[],
  ) {
    this.#paths = paths;
    this.#config = config;
    this.#deps = deps;
    this.#tracker = tracker;
    this.#history = history;
  }

  static async start(paths: Paths, config: DaemonConfig, deps: DaemonDeps): Promise<Daemon> {
    const history = (await readSessions(paths)).items;

    const tracker = new Tracker({
      maxAdvanceMs: config.maxAdvanceMs,
      staleSessionMs: config.staleSessionMs,
    });

    // Adopt whatever the previous daemon was tracking when it stopped. Their
    // lastAlive is untouched, so the outage itself is never credited.
    const checkpoint = await readLive(paths);
    if (checkpoint) tracker.restore(checkpoint.tracking);

    return new Daemon(paths, config, deps, tracker, history);
  }

  /** One pass: ingest, probe, persist, snapshot. */
  async tick(): Promise<SessionRecord[]> {
    const now = this.#deps.now();

    const drained = await drainInbox(this.#paths);
    for (const envelope of drained.items) {
      const event = normalizeEnvelope(envelope);
      if (event) this.#tracker.apply(event);
    }

    const closed = this.#tracker.tick(now, this.#deps.isAlive);
    await this.#record(closed);

    this.#emptySince = this.#tracker.size > 0 ? null : (this.#emptySince ?? now);
    await this.#writeSnapshot(now);

    return closed;
  }

  /** True once nothing has been open for longer than the idle timeout. */
  get shouldExit(): boolean {
    if (this.#emptySince === null) return false;
    return this.#deps.now() - this.#emptySince > this.#config.idleExitMs;
  }

  get trackedCount(): number {
    return this.#tracker.size;
  }

  /** Closes and flushes everything still open, for a clean shutdown. */
  async shutdown(): Promise<void> {
    const now = this.#deps.now();
    await this.#record(this.#tracker.closeAll(now));
    await this.#writeSnapshot(now);
  }

  async #record(closed: readonly SessionRecord[]): Promise<void> {
    if (closed.length === 0) return;
    await appendSessions(this.#paths, closed);
    this.#history.push(...closed);
  }

  async #writeSnapshot(now: number): Promise<void> {
    const tracking = this.#tracker.live();

    // Live sessions are finalized at their last confirmed-alive moment, never at
    // `now`, so an unresponsive harness cannot inflate the reported totals.
    const provisional = tracking.map((state) => finalize(state, state.lastAlive));
    const everything = [...this.#history, ...provisional];

    const snapshot: LiveSnapshot = {
      v: 1,
      updatedAt: now,
      daemonPid: this.#deps.pid ?? null,
      tracking,
      sessions: tracking.map((state, index) => summarize(state, provisional[index])),
      today: rollup(everything, windowFor('today', now)).total,
      week: rollup(everything, windowFor('week', now)).total,
      allTime: rollup(everything).total,
    };

    await writeLive(this.#paths, snapshot);
  }
}

function summarize(state: SessionState, record: SessionRecord | undefined): LiveSessionSummary {
  return {
    id: state.id,
    harness: state.harness,
    project: state.project,
    startedAt: state.startedAt,
    open: total(record?.open ?? []),
    busy: total(record?.busy ?? []),
    busyNow: state.openTurnAt !== null,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/** Runs until the daemon goes idle or the caller aborts. */
export async function runDaemon(
  paths: Paths,
  config: DaemonConfig,
  deps: DaemonDeps,
  signal?: AbortSignal,
): Promise<void> {
  const daemon = await Daemon.start(paths, config, deps);

  while (!signal?.aborted) {
    await daemon.tick();
    if (daemon.shouldExit) break;
    await sleep(config.tickMs);
  }

  await daemon.shutdown();
}
