import { HARNESSES, isHarness } from '../core/events.js';
import type { Harness } from '../core/events.js';
import type { CountMode } from '../core/settings.js';
import { parseWhen } from '../core/when.js';
import { isWindowKind } from '../core/window.js';
import type { Range, WindowKind } from '../core/window.js';
import { defaultOutput, OUTPUT_FORMATS, ROW_SHAPES, SORT_KEYS, UNITS } from './output.js';
import type { OutputFormat, OutputOptions, RowShape, SortKey, Units } from './output.js';

/** Undefined means the setting decides; a flag overrides it for one run. */
export type CountOverride = CountMode | undefined;

/** Everything the three report commands share. */
export interface ReportOptions {
  window: WindowKind;
  range: Range | undefined;
  count: CountOverride;
  output: OutputOptions;
}

export type Command =
  | ({ kind: 'library' } & ReportOptions)
  | ({ kind: 'detail'; filter: string } & ReportOptions)
  | ({ kind: 'harness'; harness: Harness } & ReportOptions)
  | { kind: 'config'; action: 'show' }
  | { kind: 'config'; action: 'set'; key: string; value: string }
  | { kind: 'config'; action: 'unset'; key: string }
  | { kind: 'statusline'; format: string | undefined; width: number | undefined; json: boolean }
  | { kind: 'doctor' }
  | { kind: 'repair'; dryRun: boolean }
  | { kind: 'install'; harnesses: Harness[]; dryRun: boolean }
  | { kind: 'daemon'; foreground: boolean }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

function fail(message: string): Command {
  return { kind: 'error', message };
}

const VALUED = new Set([
  '--format',
  '--template',
  '--field',
  '--rows',
  '--units',
  '--sort',
  '--limit',
  '--since',
  '--until',
  '--project',
  '--harness',
  '--width',
]);

const BOOLEANS = new Set([
  '--json',
  '--jsonl',
  '--csv',
  '--tsv',
  '--no-header',
  '--reverse',
  '--no-color',
  '--stacked',
  '--wallclock',
  '--dry-run',
  '--foreground',
]);

interface Parsed {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
  error?: string;
}

/** Splits argv without deciding what any of it means. */
function split(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';

    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      positional.unshift('help');
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      positional.unshift('version');
      continue;
    }

    if (VALUED.has(arg)) {
      const value = argv[++i];
      if (value === undefined) {
        return { positional, values, flags, error: `${arg} needs a value` };
      }
      values.set(arg, value);
      continue;
    }

    if (BOOLEANS.has(arg)) {
      flags.add(arg);
      continue;
    }

    return { positional, values, flags, error: `unknown option ${arg}` };
  }

  return { positional, values, flags };
}

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  flag: string,
): T | { error: string } {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    return { error: `${flag} takes one of ${allowed.join(', ')}, not ${value}` };
  }
  return match;
}

function isError(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/** Formats named by their own flag, so `--csv` and `--format csv` agree. */
const FORMAT_FLAGS: Record<string, OutputFormat> = {
  '--json': 'json',
  '--jsonl': 'jsonl',
  '--csv': 'csv',
  '--tsv': 'tsv',
};

function readOutput(parsed: Parsed): OutputOptions | { error: string } {
  const output = defaultOutput();
  const chosen: OutputFormat[] = [];

  for (const [flag, format] of Object.entries(FORMAT_FLAGS)) {
    if (parsed.flags.has(flag)) chosen.push(format);
  }

  const named = parsed.values.get('--format');
  if (named !== undefined) {
    const format = oneOf(named, OUTPUT_FORMATS, '--format');
    if (isError(format)) return format;
    chosen.push(format);
  }

  const template = parsed.values.get('--template');
  if (template !== undefined) {
    output.template = template;
    chosen.push('template');
  }

  const field = parsed.values.get('--field');
  if (field !== undefined) {
    output.field = field;
    chosen.push('field');
  }

  const distinct = [...new Set(chosen)];
  if (distinct.length > 1) {
    return { error: `pick one output format, not ${distinct.join(' and ')}` };
  }
  output.format = distinct[0] ?? 'text';

  if (output.format === 'template' && output.template === undefined) {
    return { error: '--format template needs --template with the line to print' };
  }
  if (output.format === 'field' && output.field === undefined) {
    return { error: '--format field needs --field with the path to print' };
  }

  const rows = parsed.values.get('--rows');
  if (rows !== undefined) {
    const shape = oneOf(rows, ROW_SHAPES, '--rows');
    if (isError(shape)) return shape;
    output.shape = shape as RowShape;
  }

  const units = parsed.values.get('--units');
  if (units !== undefined) {
    const unit = oneOf(units, UNITS, '--units');
    if (isError(unit)) return unit;
    output.units = unit as Units;
  }

  const sort = parsed.values.get('--sort');
  if (sort !== undefined) {
    const key = oneOf(sort, SORT_KEYS, '--sort');
    if (isError(key)) return key;
    output.sort = key as SortKey;
  }

  const limit = parsed.values.get('--limit');
  if (limit !== undefined) {
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 0) {
      return { error: `--limit takes a whole number of rows, not ${limit}` };
    }
    output.limit = count;
  }

  const width = parsed.values.get('--width');
  if (width !== undefined) {
    const columns = Number(width);
    if (!Number.isFinite(columns) || columns <= 0) {
      return { error: `--width takes a number of columns, not ${width}` };
    }
    output.width = columns;
  }

  if (parsed.flags.has('--no-header')) output.header = false;
  if (parsed.flags.has('--reverse')) output.reverse = true;
  if (parsed.flags.has('--no-color')) output.color = false;

  return output;
}

