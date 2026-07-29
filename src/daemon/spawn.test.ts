import test from 'node:test';
import assert from 'node:assert/strict';

import { daemonRuntime } from './spawn.js';

test('running under node, the daemon starts with that same node', () => {
  assert.equal(daemonRuntime('/usr/bin/node', {}), '/usr/bin/node');
  assert.equal(daemonRuntime('/home/dev/.nvm/versions/node/v26.5.0/bin/node', {}), '/home/dev/.nvm/versions/node/v26.5.0/bin/node');
  assert.equal(daemonRuntime('C:\\Program Files\\nodejs\\node.exe', {}), 'C:\\Program Files\\nodejs\\node.exe');
});

test('running inside a harness binary, node is looked up on PATH instead', () => {
  // OpenCode ships as one compiled binary, and handing it a script path makes
  // it try to open that path as a project rather than run it.
  assert.equal(daemonRuntime('/home/dev/.opencode/bin/opencode', {}), 'node');
  assert.equal(daemonRuntime('/usr/local/bin/bun', {}), 'node');
});

test('PLAYTIME_NODE wins, the way the shell shim already treats it', () => {
  assert.equal(daemonRuntime('/usr/bin/node', { PLAYTIME_NODE: '/opt/node/bin/node' }), '/opt/node/bin/node');
  assert.equal(daemonRuntime('/home/dev/.opencode/bin/opencode', { PLAYTIME_NODE: '/opt/node' }), '/opt/node');
});

test('an empty override is ignored rather than spawning nothing', () => {
  assert.equal(daemonRuntime('/usr/bin/node', { PLAYTIME_NODE: '' }), '/usr/bin/node');
});
