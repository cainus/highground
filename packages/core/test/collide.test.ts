import { describe, expect, it } from "vitest";
import { collide, strongestPair, type Change, type FileReport, type Range } from "../src/index.ts";

/** A change with no digest — e.g. an agent's announced intent. */
const intent = (range: Range): Change => ({ range, digest: null });
const edit = (range: Range, digest: string): Change => ({ range, digest });

const report = (changes: Change[], wholeFile: FileReport["wholeFile"] = false): FileReport => ({
  path: "a.ts",
  wholeFile,
  changes,
});

describe("collide", () => {
  it("returns the most severe collision between any two changes", () => {
    expect(
      collide(
        report([intent([1, 2]), intent([40, 41])]),
        report([intent([10, 10]), intent([42, 42])]),
      ),
    ).toBe("DIRECT_OVERLAP");
    expect(collide(report([intent([1, 2])]), report([intent([10, 10])]))).toBe("PROXIMITY_ALERT");
    expect(collide(report([intent([1, 2])]), report([intent([100, 100])]))).toBeNull();
  });

  describe("identical changes, which git merges cleanly", () => {
    it("are a DUPLICATE_CHANGE when range and digest both match", () => {
      expect(collide(report([edit([3, 4], "x")]), report([edit([3, 4], "x")]))).toBe(
        "DUPLICATE_CHANGE",
      );
      expect(collide(report([edit([4, 3], "x")]), report([edit([4, 3], "x")]))).toBe(
        "DUPLICATE_CHANGE",
      );
    });

    it("are a DIRECT_OVERLAP when the content differs", () => {
      expect(collide(report([edit([3, 4], "x")]), report([edit([3, 4], "y")]))).toBe(
        "DIRECT_OVERLAP",
      );
    });

    it("are a DIRECT_OVERLAP when the ranges differ, even with the same content", () => {
      expect(collide(report([edit([3, 4], "x")]), report([edit([3, 3], "x")]))).toBe(
        "DIRECT_OVERLAP",
      );
    });

    it("are never assumed without a digest", () => {
      expect(collide(report([intent([3, 4])]), report([intent([3, 4])]))).toBe("DIRECT_OVERLAP");
      expect(collide(report([intent([3, 4])]), report([edit([3, 4], "x")]))).toBe("DIRECT_OVERLAP");
    });

    it("rank below a real overlap elsewhere in the file", () => {
      const a = report([edit([3, 3], "x"), edit([20, 20], "p")]);
      const b = report([edit([3, 3], "x"), edit([20, 20], "q")]);
      expect(collide(a, b)).toBe("DIRECT_OVERLAP");
    });

    it("rank above a proximity alert", () => {
      const a = report([edit([3, 3], "x"), edit([20, 20], "p")]);
      const b = report([edit([3, 3], "x"), edit([25, 25], "q")]);
      expect(collide(a, b)).toBe("DUPLICATE_CHANGE");
      expect(collide(b, a)).toBe("DUPLICATE_CHANGE");
    });
  });

  it("treats a whole-file change as overlapping anything in the same path", () => {
    expect(collide(report([], "deleted"), report([intent([500, 500])]))).toBe("DIRECT_OVERLAP");
    expect(collide(report([intent([1, 1])]), report([], "deleted"))).toBe("DIRECT_OVERLAP");
    expect(collide(report([], "deleted"), report([]))).toBe("DIRECT_OVERLAP");
  });

  it("finds nothing when either side has no changes", () => {
    expect(collide(report([]), report([intent([1, 1])]))).toBeNull();
  });

  it("passes the proximity distance through", () => {
    expect(collide(report([intent([1, 1])]), report([intent([5, 5])]), 2)).toBeNull();
    expect(collide(report([intent([1, 1])]), report([intent([5, 5])]), 3)).toBe("PROXIMITY_ALERT");
  });

  it("refuses to compare different paths", () => {
    expect(() => collide(report([]), { path: "b.ts", wholeFile: false, changes: [] })).toThrow(
      /path/,
    );
  });
});

describe("strongestPair", () => {
  it("names the two changes behind the most severe collision", () => {
    const a = report([intent([1, 1]), intent([30, 31])]);
    const b = report([intent([5, 5]), intent([31, 40])]);
    expect(strongestPair(a, b)).toEqual({
      type: "DIRECT_OVERLAP",
      ours: intent([30, 31]),
      theirs: intent([31, 40]),
    });
  });

  it("names no change on a whole-file side", () => {
    expect(strongestPair(report([], "deleted"), report([intent([7, 9])]))).toEqual({
      type: "DIRECT_OVERLAP",
      ours: null,
      theirs: null,
    });
  });

  it("is null when nothing collides", () => {
    expect(strongestPair(report([intent([1, 1])]), report([intent([90, 90])]))).toBeNull();
  });
});
