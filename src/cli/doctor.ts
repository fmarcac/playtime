/** Health checks, so a silent tracker can be diagnosed rather than guessed at. */

import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

import { HARNESSES, HARNESS_LABELS } from '../core/events.js';
import type { Harness } from '../core/events.js';
import { formatDuration, formatRelative } from '../core/format.js';
import { processIsAlive } from '../daemon/proc.js';
import { readLive } from '../store/live.js';
import { readLock } from '../store/lock.js';
import type { Paths } from '../store/paths.js';
import { inspectSessions } from '../store/repair.js';
import type { RepairReport } from '../store/repair.js';
import { installTarget, wiringFor } from './install.js';

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

/**
 * The path a harness is actually pointed at. Config that names some other copy
 * of Playtime is the failure mode behind a tracker that quietly stops: the
 * package moved, and the hook kept calling where it used to be.
 */
export function referencedPath(contents: string, harness: Harness): string | null {
  // A hook command is a string inside a JSON string, so the quotes around the
  // path are backslash-escaped and matching on them finds nothing. Match the
  // path itself: everything up to emit.sh that cannot be part of the quoting.
  const pattern = harness === 'opencode' ? /from\s+"([^"]+)"/ : /([^"\\\s]*emit\.sh)/;
  return pattern.exec(contents)?.[1] ?? null;
}

async function checkHarness(harness: Harness): Promise<Check> {
  const target = installTarget(harness);
  const kind = harness === 'opencode' ? 'plugin' : 'hooks';
  const name = `${HARNESS_LABELS[harness]} ${kind}`;
  const { marker, expected } = wiringFor(harness);
  const retry = `run \`playtime install --harness ${harness}\``;

  const contents = await readFile(target, 'utf8').catch(() => null);
  if (contents === null) {
    return { name, status: 'warn', detail: `no ${kind} at ${target}, ${retry}` };
  }

  if (!contents.includes(marker)) {
    return { name, status: 'warn', detail: `not wired up, ${retry}` };
  }

  const referenced = referencedPath(contents, harness);
  if (referenced !== null && referenced !== expected) {
    return {
      name,
      status: 'warn',
      detail: `wired to another copy of Playtime at ${referenced}, ${retry} to point it here`,
    };
  }

  // A shell hook has to be executable; a module only has to be readable.
  const needed = harness === 'opencode' ? constants.R_OK : constants.X_OK;
  const usable = await access(referenced ?? expected, needed).then(
    () => true,
    () => false,
  );

  if (!usable) {
    return {
      name,
      status: 'fail',
      detail: `points at ${referenced ?? expected}, which is missing or cannot be run, ${retry}`,
    };
  }

  return { name, status: 'ok', detail: target };
}

async function checkHistory(paths: Paths, now: number): Promise<Check> {
  const found = await inspectSessions(paths);
  const sessions = found.records.length;

  if (found.unreadable > 0) {
    return {
      name: 'history',
      status: 'warn',
      detail: `${sessions} sessions, ${found.unreadable} unreadable lines, run \`playtime repair\``,
    };
  }

  if (sessions === 0) {
    return { name: 'history', status: 'warn', detail: 'no sessions recorded yet' };
  }

  // Checkpoints are one line per open session per minute, so a file several
  // times longer than its session count is just waiting to be compacted.
  if (found.superseded > sessions) {
    return {
      name: 'history',
      status: 'warn',
      detail: `${sessions} sessions across ${found.lines} lines, run \`playtime repair\` to compact`,
    };
  }

  const latest = Math.max(...found.records.map((record) => record.end));
  return {
    name: 'history',
    status: 'ok',
    detail: `${sessions} sessions, most recent ${formatRelative(latest, now)}`,
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
    ...(await Promise.all(HARNESSES.map(checkHarness))),
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

export function renderRepair(report: RepairReport, dryRun: boolean): string {
  const lines = ['PLAYTIME REPAIR', ''];
  const nothingWrong = report.unreadable === 0 && report.superseded === 0;

  lines.push(`  ${report.lines} lines read`);
  lines.push(`  ${report.kept} sessions kept`);

  if (report.unreadable > 0) {
    lines.push(`  ${report.unreadable} unreadable lines ${dryRun ? 'to drop' : 'dropped'}`);
  }
  if (report.superseded > 0) {
    lines.push(
      `  ${report.superseded} superseded checkpoints ${dryRun ? 'to collapse' : 'collapsed'}`,
    );
  }

  lines.push('');

  if (nothingWrong) lines.push('  History is already clean, nothing to do.');
  else if (dryRun) lines.push('  Run `playtime repair` to write this.');
  else if (report.backup) lines.push(`  The file as it was is at ${report.backup}`);

  return `${lines.join('\n')}\n`;
}
