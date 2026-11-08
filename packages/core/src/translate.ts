import { hunkToRange, type Hunk } from "./diff.ts";
import { gap, type Range } from "./ranges.ts";

export interface Translation {
  range: Range;
  /** False when the range met a change between the two bases, so it was widened over it. */
  exact: boolean;
}

/** A hunk's span on the new side, in the same notation as `hunkToRange` for the old side. */
function newSide(hunk: Hunk): Range {
  if (hunk.newCount === 0) return [hunk.newStart + 1, hunk.newStart];
  return [hunk.newStart, hunk.newStart + hunk.newCount - 1];
}

/** True when the range has a line in the span, or the span is an insertion strictly inside it. */
function shares(range: Range, span: Range): boolean {
  return range[0] <= span[1] && span[0] <= range[1];
}

/**
 * Maps a range from base A to base B, given the hunks of `git diff -U0 A B`. Lines
 * unchanged between the bases map exactly; a range that meets a change is widened to
 * cover what replaced it, and reported as inexact.
 */
export function translate(range: Range, hunks: Hunk[]): Translation {
  const spans = hunks.map((hunk) => ({ old: hunkToRange(hunk), next: newSide(hunk) }));

  /** Where base-A line `line` lands in B; inside a changed span it lands on that span's edge. */
  const mapLine = (line: number, edge: 0 | 1): number => {
    let offset = 0;
    for (const { old, next } of spans) {
      if (old[0] <= line && line <= old[1]) return next[edge];
      if (old[1] < line) offset += next[1] - next[0] - (old[1] - old[0]);
    }
    return line + offset;
  };

  const [start, end] = range;
  if (end === start - 1) {
    // An insertion point: one that meets a change takes on that change's new span.
    const met = spans.find(({ old }) => shares(range, old) || (old[0] === start && old[1] === end));
    if (met) return { range: met.next, exact: false };
    const after = mapLine(end, 1);
    return { range: [after + 1, after], exact: spans.every(({ old }) => gap(range, old) > 0) };
  }
  return {
    range: [mapLine(start, 0), mapLine(end, 1)],
    exact: !spans.some(({ old }) => shares(range, old)),
  };
}
