/** The normalized event vocabulary every harness adapter must map onto. */

export const HARNESSES = ['claude-code', 'codex', 'opencode'] as const;

export type Harness = (typeof HARNESSES)[number];

export const HARNESS_LABELS: Record<Harness, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export type EventKind =
  | 'session_start'
  | 'session_end'
  | 'turn_start'
  | 'turn_end'
  | 'blocked_start'
  | 'blocked_end';

export interface PlaytimeEvent {
  /** Milliseconds since the epoch, stamped by the adapter at emit time. */
  ts: number;
  harness: Harness;
  event: EventKind;
  sessionId: string;
  /** Harness process id, used by the daemon to detect death. */
  pid?: number | undefined;
  /** Process start time, guarding against pid reuse resurrecting a dead session. */
  pidStart?: number | undefined;
  /** Working directory, which becomes the project the time is attributed to. */
  cwd?: string | undefined;
}

/**
 * The envelope a harness adapter writes to the inbox. The shell shims stay dumb:
 * they stamp a timestamp and pass the harness payload through untouched, and all
 * interpretation happens here.
 */
export interface Envelope {
  v: 1;
  ts: number;
  harness: Harness;
  /** The harness's own name for the event, for example `SessionStart`. */
  hook: string;
  pid?: number | undefined;
  pidStart?: number | undefined;
  payload?: unknown;
}

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && (HARNESSES as readonly string[]).includes(value);
}
