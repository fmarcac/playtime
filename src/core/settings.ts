/**
 * User settings: definitions, defaults, and the pure transformations over them.
 *
 * Stored flat with dotted keys so the file stays readable by hand and a
 * `config set` never has to walk into nested objects. Every read and write
 * names its field outright, so a value's type is checked rather than asserted.
 */

export const COUNT_MODES = ['wallclock', 'stacked'] as const;
export type CountMode = (typeof COUNT_MODES)[number];

export const STATUSLINE_WINDOWS = ['today', 'week', 'allTime'] as const;
export type StatuslineWindow = (typeof STATUSLINE_WINDOWS)[number];

export const DEFAULT_STATUSLINE_FORMAT = '{open} open · {busy} busy';

export interface Settings {
  count: CountMode;
  'statusline.format': string;
  'statusline.window': StatuslineWindow;
  'projects.limit': number;
  'daemon.tickMs': number;
  'daemon.idleExitMs': number;
}

export type SettingKey = keyof Settings;

const DEFAULTS: Settings = {
  count: 'wallclock',
  'statusline.format': DEFAULT_STATUSLINE_FORMAT,
  'statusline.window': 'allTime',
  'projects.limit': 12,
  'daemon.tickMs': 15_000,
  'daemon.idleExitMs': 120_000,
};

interface Range {
  min: number;
  max: number;
}

/** Shared by validation and by the help text, so the two cannot drift apart. */
const RANGES = {
  'projects.limit': { min: 1, max: 100 },
  'daemon.tickMs': { min: 1000, max: 600_000 },
  'daemon.idleExitMs': { min: 10_000, max: 3_600_000 },
} as const satisfies Record<string, Range>;

export interface Definition {
  key: SettingKey;
  fallback: string | number;
  choices?: readonly string[];
  range?: Range;
  summary: string;
  detail: string;
}

export const DEFINITIONS: readonly Definition[] = [
  {
    key: 'count',
    fallback: DEFAULTS.count,
    choices: COUNT_MODES,
    summary: 'deduplicate sessions open at the same time',
    detail:
      'wallclock deduplicates: an hour with three sessions open counts as one hour. stacked does not: the same hour counts as three, adding every session up regardless of overlap.',
  },
  {
    key: 'statusline.format',
    fallback: DEFAULTS['statusline.format'],
    summary: 'template for the status line',
    detail: 'tokens: {open} {busy} {blocked} {sessions} {turns} {total} {project} {harness}',
  },
  {
    key: 'statusline.window',
    fallback: DEFAULTS['statusline.window'],
    choices: STATUSLINE_WINDOWS,
    summary: 'period the status line reports',
    detail:
      'which window the bare tokens in the format refer to. allTime is every hour ever recorded.',
  },
  {
    key: 'projects.limit',
    fallback: DEFAULTS['projects.limit'],
    range: RANGES['projects.limit'],
    summary: 'project rows shown under Hours used',
    detail: 'anything beyond this is summarised as a count',
  },
  {
    key: 'daemon.tickMs',
    fallback: DEFAULTS['daemon.tickMs'],
    range: RANGES['daemon.tickMs'],
    summary: 'how often the daemon samples liveness',
    detail: 'shorter is more precise around crashes and costs slightly more wakeups',
  },
  {
    key: 'daemon.idleExitMs',
    fallback: DEFAULTS['daemon.idleExitMs'],
    range: RANGES['daemon.idleExitMs'],
    summary: 'how long the daemon lingers once nothing is open',
    detail: 'it restarts by itself on the next hook, so a short wait costs nothing',
  },
];

const KNOWN_KEYS: ReadonlySet<string> = new Set(DEFINITIONS.map((entry) => entry.key));

export function defaultSettings(): Settings {
  return { ...DEFAULTS };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accepts JSON values from the file and raw strings from the command line alike. */
function toChoice<T extends string>(value: unknown, choices: readonly T[]): T | Error {
  if (typeof value !== 'string') return new Error(`${JSON.stringify(value)} should be text`);

  const match = choices.find((choice) => choice === value);
  if (match === undefined) {
    return new Error(`${JSON.stringify(value)} is not one of ${choices.join(', ')}`);
  }

  return match;
}

function toText(value: unknown): string | Error {
  if (typeof value !== 'string') return new Error(`${JSON.stringify(value)} should be text`);
  return value;
}

function toNumber(value: unknown, range: Range): number | Error {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return new Error(`${JSON.stringify(value)} is not a number`);
  if (parsed < range.min || parsed > range.max) {
    return new Error(`${parsed} is outside ${range.min} to ${range.max}`);
  }
  return parsed;
}

/** Reads one field, falling back to its default and recording why. */
function field<T>(
  source: Record<string, unknown>,
  key: SettingKey,
  fallback: T,
  convert: (value: unknown) => T | Error,
  problems: string[],
): T {
  if (!(key in source)) return fallback;

  const converted = convert(source[key]);
  if (converted instanceof Error) {
    problems.push(`${key}: ${converted.message}`);
    return fallback;
  }

  return converted;
}

/** Unknown keys and bad values are reported and skipped, never fatal. */
export function parseSettings(raw: unknown): { settings: Settings; problems: string[] } {
  const problems: string[] = [];

  if (raw === undefined || raw === null) return { settings: defaultSettings(), problems };
  if (!isRecord(raw)) {
    return {
      settings: defaultSettings(),
      problems: ['the settings file should contain a JSON object'],
    };
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`unknown setting ${key}`);
  }

  const settings: Settings = {
    count: field(raw, 'count', DEFAULTS.count, (v) => toChoice(v, COUNT_MODES), problems),
    'statusline.format': field(
      raw,
      'statusline.format',
      DEFAULTS['statusline.format'],
      toText,
      problems,
    ),
    'statusline.window': field(
      raw,
      'statusline.window',
      DEFAULTS['statusline.window'],
      (v) => toChoice(v, STATUSLINE_WINDOWS),
      problems,
    ),
    'projects.limit': field(
      raw,
      'projects.limit',
      DEFAULTS['projects.limit'],
      (v) => toNumber(v, RANGES['projects.limit']),
      problems,
    ),
    'daemon.tickMs': field(
      raw,
      'daemon.tickMs',
      DEFAULTS['daemon.tickMs'],
      (v) => toNumber(v, RANGES['daemon.tickMs']),
      problems,
    ),
    'daemon.idleExitMs': field(
      raw,
      'daemon.idleExitMs',
      DEFAULTS['daemon.idleExitMs'],
      (v) => toNumber(v, RANGES['daemon.idleExitMs']),
      problems,
    ),
  };

  return { settings, problems };
}

