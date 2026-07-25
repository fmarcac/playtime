/**
 * Wiring Playtime into each harness.
 *
 * Every install is idempotent and additive: existing hooks are preserved and
 * only Playtime's own entries are replaced. Files are backed up before being
 * rewritten, since these are settings the user cares about.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Harness } from '../core/events.js';
import { isMissingFile } from '../store/jsonl.js';
import { mergeHooks, playtimeHooks } from './hooks-config.js';
import type { HookMap } from './hooks-config.js';

export interface InstallResult {
  harness: Harness;
  target: string;
  status: 'installed' | 'unchanged' | 'would install' | 'failed';
  detail?: string;
}

/** dist/cli/install.js sits three levels below the package root. */
export function packageRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

export function emitScriptPath(): string {
  return join(packageRoot(), 'adapters', 'shared', 'emit.sh');
}

export function daemonEntryPath(): string {
  return join(packageRoot(), 'dist', 'daemon', 'main.js');
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new Error(`${file} is not valid JSON, so it was left alone`);
  }
}

async function writeJsonWithBackup(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await copyFile(file, `${file}.playtime-backup`).catch(() => undefined);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  return join(env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'settings.json');
}

function codexHooksPath(env: NodeJS.ProcessEnv): string {
  return join(env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'hooks.json');
}

function openCodePluginPath(env: NodeJS.ProcessEnv): string {
  const config = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  return join(config, 'opencode', 'plugin', 'playtime.js');
}

/**
 * Claude Code keeps hooks under a top-level `hooks` key in settings.json, while
 * Codex puts the events at the root of its own hooks.json.
 */
async function installHookFile(
  harness: Harness,
  target: string,
  nested: boolean,
): Promise<InstallResult> {
  const settings = (await readJsonObject(target)) ?? {};
  const current = (nested ? settings['hooks'] : settings) as HookMap | undefined;

  const merged = mergeHooks(current, playtimeHooks(emitScriptPath(), harness));
  const next = nested ? { ...settings, hooks: merged } : merged;

  if (JSON.stringify(next) === JSON.stringify(settings)) {
    return { harness, target, status: 'unchanged' };
  }

  await writeJsonWithBackup(target, next);
  return { harness, target, status: 'installed' };
}

/**
 * OpenCode loads plugins from its config directory. Rather than copying the
 * plugin, drop in a one-line re-export so `npm update` moves the installation
 * forward without a reinstall.
 */
async function installOpenCode(target: string): Promise<InstallResult> {
  const source = join(packageRoot(), 'dist', 'adapters', 'opencode', 'plugin.js');
  const contents = `export { PlaytimePlugin } from ${JSON.stringify(source)};\n`;

  const existing = await readFile(target, 'utf8').catch(() => null);
  if (existing === contents) return { harness: 'opencode', target, status: 'unchanged' };

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
  return { harness: 'opencode', target, status: 'installed' };
}

export function installTarget(harness: Harness, env: NodeJS.ProcessEnv = process.env): string {
  switch (harness) {
    case 'claude-code':
      return claudeSettingsPath(env);
    case 'codex':
      return codexHooksPath(env);
    case 'opencode':
      return openCodePluginPath(env);
  }
}

export async function install(
  harness: Harness,
  options: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<InstallResult> {
  const env = options.env ?? process.env;
  const target = installTarget(harness, env);

  if (options.dryRun) return { harness, target, status: 'would install' };

  try {
    switch (harness) {
      case 'claude-code':
        return await installHookFile(harness, target, true);
      case 'codex':
        return await installHookFile(harness, target, false);
      case 'opencode':
        return await installOpenCode(target);
    }
  } catch (error) {
    return { harness, target, status: 'failed', detail: (error as Error).message };
  }
}
