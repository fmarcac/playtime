/**
 * Compacting session history.
 *
 * The daemon checkpoints every open session once a minute so a crash cannot
 * take unsaved hours with it, which means history accumulates one line per
 * session per minute and only the last of them counts. Compaction keeps that
 * last line and drops the rest, along with any line a failed write left
 * truncated.
 */

import { copyFile, readFile } from 'node:fs/promises';

import type { SessionRecord } from '../core/session.js';
import { isMissingFile, parseJsonl, toJsonl, writeAtomic } from './jsonl.js';
import type { Paths } from './paths.js';

export interface RepairReport {
  /** Lines read, including the unreadable ones. */
  lines: number;
  /** Sessions written back. */
  kept: number;
  /** Lines that were not valid session records. */
  unreadable: number;
  /** Earlier checkpoints of a session that a later line replaced. */
  superseded: number;
  changed: boolean;
  backup: string | null;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<SessionRecord>;

  return (
    typeof record.id === 'string' &&
    typeof record.harness === 'string' &&
    typeof record.project === 'string' &&
    typeof record.start === 'number' &&
    typeof record.end === 'number' &&
    Array.isArray(record.open)
  );
}

export interface Compacted {
  records: SessionRecord[];
  lines: number;
  unreadable: number;
  superseded: number;
}

/** Pure part: the file's text in, the sessions worth keeping out. */
export function compact(text: string): Compacted {
  const { items, corrupt } = parseJsonl<unknown>(text);

  const newest = new Map<string, SessionRecord>();
  let unreadable = corrupt;
  let valid = 0;

  for (const item of items) {
    if (!isSessionRecord(item)) {
      unreadable += 1;
      continue;
    }

    valid += 1;
    // Later lines win: a checkpoint is a session as it stood at the time.
    newest.set(`${item.id}#${item.start}`, item);
  }

  const records = [...newest.values()].sort((a, b) => a.start - b.start);

  return {
    records,
    lines: items.length + corrupt,
    unreadable,
    superseded: valid - records.length,
  };
}

/** What a repair would find, without touching anything. */
export async function inspectSessions(paths: Paths): Promise<Compacted> {
  const text = await readFile(paths.sessions, 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) return '';
    throw error;
  });

  return compact(text);
}

function nothingToDo(result: Compacted): RepairReport {
  return {
    lines: result.lines,
    kept: result.records.length,
    unreadable: 0,
    superseded: 0,
    changed: false,
    backup: null,
  };
}

/**
 * What of the file was appended after `read` was taken, ready to be carried
 * over. Null means the part we read is no longer the start of the file, so
 * nothing can safely be written.
 */
export function carryOver(read: string, current: string): string | null {
  if (!current.startsWith(read)) return null;

  const tail = current.slice(read.length);
  // A file not ending in a newline was cut mid-line, so whatever was appended
  // after it continues that broken line rather than starting a new one.
  if (read === '' || read.endsWith('\n')) return tail;

  const boundary = tail.indexOf('\n');
  return boundary === -1 ? '' : tail.slice(boundary + 1);
}

/**
 * Rewrites history in place, keeping a backup.
 *
 * Safe to run while the daemon is up: the daemon only ever appends, so anything
 * that lands mid-repair is at the end of the file and is carried across
 * untouched. If the part we read has changed underneath us, nothing is written.
 */
export async function repairSessions(paths: Paths): Promise<RepairReport> {
  const text = await readFile(paths.sessions, 'utf8').catch((error: unknown) => {
    if (isMissingFile(error)) return '';
    throw error;
  });

  const result = compact(text);
  if (result.unreadable === 0 && result.superseded === 0) return nothingToDo(result);

  const current = await readFile(paths.sessions, 'utf8').catch(() => '');
  const tail = carryOver(text, current);
  if (tail === null) {
    throw new Error('history changed while it was being repaired, nothing was written');
  }

  const backup = `${paths.sessions}.playtime-backup`;
  await copyFile(paths.sessions, backup).catch(() => undefined);
  await writeAtomic(paths.sessions, toJsonl(result.records) + tail);

  return {
    lines: result.lines,
    kept: result.records.length,
    unreadable: result.unreadable,
    superseded: result.superseded,
    changed: true,
    backup,
  };
}
