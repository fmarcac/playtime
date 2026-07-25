/**
 * Interval arithmetic over half-open millisecond ranges `[start, end)`.
 *
 * Every duration Playtime reports is a union rather than a sum, so that two
 * harness sessions open at the same time report wall-clock time instead of
 * double-counting it. This module is the whole of that logic and is pure.
 */

export type Interval = readonly [start: number, end: number];

/** Drops intervals that are inverted, empty, or not finite. */
function valid(intervals: Iterable<Interval>): Interval[] {
  const out: Interval[] = [];
  for (const [start, end] of intervals) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= start) continue;
    out.push([start, end]);
  }
  return out;
}

/** Sorts and merges into a minimal set of disjoint intervals. Touching intervals merge. */
export function normalize(intervals: Iterable<Interval>): Interval[] {
  const sorted = valid(intervals).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Interval[] = [];

  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) merged[merged.length - 1] = [last[0], end];
    } else {
      merged.push([start, end]);
    }
  }

  return merged;
}

/** Merges any number of interval lists into one deduplicated set. */
export function union(...lists: Iterable<Interval>[]): Interval[] {
  const all: Interval[] = [];
  for (const list of lists) {
    for (const interval of list) all.push(interval);
  }
  return normalize(all);
}

/** Deduplicated duration: overlapping time is counted once. */
export function total(intervals: Iterable<Interval>): number {
  return sum(normalize(intervals));
}

/** Raw duration: overlapping time is counted once per interval. */
export function sum(intervals: Iterable<Interval>): number {
  let acc = 0;
  for (const [start, end] of valid(intervals)) acc += end - start;
  return acc;
}

/** Restricts to a window, truncating intervals that straddle its edges. */
export function clip(intervals: Iterable<Interval>, window: Interval): Interval[] {
  const [lo, hi] = window;
  const out: Interval[] = [];

  for (const [start, end] of normalize(intervals)) {
    const from = Math.max(start, lo);
    const to = Math.min(end, hi);
    if (to > from) out.push([from, to]);
  }

  return out;
}

/** The time covered by both sets. Used to express blocked time as a subset of busy time. */
export function intersect(a: Iterable<Interval>, b: Iterable<Interval>): Interval[] {
  const left = normalize(a);
  const right = normalize(b);
  const out: Interval[] = [];

  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i]!;
    const r = right[j]!;

    const start = Math.max(l[0], r[0]);
    const end = Math.min(l[1], r[1]);
    if (end > start) out.push([start, end]);

    if (l[1] < r[1]) i++;
    else j++;
  }

  return out;
}

/** Earliest start through latest end, ignoring gaps. Null when there is nothing to span. */
export function span(intervals: Iterable<Interval>): Interval | null {
  const merged = normalize(intervals);
  const first = merged[0];
  const last = merged[merged.length - 1];
  if (!first || !last) return null;
  return [first[0], last[1]];
}