export type Applied = { ok: true; settings: Settings } | { ok: false; error: string };

function unknownKey(key: string): Applied {
  const known = DEFINITIONS.map((definition) => definition.key).join(', ');
  return { ok: false, error: `unknown setting ${key}. Known settings: ${known}` };
}

function refuse(key: string, reason: Error): Applied {
  return { ok: false, error: `${key}: ${reason.message}` };
}

export function applySetting(settings: Settings, key: string, raw: string): Applied {
  switch (key) {
    case 'count': {
      const value = toChoice(raw, COUNT_MODES);
      return value instanceof Error
        ? refuse(key, value)
        : { ok: true, settings: { ...settings, count: value } };
    }
    case 'statusline.format': {
      const value = toText(raw);
      return value instanceof Error
        ? refuse(key, value)
        : { ok: true, settings: { ...settings, 'statusline.format': value } };
    }
    case 'statusline.window': {
      const value = toChoice(raw, STATUSLINE_WINDOWS);
      return value instanceof Error
        ? refuse(key, value)
        : { ok: true, settings: { ...settings, 'statusline.window': value } };
    }
    case 'projects.limit': {
      const value = toNumber(raw, RANGES['projects.limit']);
      return value instanceof Error
        ? refuse(key, value)
        : { ok: true, settings: { ...settings, 'projects.limit': value } };
    }
    case 'daemon.tickMs': {
      const value = toNumber(raw, RANGES['daemon.tickMs']);
      return value instanceof Error
        ? refuse(key, value)
        : { ok: true, settings: { ...settings, 'daemon.tickMs': value } };
    }
    case 'daemon.idleExitMs': {
      const value = toNumber(raw, RANGES['daemon.idleExitMs']);
      return value instanceof Error
        ? refuse(key, value)
        : { ok: true, settings: { ...settings, 'daemon.idleExitMs': value } };
    }
    default:
      return unknownKey(key);
  }
}

export function resetSetting(settings: Settings, key: string): Applied {
  switch (key) {
    case 'count':
      return { ok: true, settings: { ...settings, count: DEFAULTS.count } };
    case 'statusline.format':
      return {
        ok: true,
        settings: { ...settings, 'statusline.format': DEFAULTS['statusline.format'] },
      };
    case 'statusline.window':
      return {
        ok: true,
        settings: { ...settings, 'statusline.window': DEFAULTS['statusline.window'] },
      };
    case 'projects.limit':
      return { ok: true, settings: { ...settings, 'projects.limit': DEFAULTS['projects.limit'] } };
    case 'daemon.tickMs':
      return { ok: true, settings: { ...settings, 'daemon.tickMs': DEFAULTS['daemon.tickMs'] } };
    case 'daemon.idleExitMs':
      return {
        ok: true,
        settings: { ...settings, 'daemon.idleExitMs': DEFAULTS['daemon.idleExitMs'] },
      };
    default:
      return unknownKey(key);
  }
}

/** Only what differs from the defaults, so the saved file stays small. */
export function customised(settings: Settings): Partial<Settings> {
  const out: Partial<Settings> = {};

  if (settings.count !== DEFAULTS.count) out.count = settings.count;
  if (settings['statusline.format'] !== DEFAULTS['statusline.format']) {
    out['statusline.format'] = settings['statusline.format'];
  }
  if (settings['statusline.window'] !== DEFAULTS['statusline.window']) {
    out['statusline.window'] = settings['statusline.window'];
  }
  if (settings['projects.limit'] !== DEFAULTS['projects.limit']) {
    out['projects.limit'] = settings['projects.limit'];
  }
  if (settings['daemon.tickMs'] !== DEFAULTS['daemon.tickMs']) {
    out['daemon.tickMs'] = settings['daemon.tickMs'];
  }
  if (settings['daemon.idleExitMs'] !== DEFAULTS['daemon.idleExitMs']) {
    out['daemon.idleExitMs'] = settings['daemon.idleExitMs'];
  }

  return out;
}
