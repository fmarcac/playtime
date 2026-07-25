/**
 * Building and merging harness hook configuration.
 *
 * Kept separate from the file writing so installing is a pure, testable
 * transformation of whatever settings the user already has.
 */

import type { Harness } from '../core/events.js';

export interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

export type HookMap = Record<string, HookMatcher[]>;

/** The unique path suffix that identifies a hook as one of ours. */
export const EMIT_MARKER = 'adapters/shared/emit.sh';

const LIFECYCLE: readonly { event: string; matcher?: string }[] = [
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
  { event: 'UserPromptSubmit' },
  { event: 'Stop' },
  { event: 'Notification' },
  // Tool completions are what close a permission wait, so they need a matcher.
  { event: 'PostToolUse', matcher: '*' },
];

export function isPlaytimeHook(entry: HookEntry): boolean {
  return entry.command.includes(EMIT_MARKER);
}

export function playtimeHooks(emitPath: string, harness: Harness): HookMap {
  const map: HookMap = {};

  for (const { event, matcher } of LIFECYCLE) {
    const entry: HookEntry = {
      type: 'command',
      command: `"${emitPath}" ${harness} ${event}`,
      timeout: 5,
    };
    map[event] = [matcher === undefined ? { hooks: [entry] } : { matcher, hooks: [entry] }];
  }

  return map;
}

/** Adds our hooks, replacing any we installed before and leaving everything else alone. */
export function mergeHooks(existing: HookMap | undefined, ours: HookMap): HookMap {
  const merged: HookMap = {};

  for (const [event, groups] of Object.entries(existing ?? {})) {
    // Strip only our own entries, keeping any group that still has other hooks in it.
    const kept = groups
      .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isPlaytimeHook(hook)) }))
      .filter((group) => group.hooks.length > 0);

    if (kept.length > 0) merged[event] = kept;
  }

  for (const [event, groups] of Object.entries(ours)) {
    merged[event] = [...(merged[event] ?? []), ...groups];
  }

  return merged;
}
