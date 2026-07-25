/**
 * OpenCode plugin.
 *
 * Unlike the shell shims, this runs inside the harness process, so it knows its
 * own pid for free and can decide which message updates are actually prompts.
 * It still writes the same envelopes to the same inbox, so the daemon does not
 * need to know which harness it is talking to.
 */

import { appendEnvelope } from '../../store/inbox.js';
import { resolvePaths } from '../../store/paths.js';
import { ensureDaemon } from '../../daemon/spawn.js';
import { processStartTime } from '../../daemon/proc.js';
import type { Envelope } from '../../core/events.js';

/** OpenCode event names Playtime cares about, mapped to the shim's hook vocabulary. */
const DIRECT_EVENTS: Record<string, string> = {
  'session.created': 'session.created',
  'session.idle': 'session.idle',
  'session.deleted': 'session.deleted',
  'permission.asked': 'permission.asked',
  'permission.replied': 'permission.replied',
};

interface OpenCodeEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** OpenCode nests identifiers differently per event, so probe the shapes it uses. */
function readSessionId(properties: Record<string, unknown>): string | undefined {
  const info = asRecord(properties['info']);
  const candidates = [
    properties['sessionID'],
    properties['sessionId'],
    info['sessionID'],
    info['sessionId'],
    info['id'],
  ];

  return candidates.find((value): value is string => typeof value === 'string' && value !== '');
}

function isUserPrompt(event: OpenCodeEvent): boolean {
  if (event.type !== 'message.updated') return false;
  const info = asRecord(asRecord(event.properties)['info']);
  return info['role'] === 'user';
}

export function hookNameFor(event: OpenCodeEvent): string | null {
  if (isUserPrompt(event)) return 'user.prompt';
  return DIRECT_EVENTS[event.type ?? ''] ?? null;
}

export interface PluginContext {
  directory?: string;
  worktree?: string;
}

export const PlaytimePlugin = async (context: PluginContext = {}) => {
  const paths = resolvePaths();
  const pid = process.pid;
  const pidStart = processStartTime(pid);
  const directory = context.worktree ?? context.directory ?? process.cwd();

  await ensureDaemon(paths).catch(() => undefined);

  return {
    event: async ({ event }: { event: OpenCodeEvent }): Promise<void> => {
      const hook = hookNameFor(event);
      if (hook === null) return;

      const sessionId = readSessionId(asRecord(event.properties));
      if (sessionId === undefined) return;

      const envelope: Envelope = {
        v: 1,
        ts: Date.now(),
        harness: 'opencode',
        hook,
        pid,
        pidStart: pidStart ?? undefined,
        payload: { sessionID: sessionId, directory },
      };

      // A tracker must never take the harness down with it.
      await appendEnvelope(paths, envelope).catch(() => undefined);
    },
  };
};

export default PlaytimePlugin;
