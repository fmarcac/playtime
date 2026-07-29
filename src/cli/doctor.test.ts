import test from 'node:test';
import assert from 'node:assert/strict';

import { referencedPath } from './doctor.js';
import { mergeHooks, playtimeHooks } from './hooks-config.js';

const EMIT = '/home/dev/.npm/_npx/abc123/node_modules/agent-playtime/adapters/shared/emit.sh';

/** Exactly what install writes, quoting and all. */
function settingsFile(emit: string): string {
  return `${JSON.stringify({ hooks: mergeHooks(undefined, playtimeHooks(emit, 'claude-code')) }, null, 2)}\n`;
}

test('the hook path is found even though its quotes are escaped inside the JSON', () => {
  // The path lives in a string inside a string. Matching on the quotes around
  // it finds nothing, and a doctor that finds nothing says everything is fine.
  assert.equal(referencedPath(settingsFile(EMIT), 'claude-code'), EMIT);
});

test('the same holds for Codex, which keeps the same shape', () => {
  const file = `${JSON.stringify({ hooks: playtimeHooks(EMIT, 'codex') }, null, 2)}\n`;

  assert.equal(referencedPath(file, 'codex'), EMIT);
});

test('a path with no surprises in it is still found', () => {
  const plain = '/usr/lib/node_modules/agent-playtime/adapters/shared/emit.sh';

  assert.equal(referencedPath(settingsFile(plain), 'claude-code'), plain);
});

test('the OpenCode plugin names its module in a plain re-export', () => {
  const source = '/usr/lib/node_modules/agent-playtime/dist/adapters/opencode/plugin.js';

  assert.equal(
    referencedPath(`export { PlaytimePlugin } from ${JSON.stringify(source)};\n`, 'opencode'),
    source,
  );
});

test('config with no wiring in it names nothing', () => {
  assert.equal(referencedPath('{\n  "hooks": {}\n}\n', 'claude-code'), null);
  assert.equal(referencedPath('export const Other = () => {};\n', 'opencode'), null);
});
