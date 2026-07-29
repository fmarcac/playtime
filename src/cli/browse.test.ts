import test from 'node:test';
import assert from 'node:assert/strict';

import { step } from './browse.js';

test('tab moves forward and shift-tab moves back', () => {
  assert.equal(step({ name: 'tab' }), 1);
  assert.equal(step({ name: 'tab', shift: true }), -1);
});

test('the arrow keys move too, since a tab strip looks like it should', () => {
  assert.equal(step({ name: 'right' }), 1);
  assert.equal(step({ name: 'left' }), -1);
});

test('a key that means nothing here moves nothing', () => {
  assert.equal(step({ name: 'a' }), 0);
  assert.equal(step({ name: 'up' }), 0);
  assert.equal(step({}), 0);
});
