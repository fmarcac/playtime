/**
 * The interactive settings screen.
 *
 * Line based on purpose: it scrolls with the rest of your terminal, works over
 * ssh and in dumb terminals, and leaves the settings visible after it exits.
 * Rendering lives in settings-view so it stays testable; this is just the loop.
 */

import { createInterface } from 'node:readline/promises';

import { applySetting, resetSetting } from '../core/settings.js';
import type { Settings } from '../core/settings.js';
import { saveSettings } from '../store/settings.js';
import type { LoadedSettings } from '../store/settings.js';
import { definitionAt, renderMenu, renderPrompt } from './settings-view.js';

export async function runConfigTui(loaded: LoadedSettings): Promise<number> {
  const io = createInterface({ input: process.stdin, output: process.stdout });
  let settings: Settings = loaded.settings;
  let dirty = false;

  try {
    for (;;) {
      process.stdout.write(`${renderMenu(settings, loaded.path)}\n`);

      const answer = (await io.question('> ')).trim();
      if (answer === '' ) continue;
      if (answer === 'q' || answer === 'quit') break;

      const reset = /^r\s*(\d+)$/.exec(answer);
      const definition = definitionAt(reset ? (reset[1] ?? '') : answer);

      if (!definition) {
        process.stdout.write('  not a setting number\n\n');
        continue;
      }

      if (reset) {
        const result = resetSetting(settings, definition.key);
        if (result.ok) {
          settings = result.settings;
          dirty = true;
        }
        continue;
      }

      process.stdout.write(renderPrompt(definition, String(settings[definition.key])));
      const value = (await io.question('  new value (blank to cancel): ')).trim();
      if (value === '') continue;

      const result = applySetting(settings, definition.key, value);
      if (!result.ok) {
        process.stdout.write(`  ${result.error}\n\n`);
        continue;
      }

      settings = result.settings;
      dirty = true;
    }
  } finally {
    io.close();
  }

  if (dirty) {
    await saveSettings(loaded.path, settings);
    process.stdout.write(`\nSaved to ${loaded.path}\n`);
  }

  return 0;
}
