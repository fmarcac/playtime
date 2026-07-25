import test from 'node:test';
import assert from 'node:assert/strict';

import { hookNameFor } from './plugin.js';

test('session lifecycle events map straight through', () => {
  assert.equal(hookNameFor({ type: 'session.created' }), 'session.created');
  assert.equal(hookNameFor({ type: 'session.idle' }), 'session.idle');
  assert.equal(hookNameFor({ type: 'session.deleted' }), 'session.deleted');
});

test('permission events map straight through', () => {
  assert.equal(hookNameFor({ type: 'permission.asked' }), 'permission.asked');
  assert.equal(hookNameFor({ type: 'permission.replied' }), 'permission.replied');
});

test('a user message is what starts a turn', () => {
  const event = { type: 'message.updated', properties: { info: { role: 'user' } } };

  assert.equal(hookNameFor(event), 'user.prompt');
});

test('an assistant message does not start a turn', () => {
  const event = { type: 'message.updated', properties: { info: { role: 'assistant' } } };

  assert.equal(hookNameFor(event), null);
});

test('a message with no role information is ignored', () => {
  assert.equal(hookNameFor({ type: 'message.updated' }), null);
});

test('events Playtime does not care about are ignored', () => {
  assert.equal(hookNameFor({ type: 'file.edited' }), null);
  assert.equal(hookNameFor({}), null);
});
