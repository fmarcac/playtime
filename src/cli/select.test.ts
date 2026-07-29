import test from 'node:test';
import assert from 'node:assert/strict';

import { selectProject } from './select.js';

const PROJECTS = [
  '/home/dev/work/api',
  '/home/dev/work/dashboard',
  '/home/dev/infra',
  '/opt/api-experiments',
];

test('an exact path selects that project', () => {
  assert.deepEqual(selectProject('/home/dev/infra', PROJECTS), {
    kind: 'one',
    project: '/home/dev/infra',
  });
});

test('a basename selects the project even when the word appears elsewhere', () => {
  // Both `/home/dev/work/api` and `/opt/api-experiments` contain
  // "api", but only one is actually named it.
  assert.deepEqual(selectProject('api', PROJECTS), {
    kind: 'one',
    project: '/home/dev/work/api',
  });
});

test('a substring selects when no basename matches', () => {
  assert.deepEqual(selectProject('dashb', PROJECTS), {
    kind: 'one',
    project: '/home/dev/work/dashboard',
  });
});

test('matching is case insensitive', () => {
  assert.deepEqual(selectProject('INFRA', PROJECTS), {
    kind: 'one',
    project: '/home/dev/infra',
  });
});

test('an ambiguous filter returns every candidate', () => {
  const result = selectProject('work', PROJECTS);

  assert.equal(result.kind, 'many');
  assert.deepEqual(result.kind === 'many' ? result.matches : [], [
    '/home/dev/work/api',
    '/home/dev/work/dashboard',
  ]);
});

test('a filter that matches nothing says nothing', () => {
  assert.deepEqual(selectProject('nowhere', PROJECTS), { kind: 'none' });
});

test('selecting from an empty project list matches nothing', () => {
  assert.deepEqual(selectProject('anything', []), { kind: 'none' });
});
