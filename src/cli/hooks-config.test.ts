import test from 'node:test';
import assert from 'node:assert/strict';

import { isPlaytimeHook, mergeHooks, playtimeHooks } from './hooks-config.js';
import type { HookMap } from './hooks-config.js';

const EMIT = '/opt/harness-playtime/adapters/shared/emit.sh';

test('every lifecycle event Playtime needs gets a hook', () => {
  const hooks = playtimeHooks(EMIT, 'claude-code');

  for (const event of [
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'Stop',
    'Notification',
    'PostToolUse',
  ]) {
    assert.ok(hooks[event], `expected a ${event} hook`);
  }
});

test('each hook invokes the shim with its harness and event name', () => {
  const command = playtimeHooks(EMIT, 'codex')['Stop']?.[0]?.hooks[0]?.command ?? '';

  assert.match(command, /emit\.sh/);
  assert.match(command, /codex/);
  assert.match(command, /Stop/);
});

test('the emit path is quoted so a path with spaces still works', () => {
  const command = playtimeHooks('/opt/my tools/adapters/shared/emit.sh', 'claude-code')[
    'Stop'
  ]?.[0]?.hooks[0]?.command;

  assert.match(command ?? '', /"\/opt\/my tools\/adapters\/shared\/emit\.sh"/);
});

test('our own hooks are recognisable', () => {
  assert.equal(isPlaytimeHook({ type: 'command', command: `"${EMIT}" codex Stop` }), true);
  assert.equal(isPlaytimeHook({ type: 'command', command: 'echo hello' }), false);
});

test('merging into empty settings just installs our hooks', () => {
  const merged = mergeHooks(undefined, playtimeHooks(EMIT, 'claude-code'));

  assert.equal(merged['Stop']?.length, 1);
});

test('merging leaves unrelated hooks untouched', () => {
  const existing: HookMap = {
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
  };

  const merged = mergeHooks(existing, playtimeHooks(EMIT, 'claude-code'));

  assert.equal(merged['Stop']?.[0]?.hooks[0]?.command, 'notify-send done');
  assert.equal(merged['Stop']?.length, 2);
  assert.deepEqual(merged['PreToolUse'], existing['PreToolUse']);
});

test('installing twice replaces our entry rather than duplicating it', () => {
  const ours = playtimeHooks(EMIT, 'claude-code');
  const once = mergeHooks(undefined, ours);
  const twice = mergeHooks(once, ours);

  assert.deepEqual(twice, once);
});

test('reinstalling to a new location drops the hook pointing at the old one', () => {
  const installed = mergeHooks(undefined, playtimeHooks('/old/adapters/shared/emit.sh', 'claude-code'));
  const moved = mergeHooks(installed, playtimeHooks('/new/adapters/shared/emit.sh', 'claude-code'));

  assert.equal(moved['Stop']?.length, 1);
  assert.match(moved['Stop']?.[0]?.hooks[0]?.command ?? '', /\/new\//);
});

test('a matcher group mixing our hook with someone else keeps the other one', () => {
  const existing: HookMap = {
    Stop: [
      {
        hooks: [
          { type: 'command', command: `"${EMIT}" claude-code Stop` },
          { type: 'command', command: 'notify-send done' },
        ],
      },
    ],
  };

  const merged = mergeHooks(existing, playtimeHooks(EMIT, 'claude-code'));

  const commands = (merged['Stop'] ?? []).flatMap((group) => group.hooks.map((h) => h.command));
  assert.ok(commands.includes('notify-send done'));
  assert.equal(commands.filter((c) => c.includes('emit.sh')).length, 1);
});
