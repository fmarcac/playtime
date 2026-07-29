import type { SessionRecord } from '../core/session.js';
import type { Paths } from './paths.js';
import { appendJsonl, readJsonl } from './jsonl.js';
import type { ReadResult } from './jsonl.js';

export async function appendSessions(
  paths: Paths,
  records: readonly SessionRecord[],
): Promise<void> {
  await appendJsonl(paths.sessions, records);
}

/**
 * The daemon checkpoints a long session repeatedly before it closes, so the same
 * session appears several times, each more complete than the last. Keying on
 * both id and start collapses those to the newest while leaving a genuinely
 * resumed session, which shares an id but starts later, as its own record.
 */
export async function readSessions(paths: Paths): Promise<ReadResult<SessionRecord>> {
  const { items, corrupt } = await readJsonl<SessionRecord>(paths.sessions);

  const newest = new Map<string, SessionRecord>();
  for (const record of items) newest.set(`${record.id}#${record.start}`, record);

  return { items: [...newest.values()], corrupt };
}
