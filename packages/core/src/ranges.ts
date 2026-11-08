/**
 * A closed interval of lines in base coordinates. `end === start - 1` is an
 * insertion point: it covers no base line but sits between `end` and `start`.
 */
export type Range = readonly [start: number, end: number];

export type CollisionType = "DIRECT_OVERLAP" | "DUPLICATE_CHANGE" | "PROXIMITY_ALERT";

export const DEFAULT_PROXIMITY_LINES = 15;

export function isRange(range: Range): boolean {
  const [start, end] = range;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start - 1;
}

/** The insertion point between base line `line` and `line + 1` (0 = top of file). */
export function insertionAfter(line: number): Range {
  return [line + 1, line];
}

/** Unchanged base lines between two ranges; zero or less means they touch or share lines. */
export function gap(a: Range, b: Range): number {
  return Math.max(a[0], b[0]) - Math.min(a[1], b[1]) - 1;
}

export function classify(
  a: Range,
  b: Range,
  proximityLines: number = DEFAULT_PROXIMITY_LINES,
): CollisionType | null {
  const between = gap(a, b);
  if (between <= 0) return "DIRECT_OVERLAP";
  if (between <= proximityLines) return "PROXIMITY_ALERT";
  return null;
}
