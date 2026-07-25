import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySetting,
  customised,
  defaultSettings,
  DEFINITIONS,
  parseSettings,
  resetSetting,
} from './settings.js';

test('every setting has a key, a summary and an explanation', () => {
  assert.ok(DEFINITIONS.length > 0);

  for (const definition of DEFINITIONS) {
    assert.ok(definition.summary.length > 0, `${definition.key} needs a summary`);
    assert.ok(definition.detail.length > 0, `${definition.key} needs a detail`);
  }
});

test('counting defaults to deduplicated wall clock', () => {
  assert.equal(defaultSettings().count, 'wallclock');
});

test('parsing nothing yields the defaults without complaint', () => {
  const result = parseSettings(undefined);

  assert.deepEqual(result.settings, defaultSettings());
  assert.deepEqual(result.problems, []);
});

test('a stored value overrides its default', () => {
  const result = parseSettings({ count: 'stacked' });

  assert.equal(result.settings.count, 'stacked');
  assert.deepEqual(result.problems, []);
});

test('settings not mentioned in the file keep their defaults', () => {
  const result = parseSettings({ count: 'stacked' });

  assert.equal(result.settings['projects.limit'], defaultSettings()['projects.limit']);
});

test('an unknown key is reported rather than silently ignored', () => {
  const result = parseSettings({ 'count.mode': 'stacked' });

  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? '', /count\.mode/);
});

test('a value outside the allowed choices falls back and is reported', () => {
  const result = parseSettings({ count: 'sideways' });

  assert.equal(result.settings.count, 'wallclock');
  assert.match(result.problems[0] ?? '', /sideways/);
});

test('a number outside its range falls back and is reported', () => {
  const result = parseSettings({ 'projects.limit': 0 });

  assert.equal(result.settings['projects.limit'], defaultSettings()['projects.limit']);
  assert.equal(result.problems.length, 1);
});

test('a value of the wrong type falls back and is reported', () => {
  const result = parseSettings({ 'projects.limit': 'lots' });

  assert.equal(result.settings['projects.limit'], defaultSettings()['projects.limit']);
  assert.equal(result.problems.length, 1);
});

test('a file that is not an object at all is reported, not thrown on', () => {
  const result = parseSettings('nonsense');

  assert.deepEqual(result.settings, defaultSettings());
  assert.equal(result.problems.length, 1);
});

test('setting a choice value works', () => {
  const result = applySetting(defaultSettings(), 'count', 'stacked');

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.settings.count, 'stacked');
});

test('setting a number parses it out of the string the shell gave us', () => {
  const result = applySetting(defaultSettings(), 'projects.limit', '25');

  assert.equal(result.ok && result.settings['projects.limit'], 25);
});

test('setting an unknown key explains what the keys are', () => {
  const result = applySetting(defaultSettings(), 'colour', 'blue');

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : '', /colour/);
});

test('setting an invalid choice lists the valid ones', () => {
  const result = applySetting(defaultSettings(), 'count', 'sideways');

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : '', /wallclock/);
  assert.match(!result.ok ? result.error : '', /stacked/);
});

test('setting a number outside its range says what the range is', () => {
  const result = applySetting(defaultSettings(), 'daemon.tickMs', '5');

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : '', /1000/);
});

test('setting a number to something non-numeric is refused', () => {
  assert.equal(applySetting(defaultSettings(), 'projects.limit', 'lots').ok, false);
});

test('a format string is taken as given', () => {
  const result = applySetting(defaultSettings(), 'statusline.format', '{open} up');

  assert.equal(result.ok && result.settings['statusline.format'], '{open} up');
});

test('resetting a key puts its default back', () => {
  const changed = applySetting(defaultSettings(), 'count', 'stacked');
  assert.ok(changed.ok);

  const reset = resetSetting(changed.settings, 'count');

  assert.equal(reset.ok && reset.settings.count, 'wallclock');
});

test('resetting an unknown key is an error', () => {
  assert.equal(resetSetting(defaultSettings(), 'nope').ok, false);
});

test('untouched settings are not written to the file', () => {
  assert.deepEqual(customised(defaultSettings()), {});
});

test('only changed settings are written to the file', () => {
  const changed = applySetting(defaultSettings(), 'count', 'stacked');
  assert.ok(changed.ok);

  assert.deepEqual(customised(changed.settings), { count: 'stacked' });
});

test('what gets written parses back to what was saved', () => {
  const changed = applySetting(defaultSettings(), 'projects.limit', '30');
  assert.ok(changed.ok);

  const roundTripped = parseSettings(customised(changed.settings));

  assert.deepEqual(roundTripped.settings, changed.settings);
  assert.deepEqual(roundTripped.problems, []);
});
