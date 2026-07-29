import { DEFINITIONS } from '../core/settings.js';
import type { Definition, Settings } from '../core/settings.js';
import type { LoadedSettings } from '../store/settings.js';

export function allowedValues(definition: Definition): string {
  if (definition.choices) return definition.choices.join(' | ');
  if (definition.range) return `${definition.range.min} to ${definition.range.max}`;
  return 'any text';
}

function valueOf(settings: Settings, definition: Definition): string {
  return String(settings[definition.key]);
}

/** The non-interactive listing, used when output is piped. */
export function renderSettings(loaded: LoadedSettings): string {
  const lines = [
    'PLAYTIME SETTINGS',
    '',
    `  ${loaded.path}${loaded.exists ? '' : '  (not created yet)'}`,
    '',
  ];

  for (const definition of DEFINITIONS) {
    const value = valueOf(loaded.settings, definition);
    const isDefault = value === String(definition.fallback);

    lines.push(`  ${definition.key}`);
    lines.push(`      ${value}${isDefault ? '  (default)' : ''}`);
    lines.push(`      ${definition.summary}`);
    lines.push(`      ${definition.detail}`);
    lines.push(`      accepts: ${allowedValues(definition)}`);
    lines.push('');
  }

  if (loaded.problems.length > 0) {
    lines.push('  Problems');
    for (const problem of loaded.problems) lines.push(`    ${problem}`);
    lines.push('');
  }

  lines.push('  playtime config set <key> <value>     change one');
  lines.push('  playtime config unset <key>           put its default back');

  return `${lines.join('\n')}\n`;
}

/**
 * The interactive menu as an array of lines, so the caller knows exactly how
 * many rows to move the cursor back over when it redraws in place.
 *
 * `selected` of -1 highlights nothing, which is what the plain listing wants.
 */
export function menuLines(settings: Settings, path: string, selected = -1): string[] {
  const keys = DEFINITIONS.map((entry) => entry.key);
  const values = DEFINITIONS.map((entry) => valueOf(settings, entry));

  const keyWidth = keys.reduce((max, key) => Math.max(max, key.length), 0);
  const valueWidth = values.reduce((max, value) => Math.max(max, Math.min(value.length, 28)), 0);

  const rows = DEFINITIONS.map((definition, index) => {
    const value = (values[index] ?? '').slice(0, 28).padEnd(valueWidth);
    const changed = values[index] !== String(definition.fallback);
    const cycles = definition.choices ? ' ←→' : '';
    const body = `${changed ? '*' : ' '} ${definition.key.padEnd(keyWidth)}  ${value}  ${definition.summary}${cycles}`;

    return index === selected ? `\u001b[7m> ${body}\u001b[0m` : `  ${body}`;
  });

  return [
    'PLAYTIME SETTINGS',
    '',
    `  ${path}`,
    '',
    ...rows,
    '',
    '  ↑↓ move   ←→ change   enter type a value   r reset   q save   esc discard',
  ];
}

/** Asked before escape throws away edits, so a stray keypress cannot lose them. */
export const CONFIRM_DISCARD = '  Discard changes? y quits without saving, n goes back';

/** The numbered, non-interactive rendering. */
export function renderMenu(settings: Settings, path: string): string {
  const keys = DEFINITIONS.map((entry) => entry.key);
  const values = DEFINITIONS.map((entry) => valueOf(settings, entry));

  const keyWidth = keys.reduce((max, key) => Math.max(max, key.length), 0);
  const valueWidth = values.reduce((max, value) => Math.max(max, Math.min(value.length, 28)), 0);

  const rows = DEFINITIONS.map((definition, index) => {
    const value = (values[index] ?? '').slice(0, 28).padEnd(valueWidth);
    const marker = values[index] === String(definition.fallback) ? ' ' : '*';
    return `  ${marker} ${String(index + 1).padStart(2)}  ${definition.key.padEnd(keyWidth)}  ${value}  ${definition.summary}`;
  });

  return [
    'PLAYTIME SETTINGS',
    '',
    `  ${path}`,
    '',
    ...rows,
    '',
    '  * marks a value you have changed',
    '  number to edit, r <number> to reset, q to save and quit',
    '',
  ].join('\n');
}

export function renderPrompt(definition: Definition, current: string): string {
  return [
    '',
    `  ${definition.key}`,
    `    ${definition.detail}`,
    `    accepts: ${allowedValues(definition)}`,
    `    current: ${current}`,
    '',
  ].join('\n');
}

export function definitionAt(choice: string): Definition | null {
  const index = Number(choice.trim());
  if (!Number.isInteger(index) || index < 1 || index > DEFINITIONS.length) return null;
  return DEFINITIONS[index - 1] ?? null;
}
