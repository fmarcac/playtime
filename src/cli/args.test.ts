import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand } from './args.js';

test('no arguments shows the whole library', () => {
  assert.deepEqual(parseCommand([]), { kind: 'library', window: 'all', json: false, count: undefined });
});

test('a window name narrows the library', () => {
  assert.equal(parseCommand(['today']).kind, 'library');
  assert.deepEqual(parseCommand(['week']), { kind: 'library', window: 'week', json: false, count: undefined });
  assert.deepEqual(parseCommand(['month']), { kind: 'library', window: 'month', json: false, count: undefined });
});

test('the json flag applies to the library', () => {
  assert.deepEqual(parseCommand(['--json']), { kind: 'library', window: 'all', json: true, count: undefined });
});

test('a bare word is treated as a project filter', () => {
  assert.deepEqual(parseCommand(['playtime']), {
    kind: 'detail',
    filter: 'playtime',
    window: 'all',
    json: false,
    count: undefined,
  });
});

test('a project filter can be combined with a window', () => {
  assert.deepEqual(parseCommand(['playtime', 'week']), {
    kind: 'detail',
    filter: 'playtime',
    window: 'week',
    json: false,
    count: undefined,
  });
});

test('harness takes a harness name', () => {
  assert.deepEqual(parseCommand(['harness', 'codex']), {
    kind: 'harness',
    harness: 'codex',
    window: 'all',
    json: false,
    count: undefined,
  });
});

test('an unknown harness name is an error rather than an empty report', () => {
  const result = parseCommand(['harness', 'emacs']);

  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.message : '', /emacs/);
});

test('harness with no name is an error', () => {
  assert.equal(parseCommand(['harness']).kind, 'error');
});

test('statusline defaults to no format and no width', () => {
  assert.deepEqual(parseCommand(['statusline']), {
    kind: 'statusline',
    format: undefined,
    width: undefined,
    json: false,
  });
});

test('statusline accepts a format template', () => {
  const result = parseCommand(['statusline', '--format', '{open} open']);

  assert.equal(result.kind === 'statusline' ? result.format : null, '{open} open');
});

test('statusline accepts an explicit width', () => {
  const result = parseCommand(['statusline', '--width', '40']);

  assert.equal(result.kind === 'statusline' ? result.width : null, 40);
});

test('a non-numeric statusline width is an error', () => {
  assert.equal(parseCommand(['statusline', '--width', 'wide']).kind, 'error');
});

test('statusline supports json output', () => {
  const result = parseCommand(['statusline', '--json']);

  assert.equal(result.kind === 'statusline' ? result.json : null, true);
});

test('install covers every harness unless told otherwise', () => {
  assert.deepEqual(parseCommand(['install']), {
    kind: 'install',
    harnesses: ['claude-code', 'codex', 'opencode'],
    dryRun: false,
  });
});

test('install can be limited to one harness', () => {
  assert.deepEqual(parseCommand(['install', '--harness', 'opencode']), {
    kind: 'install',
    harnesses: ['opencode'],
    dryRun: false,
  });
});

test('install has a dry run', () => {
  const result = parseCommand(['install', '--dry-run']);

  assert.equal(result.kind === 'install' ? result.dryRun : null, true);
});

test('installing an unknown harness is an error', () => {
  assert.equal(parseCommand(['install', '--harness', 'emacs']).kind, 'error');
});

test('doctor takes no arguments', () => {
  assert.deepEqual(parseCommand(['doctor']), { kind: 'doctor' });
});

test('daemon runs detached unless asked to stay in the foreground', () => {
  assert.deepEqual(parseCommand(['daemon']), { kind: 'daemon', foreground: false });
  assert.deepEqual(parseCommand(['daemon', '--foreground']), { kind: 'daemon', foreground: true });
});

test('help and version have short flags', () => {
  assert.equal(parseCommand(['--help']).kind, 'help');
  assert.equal(parseCommand(['-h']).kind, 'help');
  assert.equal(parseCommand(['--version']).kind, 'version');
  assert.equal(parseCommand(['-v']).kind, 'version');
});

test('an unknown flag is reported rather than ignored', () => {
  const result = parseCommand(['--wat']);

  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.message : '', /--wat/);
});

test('config with no arguments shows the settings page', () => {
  assert.deepEqual(parseCommand(['config']), { kind: 'config', action: 'show' });
});

test('config set takes a key and a value', () => {
  assert.deepEqual(parseCommand(['config', 'set', 'count', 'stacked']), {
    kind: 'config',
    action: 'set',
    key: 'count',
    value: 'stacked',
  });
});

test('config set with no value is an error rather than a silent no-op', () => {
  assert.equal(parseCommand(['config', 'set', 'count']).kind, 'error');
});

test('config unset takes a key', () => {
  assert.deepEqual(parseCommand(['config', 'unset', 'count']), {
    kind: 'config',
    action: 'unset',
    key: 'count',
  });
});

test('an unrecognised config action is an error', () => {
  assert.equal(parseCommand(['config', 'wibble']).kind, 'error');
});

test('a report can override the counting mode for one run', () => {
  const stacked = parseCommand(['--stacked']);
  assert.equal(stacked.kind === 'library' ? stacked.count : null, 'stacked');

  const wall = parseCommand(['--wallclock']);
  assert.equal(wall.kind === 'library' ? wall.count : null, 'wallclock');
});

test('without an override the counting mode is left to the settings', () => {
  const result = parseCommand([]);
  assert.equal(result.kind === 'library' ? result.count : 'missing', undefined);
});

test('the counting override reaches project and harness views too', () => {
  const project = parseCommand(['playtime', '--stacked']);
  assert.equal(project.kind === 'detail' ? project.count : null, 'stacked');

  const harness = parseCommand(['harness', 'codex', '--stacked']);
  assert.equal(harness.kind === 'harness' ? harness.count : null, 'stacked');
});