function readRange(parsed: Parsed, now: number): Range | { error: string } | undefined {
  const since = parsed.values.get('--since');
  const until = parsed.values.get('--until');
  if (since === undefined && until === undefined) return undefined;

  const range: Range = {};

  if (since !== undefined) {
    const at = parseWhen(since, now);
    if (at === null) return { error: `--since does not understand ${since}` };
    range.since = at;
  }

  if (until !== undefined) {
    const at = parseWhen(until, now);
    if (at === null) return { error: `--until does not understand ${until}` };
    range.until = at;
  }

  if (range.since !== undefined && range.until !== undefined && range.until <= range.since) {
    return { error: '--until must come after --since' };
  }

  return range;
}

function readCount(parsed: Parsed): CountOverride {
  if (parsed.flags.has('--stacked')) return 'stacked';
  if (parsed.flags.has('--wallclock')) return 'wallclock';
  return undefined;
}

export function parseCommand(argv: readonly string[], now: number = Date.now()): Command {
  const parsed = split(argv);
  if (parsed.error) return fail(parsed.error);

  const { positional, values, flags } = parsed;
  const [first, second] = positional;
  const dryRun = flags.has('--dry-run');

  switch (first) {
    case 'help':
      return { kind: 'help' };
    case 'version':
      return { kind: 'version' };
    case 'doctor':
      return { kind: 'doctor' };
    case 'repair':
      return { kind: 'repair', dryRun };

    case 'config': {
      const [, action, key, value] = positional;
      if (action === undefined) return { kind: 'config', action: 'show' };

      if (action === 'set') {
        if (key === undefined || value === undefined) {
          return fail('config set needs a key and a value, for example `config set count stacked`');
        }
        return { kind: 'config', action: 'set', key, value };
      }

      if (action === 'unset') {
        if (key === undefined) return fail('config unset needs a key');
        return { kind: 'config', action: 'unset', key };
      }

      return fail(`unknown config action ${action}. Use set or unset.`);
    }

    case 'daemon':
      return { kind: 'daemon', foreground: flags.has('--foreground') };

    case 'statusline': {
      const width = values.get('--width');
      if (width !== undefined && !Number.isFinite(Number(width))) {
        return fail(`--width takes a number of columns, not ${width}`);
      }

      return {
        kind: 'statusline',
        format: values.get('--format'),
        width: width === undefined ? undefined : Number(width),
        json: flags.has('--json'),
      };
    }

    case 'install': {
      const harness = values.get('--harness');
      if (harness === undefined) {
        return { kind: 'install', harnesses: [...HARNESSES], dryRun };
      }
      if (!isHarness(harness)) return fail(`unknown harness ${harness}`);
      return { kind: 'install', harnesses: [harness], dryRun };
    }
  }

  // Everything left is a report, and they all take the same options.
  const output = readOutput(parsed);
  if (isError(output)) return fail(output.error);

  const range = readRange(parsed, now);
  if (isError(range)) return fail(range.error);

  const options: ReportOptions = {
    window: positional.find(isWindowKind) ?? 'all',
    range,
    count: readCount(parsed),
    output,
  };

  if (first === 'harness') {
    const name = second ?? values.get('--harness');
    if (name === undefined) return fail('harness needs a name, for example `harness codex`');
    if (!isHarness(name)) return fail(`unknown harness ${name}`);
    return { kind: 'harness', harness: name, ...options };
  }

  // A project or a harness can also be selected by flag, so a script never has
  // to build a positional argument.
  const project = values.get('--project');
  const harness = values.get('--harness');

  if (project !== undefined && harness !== undefined) {
    return fail('pick either --project or --harness, not both');
  }
  if (harness !== undefined) {
    if (!isHarness(harness)) return fail(`unknown harness ${harness}`);
    return { kind: 'harness', harness, ...options };
  }
  if (project !== undefined) {
    return { kind: 'detail', filter: project, ...options };
  }

  if (first === undefined || isWindowKind(first)) {
    return { kind: 'library', ...options };
  }

  // A bare word that is not a window is the name of a project to drill into.
  return { kind: 'detail', filter: first, ...options };
}
