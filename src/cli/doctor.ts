/** Health checks, so a silent tracker can be diagnosed rather than guessed at. */

import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

import { HARNESSES, HARNESS_LABELS } from '../core/events.js';
import { formatDuration, formatRelative } from '../core/format.js';
import { processIsAlive } from '../daemon/proc.js';
import { readLive } from '../store/live.js';
import { readLock } from '../store/lock.js';
import type { Paths } from '../store/paths.js';
import { readSessions } from '../store/sessions.js';
import { EMIT_MARKER } from './hooks-config.js';
import { installTarget } from './install.js';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

/** A snapshot older than this means the daemon stopped without saying so. */
const STALE_SNAPSHOT_MS = 90_000;

async function checkDataDirectory(paths: Paths): Promise<Check> {
  try {
    await access(paths.home, constants.W_OK);
    return { name: 'data directory', status: 'ok', detail: paths.home };
  } catch {
    return {
      name: 'data directory',
      status: 'warn',
      detail: `${paths.home} does not exist yet, it is created on first use`,
    };
  }
}

async function checkDaemon(paths: Paths, now: number): Promise<Check> {
  const lock = await readLock(paths);
  const live = await readLive(paths);

  if (!lock) {
    return {
      name: 'daemon',
      status: 'warn',
      detail: 'not running, it starts automatically when a harness session opens',
    };
  }

  if (!processIsAlive(lock.pid)) {
    return {
      name: 'daemon',
      status: 'warn',
      detail: `stale lock for pid ${lock.pid}, the next hook will start a fresh daemon`,
    };
  }

  const age = live ? now - live.updatedAt : Infinity;
  if (age > STALE_SNAPSHOT_MS) {
    return {
      name: 'daemon',
      status: 'fail',
      detail: `pid ${lock.pid} is running but has not ticked for ${formatDuration(age)}`,
    };
  }

  return { name: 'daemon', status: 'ok', detail: `pid ${lock.pid}, last tick ${formatDuration(age)} ago` };
}

async function checkHooks(): Promise<Check[]> {
  return Promise.all(
    HARNESSES.map(async (harness) => {
      const target = installTarget(harness);
      const name = `${HARNESS_LABELS[harness]} hooks`;

      const contents = await readFile(target, 'utf8').catch(() => null);
      if (contents === null) {
        return { name, status: 'warn' as const, detail: `no config at ${target}` };
      }
      if (!contents.includes(EMIT_MARKER)) {
        return {
          name,
          status: 'warn' as const,
          detail: `not wired up, run \`playtime install --harness ${harness}\``,
        };
      }

      return { name, status: 'ok' as const, detail: target };
    }),
  );
}

async function checkHistory(paths: Paths, now: number): Promise<Check> {
  const stored = await readSessions(paths);

  if (stored.corrupt > 0) {
    return {
      name: 'history',
      status: 'warn',
      detail: `${stored.items.length} sessions, ${stored.corrupt} unreadable lines skipped`,
    };
  }
  if (stored.items.length === 0) {
    return { name: 'history', status: 'warn', detail: 'no sessions recorded yet' };
  }

  const latest = Math.max(...stored.items.map((record) => record.end));
  return {
    name: 'history',
    status: 'ok',
    detail: `${stored.items.length} sessions, most recent ${formatRelative(latest, now)}`,
  };
}

async function checkInbox(paths: Paths): Promise<Check> {
  const size = await stat(paths.inbox).then(
    (info) => info.size,
    () => 0,
  );

  // The daemon drains every tick, so a large inbox means nothing is draining it.
  if (size > 512 * 1024) {
    return {
      name: 'inbox',
      status: 'fail',
      detail: `${Math.round(size / 1024)} KB of undrained events, the daemon is not running`,
    };
  }

  return { name: 'inbox', status: 'ok', detail: size === 0 ? 'empty' : `${size} bytes pending` };
}

export async function runDoctor(paths: Paths, now: number): Promise<Check[]> {
  return [
    await checkDataDirectory(paths),
    await checkDaemon(paths, now),
    ...(await checkHooks()),
    await checkHistory(paths, now),
    await checkInbox(paths),
  ];
}

const SYMBOLS: Record<Check['status'], string> = { ok: '✓', warn: '!', fail: '✗' };

export function renderDoctor(checks: readonly Check[]): string {
  const width = checks.reduce((max, check) => Math.max(max, check.name.length), 0);

  const lines = checks.map(
    (check) => `  ${SYMBOLS[check.status]} ${check.name.padEnd(width)}  ${check.detail}`,
  );

  return `PLAYTIME DOCTOR\n\n${lines.join('\n')}\n`;
}
