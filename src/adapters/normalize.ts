/**
 * Translation from each harness's own hook vocabulary into Playtime's.
 *
 * Adapters stay dumb on purpose: the shell shims copy the harness payload
 * through untouched and every interpretation happens here, where it is testable
 * against captured fixtures.
 */

import { isHarness } from '../core/events.js';
import type { Envelope, EventKind, Harness, PlaytimeEvent } from '../core/events.js';

/**
 * Codex mirrors Claude Code's hook names, so both share this table.
 *
 * `Notification` opens a blocked span and `PostToolUse` closes it. That measures
 * the permission prompt plus the run time of the tool it was gating, since
 * neither harness emits an event at the moment you approve.
 */
const CLAUDE_STYLE: Record<string, EventKind> = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'turn_start',
  Stop: 'turn_end',
  Notification: 'blocked_start',
  PostToolUse: 'blocked_end',
};

/** Codex's older `notify` interface, kept working for pre-hooks installs. */
const CODEX_LEGACY: Record<string, EventKind> = {
  AfterAgent: 'turn_end',
  AfterToolUse: 'blocked_end',
};

/** The OpenCode plugin decides which message updates are prompts, and says so here. */
const OPENCODE: Record<string, EventKind> = {
  'session.created': 'session_start',
  'session.deleted': 'session_end',
  'user.prompt': 'turn_start',
  'session.idle': 'turn_end',
  'permission.asked': 'blocked_start',
  'permission.replied': 'blocked_end',
};

const HOOK_MAPS: Record<Harness, Record<string, EventKind>> = {
  'claude-code': CLAUDE_STYLE,
  codex: { ...CLAUDE_STYLE, ...CODEX_LEGACY },
  opencode: OPENCODE,
};

const SESSION_KEYS = ['session_id', 'sessionId', 'sessionID', 'session-id', 'id'];
const CWD_KEYS = ['cwd', 'workdir', 'working_directory', 'workingDirectory', 'directory'];

function pickString(payload: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

export function normalizeEnvelope(envelope: Envelope): PlaytimeEvent | null {
  if (!isHarness(envelope.harness)) return null;
  if (!Number.isFinite(envelope.ts)) return null;

  const kind = HOOK_MAPS[envelope.harness][envelope.hook];
  if (kind === undefined) return null;

  const payload =
    typeof envelope.payload === 'object' && envelope.payload !== null
      ? (envelope.payload as Record<string, unknown>)
      : {};

  // Time that cannot be attributed to a session is better dropped than guessed at.
  const sessionId = pickString(payload, SESSION_KEYS);
  if (sessionId === undefined) return null;

  return {
    ts: envelope.ts,
    harness: envelope.harness,
    event: kind,
    sessionId,
    pid: envelope.pid,
    pidStart: envelope.pidStart,
    cwd: pickString(payload, CWD_KEYS),
  };
}
