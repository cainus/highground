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

/** The most severe collision between two reports of the same path, or null. */
export function collide(
  a: FileReport,
  b: FileReport,
  proximityLines: number = DEFAULT_PROXIMITY_LINES,
): CollisionType | null {
  if (a.path !== b.path) throw new Error(`cannot compare different paths: ${a.path}, ${b.path}`);
  if (a.wholeFile || b.wholeFile) return "DIRECT_OVERLAP";
  let strongest: CollisionType | null = null;
  for (const ca of a.changes) {
    for (const cb of b.changes) {
      const found = pairCollision(ca, cb, proximityLines);
      if (found && (strongest === null || SEVERITY[found] > SEVERITY[strongest])) strongest = found;
    }
  }
  return strongest;
}
