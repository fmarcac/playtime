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
import type { Settings } from '../core/settings.js';
import { windowFor } from '../core/window.js';
import { appendFile } from 'node:fs/promises';

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
  /** How often an open session is written to durable history before it closes. */
  checkpointEveryMs: number;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  tickMs: 15_000,
  maxAdvanceMs: 30_000,
  idleExitMs: 120_000,
  staleSessionMs: 5 * 60_000,
  checkpointEveryMs: 60_000,
};

export interface DaemonDeps {
  now(): number;
  isAlive: AliveProbe;
  pid?: number;
}

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Cadence overrides, mostly so the daemon can be driven quickly in tests and
 * tuned by anyone who wants finer or coarser sampling.
 *
 * The interpolation clamp follows the tick interval at 2x unless set outright,
 * so shortening the tick does not silently start excluding ordinary gaps.
 */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  settings?: Pick<Settings, 'daemon.tickMs' | 'daemon.idleExitMs'>,
): DaemonConfig {
  const tickMs =
    positiveNumber(env['PLAYTIME_TICK_MS']) ??
    settings?.['daemon.tickMs'] ??
    DEFAULT_DAEMON_CONFIG.tickMs;

  return {
    tickMs,
    maxAdvanceMs: positiveNumber(env['PLAYTIME_MAX_ADVANCE_MS']) ?? tickMs * 2,
    idleExitMs:
      positiveNumber(env['PLAYTIME_IDLE_EXIT_MS']) ??
      settings?.['daemon.idleExitMs'] ??
      DEFAULT_DAEMON_CONFIG.idleExitMs,
    staleSessionMs:
      positiveNumber(env['PLAYTIME_STALE_SESSION_MS']) ?? DEFAULT_DAEMON_CONFIG.staleSessionMs,
    checkpointEveryMs:
      positiveNumber(env['PLAYTIME_CHECKPOINT_MS']) ?? DEFAULT_DAEMON_CONFIG.checkpointEveryMs,
  };
}

export class Daemon {
  readonly #paths: Paths;
  readonly #config: DaemonConfig;
  readonly #deps: DaemonDeps;
  readonly #tracker: Tracker;
  readonly #history: SessionRecord[];
  #emptySince: number | null = null;
  #lastCheckpoint = 0;

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

  /**
   * One pass: ingest, probe, persist, snapshot.
   *
   * A tracker that dies because one write failed is worse than useless, since
   * every hour it was holding goes with it. Failures are logged and the loop
   * carries on, and the next checkpoint repairs whatever did not reach disk.
   */
  async tick(): Promise<SessionRecord[]> {
    const now = this.#deps.now();
    let closed: SessionRecord[] = [];

    try {
      const drained = await drainInbox(this.#paths);
      for (const envelope of drained.items) {
        const event = normalizeEnvelope(envelope);
        if (event) this.#tracker.apply(event);
      }

      closed = this.#tracker.tick(now, this.#deps.isAlive);
      await this.#record(closed);
      await this.#checkpoint(now);
    } catch (error) {
      await this.#report('tick', error);
    }

    this.#emptySince = this.#tracker.size > 0 ? null : (this.#emptySince ?? now);

    try {
      await this.#writeSnapshot(now);
    } catch (error) {
      await this.#report('snapshot', error);
    }

    return closed;
  }

  /**
   * Writes what open sessions have accrued so far.
   *
   * Without this, a session's hours live only in the snapshot until it closes,
   * so losing that one file loses an entire day of a long session.
   */
  async #checkpoint(now: number): Promise<void> {
    if (now - this.#lastCheckpoint < this.#config.checkpointEveryMs) return;
    this.#lastCheckpoint = now;

    const open = this.#tracker.live().map((state) => finalize(state, state.lastAlive));
    if (open.length > 0) await appendSessions(this.#paths, open);
  }

  async #report(stage: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await appendFile(this.#paths.log, `${new Date(this.#deps.now()).toISOString()} ${stage}: ${message}\n`, 'utf8').catch(
      () => undefined,
    );
  }

  get shouldExit(): boolean {
    if (this.#emptySince === null) return false;
    return this.#deps.now() - this.#emptySince > this.#config.idleExitMs;
  }

  get trackedCount(): number {
    return this.#tracker.size;
  }

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

    // A session still open may already have a checkpoint sitting in history from
    // an earlier daemon. The live copy is the newer of the two, so drop the
    // stored one rather than counting the session twice.
    const superseded = new Set(provisional.map((record) => `${record.id}#${record.start}`));
    const settled = this.#history.filter(
      (record) => !superseded.has(`${record.id}#${record.start}`),
    );

    const everything = [...settled, ...provisional];

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

/**
 * Waits out the gap between ticks.
 *
 * The timer is deliberately not unref'd: in a standalone daemon it is the only
 * thing holding the event loop open, and unref'ing it makes the process exit
 * after a single tick. It has to be abortable too, otherwise a shutdown signal
 * would sit unnoticed until the current interval elapsed.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };

    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

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
    await sleep(config.tickMs, signal);
  }

  await daemon.shutdown();
}
