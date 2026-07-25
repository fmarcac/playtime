import test from 'node:test';
import assert from 'node:assert/strict';

import { clip, intersect, normalize, span, sum, total, union } from './intervals.js';
import type { Interval } from './intervals.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Deterministic generator so a failing property test reproduces exactly. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomIntervals(random: () => number, count: number): Interval[] {
  const out: Interval[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(random() * 1000);
    const length = Math.floor(random() * 100);
    out.push([start, start + length]);
  }
  return out;
}

test('normalize sorts and merges overlapping intervals', () => {
  assert.deepEqual(normalize([[10, 20], [0, 15]]), [[0, 20]]);
});

test('normalize merges intervals that only touch', () => {
  assert.deepEqual(normalize([[0, 10], [10, 20]]), [[0, 20]]);
});

test('normalize keeps disjoint intervals separate', () => {
  assert.deepEqual(normalize([[30, 40], [0, 10]]), [[0, 10], [30, 40]]);
});

test('normalize swallows an interval fully contained in another', () => {
  assert.deepEqual(normalize([[0, 100], [20, 30]]), [[0, 100]]);
});

test('normalize drops zero-length intervals', () => {
  assert.deepEqual(normalize([[5, 5], [10, 20]]), [[10, 20]]);
});

test('normalize drops inverted intervals', () => {
  assert.deepEqual(normalize([[20, 10], [0, 5]]), [[0, 5]]);
});

test('normalize drops non-finite intervals', () => {
  assert.deepEqual(normalize([[Number.NaN, 10], [0, Infinity], [1, 2]]), [[1, 2]]);
});

test('total measures merged length, not raw length', () => {
  assert.equal(total([[0, 10], [5, 20]]), 20);
});

test('sum measures raw length, ignoring overlap', () => {
  assert.equal(sum([[0, 10], [5, 20]]), 25);
});

test('two sessions overlapping by half an hour report wall-clock time', () => {
  const first: Interval = [14 * HOUR, 15 * HOUR];
  const second: Interval = [14.5 * HOUR, 15.5 * HOUR];

  assert.equal(total(union([first], [second])), 90 * MINUTE);
  assert.equal(sum([first, second]), 2 * HOUR);
});

test('union of many concurrent sessions never exceeds the wall clock', () => {
  const concurrent: Interval[] = Array.from({ length: 10 }, () => [0, HOUR]);

  assert.equal(total(union(concurrent)), HOUR);
});

test('clip truncates intervals to the window', () => {
  assert.deepEqual(clip([[0, 100]], [25, 75]), [[25, 75]]);
});

test('clip drops intervals entirely outside the window', () => {
  assert.deepEqual(clip([[0, 10], [200, 300]], [100, 150]), []);
});

test('clip keeps intervals entirely inside the window', () => {
  assert.deepEqual(clip([[110, 120]], [100, 150]), [[110, 120]]);
});

test('intersect returns only the shared portion', () => {
  assert.deepEqual(intersect([[0, 50]], [[25, 100]]), [[25, 50]]);
});

test('intersect of disjoint sets is empty', () => {
  assert.deepEqual(intersect([[0, 10]], [[20, 30]]), []);
});

test('intersect splits when one side has a gap', () => {
  assert.deepEqual(intersect([[0, 100]], [[10, 20], [50, 60]]), [[10, 20], [50, 60]]);
});

test('span covers the first start through the last end', () => {
  assert.deepEqual(span([[50, 60], [0, 10]]), [0, 60]);
});

test('span of nothing is null', () => {
  assert.equal(span([]), null);
});

test('property: normalize is idempotent', () => {
  const random = makeRandom(1);
  for (let i = 0; i < 200; i++) {
    const once = normalize(randomIntervals(random, 8));
    assert.deepEqual(normalize(once), once);
  }
});

test('property: normalize does not depend on input order', () => {
  const random = makeRandom(2);
  for (let i = 0; i < 200; i++) {
    const input = randomIntervals(random, 8);
    assert.deepEqual(normalize([...input].reverse()), normalize(input));
  }
});

test('property: union never exceeds the naive sum', () => {
  const random = makeRandom(3);
  for (let i = 0; i < 200; i++) {
    const a = randomIntervals(random, 5);
    const b = randomIntervals(random, 5);
    assert.ok(total(union(a, b)) <= sum(a) + sum(b));
  }
});

test('property: union never exceeds its own span', () => {
  const random = makeRandom(4);
  for (let i = 0; i < 200; i++) {
    const input = randomIntervals(random, 8);
    const merged = union(input);
    const bounds = span(merged);
    if (bounds === null) {
      assert.equal(total(merged), 0);
      continue;
    }
    assert.ok(total(merged) <= bounds[1] - bounds[0]);
  }
});

test('property: union is commutative', () => {
  const random = makeRandom(5);
  for (let i = 0; i < 200; i++) {
    const a = randomIntervals(random, 5);
    const b = randomIntervals(random, 5);
    assert.deepEqual(union(a, b), union(b, a));
  }
});

test('property: clipping never grows the total', () => {
  const random = makeRandom(6);
  for (let i = 0; i < 200; i++) {
    const input = randomIntervals(random, 8);
    assert.ok(total(clip(input, [200, 800])) <= total(input));
  }
});

test('property: intersecting with self is the normalized self', () => {
  const random = makeRandom(7);
  for (let i = 0; i < 200; i++) {
    const input = randomIntervals(random, 6);
    assert.deepEqual(intersect(input, input), normalize(input));
  }
});
