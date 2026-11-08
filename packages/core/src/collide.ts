import type { Change, FileReport } from "./diff.ts";
import { classify, DEFAULT_PROXIMITY_LINES, type CollisionType } from "./ranges.ts";

const SEVERITY: Record<CollisionType, number> = {
  DIRECT_OVERLAP: 3,
  DUPLICATE_CHANGE: 2,
  PROXIMITY_ALERT: 1,
};

/**
 * Git merges two changes cleanly when both replace exactly the same base lines with
 * exactly the same content. Without a digest on both sides that cannot be known.
 */
function isIdentical(a: Change, b: Change): boolean {
  return (
    a.digest !== null &&
    a.digest === b.digest &&
    a.range[0] === b.range[0] &&
    a.range[1] === b.range[1]
  );
}

function pairCollision(a: Change, b: Change, proximityLines: number): CollisionType | null {
  if (isIdentical(a, b)) return "DUPLICATE_CHANGE";
  return classify(a.range, b.range, proximityLines);
}

/** A collision and the two changes behind it; a change is null on a whole-file side. */
export interface Pair {
  type: CollisionType;
  ours: Change | null;
  theirs: Change | null;
}

/** The most severe collision between two reports of the same path, with its changes. */
export function strongestPair(
  a: FileReport,
  b: FileReport,
  proximityLines: number = DEFAULT_PROXIMITY_LINES,
): Pair | null {
  if (a.path !== b.path) throw new Error(`cannot compare different paths: ${a.path}, ${b.path}`);
  if (a.wholeFile || b.wholeFile) return { type: "DIRECT_OVERLAP", ours: null, theirs: null };
  let strongest: Pair | null = null;
  for (const ours of a.changes) {
    for (const theirs of b.changes) {
      const type = pairCollision(ours, theirs, proximityLines);
      if (type && (strongest === null || SEVERITY[type] > SEVERITY[strongest.type])) {
        strongest = { type, ours, theirs };
      }
    }
  }
  return strongest;
}

/** The most severe collision between two reports of the same path, or null. */
export function collide(
  a: FileReport,
  b: FileReport,
  proximityLines: number = DEFAULT_PROXIMITY_LINES,
): CollisionType | null {
  return strongestPair(a, b, proximityLines)?.type ?? null;
}
