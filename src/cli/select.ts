import { basename } from 'node:path';

export type Selection =
  | { kind: 'one'; project: string }
  | { kind: 'many'; matches: string[] }
  | { kind: 'none' };

/**
 * Resolves what the user typed to a tracked project. An exact path wins
 * outright; otherwise the basename is tried before a loose substring, so
 * `playtime` finds `~/git/playtime` rather than every path containing the word.
 */
export function selectProject(filter: string, projects: readonly string[]): Selection {
  const needle = filter.toLowerCase();

  const exact = projects.find((project) => project.toLowerCase() === needle);
  if (exact) return { kind: 'one', project: exact };

  const byName = projects.filter((project) => basename(project).toLowerCase() === needle);
  const matches = byName.length > 0
    ? byName
    : projects.filter((project) => project.toLowerCase().includes(needle));

  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'one', project: matches[0] as string };
  return { kind: 'many', matches };
}
