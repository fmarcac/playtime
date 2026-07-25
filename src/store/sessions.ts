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

export async function readSessions(paths: Paths): Promise<ReadResult<SessionRecord>> {
  return readJsonl<SessionRecord>(paths.sessions);
}
