import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEnvelope } from './normalize.js';
import type { Envelope } from '../core/events.js';

const TS = 1_753_440_000_000;

function claudeCode(hook: string, payload: Record<string, unknown> = {}): Envelope {
  return {
    v: 1,
    ts: TS,
    harness: 'claude-code',
    hook,
    pid: 4242,
    pidStart: 99,
    payload: {
      session_id: 'sess_abc',
      transcript_path: '/home/dev/.claude/projects/x/sess_abc.jsonl',
      cwd: '/home/dev/work/api',
      hook_event_name: hook,
      ...payload,
    },
  };
}

test('a Claude Code SessionStart becomes a session_start', () => {
  const result = normalizeEnvelope(claudeCode('SessionStart', { source: 'startup' }));

  assert.equal(result?.event, 'session_start');
  assert.equal(result?.harness, 'claude-code');
  assert.equal(result?.sessionId, 'sess_abc');
  assert.equal(result?.cwd, '/home/dev/work/api');
  assert.equal(result?.pid, 4242);
  assert.equal(result?.pidStart, 99);
  assert.equal(result?.ts, TS);
});

test('Claude Code turn boundaries map to turn_start and turn_end', () => {
  assert.equal(normalizeEnvelope(claudeCode('UserPromptSubmit'))?.event, 'turn_start');
  assert.equal(normalizeEnvelope(claudeCode('Stop'))?.event, 'turn_end');
});

test('a Claude Code SessionEnd becomes a session_end', () => {
  assert.equal(normalizeEnvelope(claudeCode('SessionEnd', { reason: 'exit' }))?.event, 'session_end');
});

test('a Claude Code Notification opens a blocked span and a finished tool closes it', () => {
  assert.equal(normalizeEnvelope(claudeCode('Notification'))?.event, 'blocked_start');
  assert.equal(normalizeEnvelope(claudeCode('PostToolUse'))?.event, 'blocked_end');
});

test('a subagent stopping does not end the parent turn', () => {
  // Subagent time belongs to the session that spawned it, so it must not close the turn.
  assert.equal(normalizeEnvelope(claudeCode('SubagentStop')), null);
});

test('an unrecognised hook is ignored rather than throwing', () => {
  assert.equal(normalizeEnvelope(claudeCode('SomethingNew')), null);
});

test('an envelope with no session id cannot be attributed and is dropped', () => {
  const envelope = claudeCode('SessionStart');
  envelope.payload = { cwd: '/home/dev' };

  assert.equal(normalizeEnvelope(envelope), null);
});

test('an envelope with no usable timestamp is dropped', () => {
  const envelope = claudeCode('SessionStart');
  envelope.ts = Number.NaN;

  assert.equal(normalizeEnvelope(envelope), null);
});

test('an envelope from an unknown harness is dropped', () => {
  const envelope = { ...claudeCode('SessionStart'), harness: 'emacs' } as unknown as Envelope;

  assert.equal(normalizeEnvelope(envelope), null);
});

test('Codex uses the same hook names as Claude Code', () => {
  const envelope: Envelope = {
    v: 1,
    ts: TS,
    harness: 'codex',
    hook: 'UserPromptSubmit',
    pid: 77,
    payload: { session_id: 'codex_1', cwd: '/home/dev/work/api' },
  };

  const result = normalizeEnvelope(envelope);

  assert.equal(result?.event, 'turn_start');
  assert.equal(result?.harness, 'codex');
  assert.equal(result?.sessionId, 'codex_1');
});

test('the Codex legacy notify events still map onto turn boundaries', () => {
  const envelope: Envelope = {
    v: 1,
    ts: TS,
    harness: 'codex',
    hook: 'AfterAgent',
    payload: { 'session-id': 'codex_2', cwd: '/tmp' },
  };

  assert.equal(normalizeEnvelope(envelope)?.event, 'turn_end');
  assert.equal(normalizeEnvelope(envelope)?.sessionId, 'codex_2');
});

test('Codex reports its working directory under a different key', () => {
  const envelope: Envelope = {
    v: 1,
    ts: TS,
    harness: 'codex',
    hook: 'SessionStart',
    payload: { session_id: 'codex_3', workdir: '/home/dev/work/api' },
  };

  assert.equal(normalizeEnvelope(envelope)?.cwd, '/home/dev/work/api');
});

test('OpenCode session events map onto the session lifecycle', () => {
  const opencode = (hook: string): Envelope => ({
    v: 1,
    ts: TS,
    harness: 'opencode',
    hook,
    pid: 900,
    payload: { sessionID: 'oc_1', directory: '/home/dev/work/api' },
  });

  assert.equal(normalizeEnvelope(opencode('session.created'))?.event, 'session_start');
  assert.equal(normalizeEnvelope(opencode('session.idle'))?.event, 'turn_end');
  assert.equal(normalizeEnvelope(opencode('session.deleted'))?.event, 'session_end');
  assert.equal(normalizeEnvelope(opencode('user.prompt'))?.event, 'turn_start');
  assert.equal(normalizeEnvelope(opencode('permission.asked'))?.event, 'blocked_start');
  assert.equal(normalizeEnvelope(opencode('permission.replied'))?.event, 'blocked_end');
  assert.equal(normalizeEnvelope(opencode('session.created'))?.sessionId, 'oc_1');
});

test('a missing pid is left undefined rather than guessed at', () => {
  const envelope: Envelope = {
    v: 1,
    ts: TS,
    harness: 'codex',
    hook: 'SessionStart',
    payload: { session_id: 'codex_4' },
  };

  const result = normalizeEnvelope(envelope);

  assert.equal(result?.pid, undefined);
  assert.equal(result?.cwd, undefined);
});
