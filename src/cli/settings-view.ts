import { DEFINITIONS } from '../core/settings.js';
import type { Settings } from '../core/settings.js';
import type { LoadedSettings } from '../store/settings.js';

function allowed(choices?: readonly string[], range?: { min: number; max: number }): string {
  if (choices) return choices.join(' | ');
  if (range) return `${range.min} to ${range.max}`;
  return 'any text';
}

export function renderSettings(loaded: LoadedSettings): string {
  const lines = ['PLAYTIME SETTINGS', '', `  ${loaded.path}${loaded.exists ? '' : '  (not created yet)'}`, ''];

  for (const definition of DEFINITIONS) {
    const value = String(loaded.settings[definition.key as keyof Settings]);
    const isDefault = value === String(definition.fallback);

    lines.push(`  ${definition.key}`);
    lines.push(`      ${value}${isDefault ? '  (default)' : ''}`);
    lines.push(`      ${definition.summary}`);
    lines.push(`      ${definition.detail}`);
    lines.push(`      accepts: ${allowed(definition.choices, definition.range)}`);
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
