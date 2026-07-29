import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand } from './args.js';
import type { Command } from './args.js';
import type { OutputOptions } from './output.js';

/** What every report carries before a flag touches it. */
const REPORT = {
  window: 'all' as const,
  range: undefined,
  count: undefined,
  output: { format: 'text' as const, header: true, reverse: false },
};

const NOW = new Date('2026-07-29T15:20:00').getTime();

function output(argv: readonly string[]): OutputOptions {
  const command = parseCommand(argv, NOW);
  assert.ok('output' in command, `expected a report, got ${command.kind}`);
  return command.output;
}

function errorFrom(command: Command): string {
  return command.kind === 'error' ? command.message : `expected an error, got ${command.kind}`;
}

test('no arguments shows the whole library', () => {
  assert.deepEqual(parseCommand([]), { kind: 'library', ...REPORT });
});

test('a window name narrows the library', () => {
  assert.deepEqual(parseCommand(['week']), { kind: 'library', ...REPORT, window: 'week' });
  assert.deepEqual(parseCommand(['month']), { kind: 'library', ...REPORT, window: 'month' });
  assert.deepEqual(parseCommand(['year']), { kind: 'library', ...REPORT, window: 'year' });
  assert.deepEqual(parseCommand(['today']), { kind: 'library', ...REPORT, window: 'today' });
});

test('a bare word is treated as a project filter', () => {
  assert.deepEqual(parseCommand(['dashboard']), {
    kind: 'detail',
    filter: 'dashboard',
    ...REPORT,
  });
});

test('a project filter can be combined with a window', () => {
  assert.deepEqual(parseCommand(['dashboard', 'week']), {
    kind: 'detail',
    filter: 'dashboard',
    ...REPORT,
    window: 'week',
  });
});

test('harness takes a harness name', () => {
  assert.deepEqual(parseCommand(['harness', 'codex']), {
    kind: 'harness',
    harness: 'codex',
    ...REPORT,
  });
});

test('an unknown harness name is an error rather than an empty report', () => {
  const result = parseCommand(['harness', 'emacs']);

  assert.equal(result.kind, 'error');
  assert.match(errorFrom(result), /emacs/);
});

test('harness with no name is an error', () => {
  assert.equal(parseCommand(['harness']).kind, 'error');
});

test('a project or a harness can be selected by flag instead of position', () => {
  assert.deepEqual(parseCommand(['--project', 'api']), { kind: 'detail', filter: 'api', ...REPORT });
  assert.deepEqual(parseCommand(['--harness', 'codex']), {
    kind: 'harness',
    harness: 'codex',
    ...REPORT,
  });
});

test('asking for a project and a harness at once is an error', () => {
  assert.match(errorFrom(parseCommand(['--project', 'api', '--harness', 'codex'])), /not both/);
});

test('each output format has its own flag and its own name', () => {
  assert.equal(output(['--json']).format, 'json');
  assert.equal(output(['--jsonl']).format, 'jsonl');
  assert.equal(output(['--csv']).format, 'csv');
  assert.equal(output(['--tsv']).format, 'tsv');
  assert.equal(output(['--format', 'tsv']).format, 'tsv');
  assert.equal(output(['--format', 'text']).format, 'text');
});

test('a template or a field selects its own format', () => {
  const template = output(['--template', '{open}']);
  assert.equal(template.format, 'template');
  assert.equal(template.template, '{open}');

  const field = output(['--field', 'total.open']);
  assert.equal(field.format, 'field');
  assert.equal(field.field, 'total.open');
});

test('two output formats at once is an error rather than a silent winner', () => {
  assert.match(errorFrom(parseCommand(['--json', '--csv'])), /pick one output format/);
});

test('naming a format twice the same way is fine', () => {
  assert.equal(output(['--csv', '--format', 'csv']).format, 'csv');
});

test('a format that needs an argument says which one', () => {
  assert.match(errorFrom(parseCommand(['--format', 'template'])), /--template/);
  assert.match(errorFrom(parseCommand(['--format', 'field'])), /--field/);
});

test('an unknown format name lists the ones that exist', () => {
  assert.match(errorFrom(parseCommand(['--format', 'yaml'])), /json.*csv/s);
});

test('rows, units and sort are checked against what exists', () => {
  assert.equal(output(['--rows', 'days']).shape, 'days');
  assert.equal(output(['--units', 'h']).units, 'h');
  assert.equal(output(['--sort', 'turns']).sort, 'turns');

  assert.equal(parseCommand(['--rows', 'weeks']).kind, 'error');
  assert.equal(parseCommand(['--units', 'fortnights']).kind, 'error');
  assert.equal(parseCommand(['--sort', 'vibes']).kind, 'error');
});

test('the row limit takes a whole number', () => {
  assert.equal(output(['--limit', '5']).limit, 5);
  assert.equal(parseCommand(['--limit', 'five']).kind, 'error');
  assert.equal(parseCommand(['--limit', '-1']).kind, 'error');
  assert.equal(parseCommand(['--limit', '2.5']).kind, 'error');
});

test('headers, order and colour have their own switches', () => {
  assert.equal(output(['--no-header']).header, false);
  assert.equal(output(['--reverse']).reverse, true);
  assert.equal(output(['--no-color']).color, false);
  assert.equal(output(['--width', '60']).width, 60);
});

test('a value flag with nothing after it is an error', () => {
  assert.match(errorFrom(parseCommand(['--field'])), /needs a value/);
});

test('since and until are resolved against the clock they were given', () => {
  const command = parseCommand(['--since', '7d'], NOW);

  assert.ok('range' in command && command.range);
  assert.equal(command.range?.since, NOW - 7 * 24 * 60 * 60 * 1000);
});

test('a bare date means local midnight', () => {
  const command = parseCommand(['--since', '2026-07-01'], NOW);

  assert.equal(command.kind === 'library' ? command.range?.since : null, new Date('2026-07-01T00:00:00').getTime());
});

test('a range that runs backwards is an error', () => {
  assert.match(
    errorFrom(parseCommand(['--since', '2026-07-10', '--until', '2026-07-01'], NOW)),
    /must come after/,
  );
});

test('a date nobody can read is an error rather than NaN', () => {
  assert.match(errorFrom(parseCommand(['--since', 'whenever'], NOW)), /whenever/);
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

test('repair has a dry run of its own', () => {
  assert.deepEqual(parseCommand(['repair']), { kind: 'repair', dryRun: false });
  assert.deepEqual(parseCommand(['repair', '--dry-run']), { kind: 'repair', dryRun: true });
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
  assert.match(errorFrom(result), /--wat/);
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
  const project = parseCommand(['dashboard', '--stacked']);
  assert.equal(project.kind === 'detail' ? project.count : null, 'stacked');

  const harness = parseCommand(['harness', 'codex', '--stacked']);
  assert.equal(harness.kind === 'harness' ? harness.count : null, 'stacked');
});
