import { rename, rm } from 'node:fs/promises';

import type { Envelope } from '../core/events.js';
import type { Paths } from './paths.js';
import { appendJsonl, isMissingFile, readJsonl } from './jsonl.js';
import type { ReadResult } from './jsonl.js';

/** Appends one envelope. Used by the OpenCode plugin and by tests; shell hooks append directly. */
export async function appendEnvelope(paths: Paths, envelope: Envelope): Promise<void> {
  await appendJsonl(paths.inbox, [envelope]);
}

/**
 * Takes everything currently in the inbox and clears it.
 *
 * The file is renamed aside before being read, so a hook appending at the same
 * moment writes into a fresh inbox rather than into a file about to be deleted.
 */
export async function drainInbox(paths: Paths): Promise<ReadResult<Envelope>> {
  const staging = `${paths.inbox}.draining.${process.pid}`;

  try {
    await rename(paths.inbox, staging);
  } catch (error) {
    if (isMissingFile(error)) return { items: [], corrupt: 0 };
    throw error;
  }

  try {
    return await readJsonl<Envelope>(staging);
  } finally {
    await rm(staging, { force: true });
  }
}
