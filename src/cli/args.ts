import { HARNESSES, isHarness } from '../core/events.js';
import type { Harness } from '../core/events.js';
import { isWindowKind } from '../core/window.js';
import type { WindowKind } from '../core/window.js';

export type Command =
  | { kind: 'library'; window: WindowKind; json: boolean }
  | { kind: 'detail'; filter: string; window: WindowKind; json: boolean }
  | { kind: 'harness'; harness: Harness; window: WindowKind; json: boolean }
  | { kind: 'statusline'; format: string | undefined; width: number | undefined; json: boolean }
  | { kind: 'doctor' }
  | { kind: 'install'; harnesses: Harness[]; dryRun: boolean }
  | { kind: 'daemon'; foreground: boolean }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string };

function fail(message: string): Command {
  return { kind: 'error', message };
}

interface Flags {
  json: boolean;
  dryRun: boolean;
  foreground: boolean;
  format?: string;
  width?: number;
  harness?: string;
}

interface Split {
  positional: string[];
  flags: Flags;
  error?: string;
}

const VALUED_FLAGS = new Set(['--format', '--width', '--harness']);

function split(argv: readonly string[]): Split {
  const positional: string[] = [];
  const flags: Flags = { json: false, dryRun: false, foreground: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';

    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }

    if (VALUED_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) return { positional, flags, error: `${arg} needs a value` };

      if (arg === '--format') flags.format = value;
      if (arg === '--harness') flags.harness = value;
      if (arg === '--width') {
        const width = Number(value);
        if (!Number.isFinite(width)) return { positional, flags, error: `--width needs a number` };
        flags.width = width;
      }
      continue;
    }

    switch (arg) {
      case '--json':
        flags.json = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--foreground':
        flags.foreground = true;
        break;
      case '--help':
      case '-h':
        positional.unshift('help');
        break;
      case '--version':
      case '-v':
        positional.unshift('version');
        break;
      default:
        return { positional, flags, error: `unknown option ${arg}` };
    }
  }

  return { positional, flags };
}

export function parseCommand(argv: readonly string[]): Command {
  const { positional, flags, error } = split(argv);
  if (error) return fail(error);

  const [first, second] = positional;
  const window = positional.find(isWindowKind) ?? 'all';

  switch (first) {
    case 'help':
      return { kind: 'help' };
    case 'version':
      return { kind: 'version' };
    case 'doctor':
      return { kind: 'doctor' };

    case 'daemon':
      return { kind: 'daemon', foreground: flags.foreground };

    case 'statusline':
      return {
        kind: 'statusline',
        format: flags.format,
        width: flags.width,
        json: flags.json,
      };

    case 'install': {
      if (flags.harness === undefined) {
        return { kind: 'install', harnesses: [...HARNESSES], dryRun: flags.dryRun };
      }
      if (!isHarness(flags.harness)) return fail(`unknown harness ${flags.harness}`);
      return { kind: 'install', harnesses: [flags.harness], dryRun: flags.dryRun };
    }

    case 'harness': {
      if (second === undefined) return fail('harness needs a name, for example `harness codex`');
      if (!isHarness(second)) return fail(`unknown harness ${second}`);
      return { kind: 'harness', harness: second, window, json: flags.json };
    }

    case undefined:
      return { kind: 'library', window, json: flags.json };

    default:
      // A bare word that is not a window is the name of a project to drill into.
      if (isWindowKind(first)) return { kind: 'library', window, json: flags.json };
      return { kind: 'detail', filter: first, window, json: flags.json };
  }
}
