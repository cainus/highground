import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isRange, translate, type Hunk, type Range } from "../src/index.ts";

const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number): Hunk => ({
  oldStart,
  oldCount,
  newStart,
  newCount,
  added: [],
});

describe("translate", () => {
  // Base A → base B: line 3 modified into two lines, lines 8–9 deleted, two lines inserted after 15.
  const hunks = [hunk(3, 1, 3, 2), hunk(8, 2, 8, 0), hunk(15, 0, 15, 2)];

  it.each<[string, Range, Range, boolean]>([
    ["a line before every change stays put", [1, 2], [1, 2], true],
    ["a line after a growth shifts down", [5, 5], [6, 6], true],
    ["a line after a deletion shifts back", [10, 10], [9, 9], true],
    ["a line after an insertion shifts down", [16, 16], [17, 17], true],
    ["a line beside a change is still exact", [4, 4], [5, 5], true],
    ["a range sharing a modified line widens over its new lines", [3, 3], [3, 4], false],
    ["a range running into a deletion keeps its surviving lines", [6, 9], [7, 8], false],
    ["a range wholly deleted becomes an insertion point", [8, 9], [9, 8], false],
    ["an interior insertion is absorbed", [14, 16], [13, 17], false],
    ["an insertion point far from changes stays exact", [12, 11], [11, 10], true],
    ["an insertion point where lines were inserted widens over them", [16, 15], [15, 16], false],
    ["the top-of-file insertion point", [1, 0], [1, 0], true],
  ])("%s", (_name, range, expected, exact) => {
    expect(translate(range, hunks)).toEqual({ range: expected, exact });
  });

  it("is the identity between equal bases", () => {
    expect(translate([4, 9], [])).toEqual({ range: [4, 9], exact: true });
  });

  it("accepts hunks in any order", () => {
    expect(translate([10, 10], [...hunks].reverse())).toEqual({ range: [9, 9], exact: true });
  });
});

type Fate = "keep" | "modify" | "delete";

/** Builds base B from base A by an edit script, with the hunks `git diff -U0 A B` would describe. */
function applyScript(size: number, fates: Fate[], inserts: number[]) {
  const a = Array.from({ length: size }, (_, i) => `a${i + 1}`);
  const b: string[] = [];
  const hunks: Hunk[] = [];
  let next = 1; // next base A line
  let open: Hunk | null = null;
  let fresh = 0;
  const start = () => (open ??= hunk(next, 0, b.length + 1, 0));
  const close = () => {
    if (!open) return;
    if (open.oldCount === 0) open.oldStart = next - 1;
    if (open.newCount === 0) open.newStart = b.length;
    hunks.push(open);
    open = null;
  };
  const insert = (count: number) => {
    for (let k = 0; k < count; k++) {
      start().newCount++;
      b.push(`new${++fresh}`);
    }
  };
  insert(inserts[0] ?? 0);
  fates.forEach((fate, i) => {
    if (fate === "keep") {
      close();
      b.push(a[i] as string);
    } else {
      start().oldCount++;
      if (fate === "modify") {
        (open as unknown as Hunk).newCount++;
        b.push(`new${++fresh}`);
      }
    }
    next++;
    insert(inserts[i + 1] ?? 0);
  });
  close();
  return { a, b, hunks };
}

const script = fc.integer({ min: 1, max: 30 }).chain((size) =>
  fc.tuple(
    fc.constant(size),
    fc.array(fc.constantFrom<Fate[]>("keep", "keep", "keep", "modify", "delete"), {
      minLength: size,
      maxLength: size,
    }),
    fc.array(fc.oneof(fc.constant(0), fc.constant(0), fc.integer({ min: 1, max: 3 })), {
      minLength: size + 1,
      maxLength: size + 1,
    }),
  ),
);

describe("translate properties", () => {
  it("maps every unchanged line exactly onto the same content", () => {
    fc.assert(
      fc.property(script, ([size, fates, inserts]) => {
        const { a, b, hunks } = applyScript(size, fates, inserts);
        fates.forEach((fate, i) => {
          if (fate !== "keep") return;
          const { range, exact } = translate([i + 1, i + 1], hunks);
          expect(exact).toBe(true);
          expect(range[0]).toBe(range[1]);
          expect(b[range[0] - 1]).toBe(a[i]);
        });
      }),
    );
  });

  it("always returns a valid range that covers the content it came from", () => {
    fc.assert(
      fc.property(
        script.chain(([size, fates, inserts]) =>
          fc.tuple(
            fc.constant(applyScript(size, fates, inserts)),
            fc.integer({ min: 1, max: size + 1 }),
            fc.integer({ min: -1, max: 6 }),
          ),
        ),
        ([{ a, b, hunks }, start, length]) => {
          const end = Math.min(start + length, a.length);
          if (end < start - 1) return;
          const { range } = translate([start, end], hunks);
          expect(isRange(range)).toBe(true);
          // Every surviving base-A line of the range lands inside the translated range.
          for (let line = start; line <= end; line++) {
            const at = b.indexOf(a[line - 1] as string) + 1;
            if (at > 0) expect(at >= range[0] && at <= range[1]).toBe(true);
          }
        },
      ),
    );
  });
});
