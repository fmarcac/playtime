/**
 * The interactive settings screen.
 *
 * Redraws its own block in place rather than taking over the terminal, so it
 * scrolls with your scrollback, survives ssh and dumb terminals, and leaves the
 * final settings on screen when it exits. Rendering lives in settings-view so
 * it stays testable; this file is the keyboard loop and nothing else.
 */

import { createInterface, emitKeypressEvents } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';

import { applySetting, DEFINITIONS, resetSetting } from '../core/settings.js';
import type { Definition, Settings } from '../core/settings.js';
import { saveSettings } from '../store/settings.js';
import type { LoadedSettings } from '../store/settings.js';
import { CONFIRM_DISCARD, menuLines, renderPrompt } from './settings-view.js';

const ESC = '';

interface Key {
  name?: string;
  ctrl?: boolean;
}

/** What the user asked for on the way out. */
type Outcome = 'save' | 'discard';

/** Steps an enum setting to its next or previous choice. */
function cycle(settings: Settings, definition: Definition, direction: 1 | -1): Settings {
  const choices = definition.choices;
  if (!choices || choices.length === 0) return settings;

  const current = String(settings[definition.key]);
  const at = choices.indexOf(current);
  const next = choices[(at + direction + choices.length) % choices.length] ?? current;

  const result = applySetting(settings, definition.key, next);
  return result.ok ? result.settings : settings;
}

/** Drops out of raw mode to read a typed value, then restores it. */
async function askFor(definition: Definition, current: string): Promise<string> {
  process.stdin.setRawMode?.(false);
  process.stdout.write(renderPrompt(definition, current));

  const io = createPrompt({ input: process.stdin, output: process.stdout });
  try {
    return (await io.question('  new value (blank to cancel): ')).trim();
  } finally {
    io.close();
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
  }
}

export async function runConfigTui(loaded: LoadedSettings): Promise<number> {
  let settings = loaded.settings;
  let selected = 0;
  let dirty = false;
  let confirming = false;
  let drawn = 0;

  const draw = (): void => {
    // Step back over the block just written and clear from there down.
    if (drawn > 0) process.stdout.write(`${ESC}[${drawn}A${ESC}[0J`);

    const lines = menuLines(settings, loaded.path, selected);
    if (confirming) lines.push('', CONFIRM_DISCARD);

    process.stdout.write(`${lines.join('\n')}\n`);
    drawn = lines.length;
  };

  emitKeypressEvents(process.stdin);
  const keepAlive = createInterface({ input: process.stdin });
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  draw();

  const outcome = await (async (): Promise<Outcome> => {
    try {
      return await new Promise<Outcome>((resolve) => {
        const leave = (why: Outcome): void => {
          process.stdin.off('keypress', onKey);
          resolve(why);
        };

        const onKey = async (_chunk: string, key: Key | undefined): Promise<void> => {
          if (!key) return;

          // While the discard question is up it is the only thing the keys mean.
          if (confirming) {
            if (key.name === 'y') {
              leave('discard');
              return;
            }
            if (key.name === 'n' || key.name === 'escape' || key.name === 'q') {
              confirming = false;
              draw();
            }
            return;
          }

          const definition = DEFINITIONS[selected];
          if (!definition) return;

          if (key.ctrl && key.name === 'c') {
            leave('discard');
            return;
          }

          if (key.name === 'q') {
            leave('save');
            return;
          }

          if (key.name === 'escape') {
            // Nothing to lose means nothing to ask about.
            if (!dirty) {
              leave('discard');
              return;
            }
            confirming = true;
          } else if (key.name === 'up' || key.name === 'k') {
            selected = (selected - 1 + DEFINITIONS.length) % DEFINITIONS.length;
          } else if (key.name === 'down' || key.name === 'j') {
            selected = (selected + 1) % DEFINITIONS.length;
          } else if (key.name === 'right' || key.name === 'left') {
            const before = settings;
            settings = cycle(settings, definition, key.name === 'right' ? 1 : -1);
            if (settings !== before) dirty = true;
          } else if (key.name === 'r') {
            const result = resetSetting(settings, definition.key);
            if (result.ok) {
              settings = result.settings;
              dirty = true;
            }
          } else if (key.name === 'return') {
            // Typing a value needs cooked mode, so the loop pauses around it.
            process.stdin.off('keypress', onKey);
            const value = await askFor(definition, String(settings[definition.key]));

            if (value !== '') {
              const result = applySetting(settings, definition.key, value);
              if (result.ok) {
                settings = result.settings;
                dirty = true;
              } else {
                process.stdout.write(`  ${result.error}\n`);
              }
            }

            drawn = 0;
            process.stdin.on('keypress', onKey);
          } else {
            return;
          }

          draw();
        };

        process.stdin.on('keypress', onKey);
      });
    } finally {
      process.stdin.setRawMode?.(false);
      keepAlive.close();
      process.stdin.pause();
    }
  })();

  if (outcome === 'discard') {
    process.stdout.write(dirty ? '\nChanges discarded\n' : '\nNo changes\n');
    return 0;
  }

  if (dirty) {
    await saveSettings(loaded.path, settings);
    process.stdout.write(`\nSaved to ${loaded.path}\n`);
  } else {
    process.stdout.write('\nNo changes\n');
  }

  return 0;
}
