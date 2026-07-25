import test from 'node:test';
import assert from 'node:assert/strict';

import { selectProject } from './select.js';

const PROJECTS = [
  '/home/dev/git/playtime',
  '/home/dev/git/dashboard',
  '/home/dev/infra',
  '/opt/playtime-experiments',
];

test('an exact path selects that project', () => {
  assert.deepEqual(selectProject('/home/dev/infra', PROJECTS), {
    kind: 'one',
    project: '/home/dev/infra',
  });
});

test('a basename selects the project even when the word appears elsewhere', () => {
  // Both `/home/dev/git/playtime` and `/opt/playtime-experiments` contain
  // "playtime", but only one is actually named it.
  assert.deepEqual(selectProject('playtime', PROJECTS), {
    kind: 'one',
    project: '/home/dev/git/playtime',
  });
});

test('a substring selects when no basename matches', () => {
  assert.deepEqual(selectProject('jeopard', PROJECTS), {
    kind: 'one',
    project: '/home/dev/git/dashboard',
  });
});

test('matching is case insensitive', () => {
  assert.deepEqual(selectProject('REFORGER', PROJECTS), {
    kind: 'one',
    project: '/home/dev/infra',
  });
});

test('an ambiguous filter returns every candidate', () => {
  const result = selectProject('git', PROJECTS);

  assert.equal(result.kind, 'many');
  assert.deepEqual(result.kind === 'many' ? result.matches : [], [
    '/home/dev/git/playtime',
    '/home/dev/git/dashboard',
  ]);
});

test('a filter that matches nothing says nothing', () => {
  assert.deepEqual(selectProject('nowhere', PROJECTS), { kind: 'none' });
});

test('selecting from an empty project list matches nothing', () => {
  assert.deepEqual(selectProject('anything', []), { kind: 'none' });
});
