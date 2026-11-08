import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classify, gap, insertionAfter, isRange, type Range } from "../src/index.ts";

describe("isRange", () => {
  it.each<[Range, boolean]>([
    [[1, 1], true],
    [[5, 9], true],
    [[6, 5], true], // insertion point after line 5
    [[1, 0], true], // insertion point at the top of the file
    [[0, 0], false],
    [[7, 5], false],
    [[1.5, 2], false],
  ])("%j → %s", (range, expected) => {
    expect(isRange(range)).toBe(expected);
  });
});

describe("insertionAfter", () => {
  it("is the empty range between line a and a + 1", () => {
    expect(insertionAfter(5)).toEqual([6, 5]);
    expect(insertionAfter(0)).toEqual([1, 0]);
  });
});

describe("gap", () => {
  it.each<[Range, Range, number]>([
    [[5, 6], [8, 9], 1],
    [[5, 6], [7, 8], 0],
    [[5, 9], [7, 8], -2],
    [[1, 10], [30, 40], 19],
  ])("%j to %j is %i unchanged lines", (a, b, expected) => {
    expect(gap(a, b)).toBe(expected);
    expect(gap(b, a)).toBe(expected);
  });
});

describe("classify", () => {
  // Each case mirrors a real `git merge` result recorded while designing (PRD §4).
  it.each<[string, Range, Range, ReturnType<typeof classify>]>([
    ["identical bounds", [10, 20], [10, 20], "DIRECT_OVERLAP"],
    ["sub-range", [10, 20], [12, 14], "DIRECT_OVERLAP"],
    ["partial overlap", [10, 20], [18, 30], "DIRECT_OVERLAP"],
    ["touching modifications (git conflicts)", [5, 6], [7, 8], "DIRECT_OVERLAP"],
    ["one unchanged line between (git merges)", [5, 6], [8, 9], "PROXIMITY_ALERT"],
    ["fifteen unchanged lines between", [1, 10], [26, 30], "PROXIMITY_ALERT"],
    ["sixteen unchanged lines between", [1, 10], [27, 30], null],
    ["insert after 5 vs modify 6 (git conflicts)", insertionAfter(5), [6, 6], "DIRECT_OVERLAP"],
    ["insert after 5 vs modify 5 (git conflicts)", insertionAfter(5), [5, 5], "DIRECT_OVERLAP"],
    ["insert after 5 vs modify 7 (git merges)", insertionAfter(5), [7, 7], "PROXIMITY_ALERT"],
    ["both insert after 5 (git conflicts)", insertionAfter(5), insertionAfter(5), "DIRECT_OVERLAP"],
    ["insert at top vs modify 2", insertionAfter(0), [2, 2], "PROXIMITY_ALERT"],
  ])("%s", (_name, a, b, expected) => {
    expect(classify(a, b)).toBe(expected);
  });

  it("honours a custom proximity distance", () => {
    expect(classify([1, 10], [14, 20], 3)).toBe("PROXIMITY_ALERT");
    expect(classify([1, 10], [15, 20], 3)).toBeNull();
    expect(classify([1, 10], [12, 20], 0)).toBeNull();
  });

  const range = fc
    .tuple(fc.integer({ min: 1, max: 500 }), fc.integer({ min: -1, max: 60 }))
    .map(([start, length]): Range => [start, start + length]);

  it("is symmetric", () => {
    fc.assert(fc.property(range, range, (a, b) => classify(a, b) === classify(b, a)));
  });

  it("calls a pair DIRECT_OVERLAP exactly when they share or touch a line", () => {
    fc.assert(
      fc.property(range, range, (a, b) => {
        const shared = Math.max(a[0], b[0]) <= Math.min(a[1], b[1]) + 1;
        return (classify(a, b) === "DIRECT_OVERLAP") === shared;
      }),
    );
  });
});
