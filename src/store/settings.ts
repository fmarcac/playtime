import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { customised, defaultSettings, parseSettings } from '../core/settings.js';
import type { Settings } from '../core/settings.js';
import { writeAtomic } from './jsonl.js';

export interface LoadedSettings {
  settings: Settings;
  problems: string[];
  path: string;
  exists: boolean;
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const config = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(config, 'playtime', 'config.json');
}

export async function loadSettings(env: NodeJS.ProcessEnv = process.env): Promise<LoadedSettings> {
  const path = settingsPath(env);

  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) return { settings: defaultSettings(), problems: [], path, exists: false };

  try {
    const parsed = parseSettings(JSON.parse(text));
    return { ...parsed, path, exists: true };
  } catch {
    return {
      settings: defaultSettings(),
      problems: [`${path} is not valid JSON, so defaults are in use`],
      path,
      exists: true,
    };
  }
}

export async function saveSettings(path: string, settings: Settings): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(customised(settings), null, 2)}\n`);
}
