import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  capChanges,
  invertHunks,
  isRange,
  repoFromRemote,
  toBase,
  toWorking,
  type Change,
  type Hunk,
  type Range,
} from "../src/index.ts";

const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number): Hunk => ({
  oldStart,
  oldCount,
  newStart,
  newCount,
  added: [],
});

describe("repoFromRemote", () => {
  it.each([
    ["git@github.com:acme/api.git", "github.com/acme/api"],
    ["git@github.com:acme/api", "github.com/acme/api"],
    ["https://github.com/acme/api.git", "github.com/acme/api"],
    ["https://github.com/acme/api/", "github.com/acme/api"],
    ["https://x-access-token:abc@github.com/acme/api.git", "github.com/acme/api"],
    ["ssh://git@github.com/acme/api.git", "github.com/acme/api"],
    ["ssh://git@github.com:22/acme/api.git", "github.com/acme/api"],
    ["git://github.com/acme/api.git", "github.com/acme/api"],
    ["https://GitHub.com/Acme/api.git", "github.com/Acme/api"],
  ])("names %s", (url, repo) => {
    expect(repoFromRemote(url)).toBe(repo);
  });

  it.each([
    ["a local path", "/srv/git/api.git"],
    ["a file URL", "file:///srv/git/api.git"],
    ["a nested group", "https://gitlab.com/acme/platform/api.git"],
    ["a bare host", "https://github.com/"],
    ["nothing", ""],
  ])("cannot name %s", (_name, url) => {
    expect(repoFromRemote(url)).toBeNull();
  });
});

describe("working-copy and base coordinates", () => {
  // Base → working copy: line 3 became two lines, lines 8–9 deleted, two lines added after 15.
  const hunks = [hunk(3, 1, 3, 2), hunk(8, 2, 8, 0), hunk(15, 0, 15, 2)];

  it("inverts hunks so they read from the working copy to the base", () => {
    expect(invertHunks(hunks)).toEqual([hunk(3, 2, 3, 1), hunk(8, 0, 8, 2), hunk(15, 2, 15, 0)]);
  });

  it.each<[string, Range, Range, boolean]>([
    ["an untouched line before every change", [1, 2], [1, 2], true],
    ["a line after a growth", [6, 6], [5, 5], true],
    ["a line after the deletion", [9, 9], [10, 10], true],
    ["a line inside the actor's own change widens to what it replaced", [4, 4], [3, 3], false],
    ["the lines the actor added become the insertion point they sit at", [15, 16], [16, 15], false],
    ["an insertion point in the working copy", [12, 11], [13, 12], true],
  ])("maps %s to the base", (_name, working, base, exact) => {
    expect(toBase(working, hunks)).toEqual({ range: base, exact });
  });

  it.each<[string, Range, Range]>([
    ["an untouched base line", [10, 10], [9, 9]],
    ["a base line the working copy deleted", [8, 8], [9, 8]],
    ["a base line the working copy changed", [3, 3], [3, 4]],
  ])("maps %s into the working copy", (_name, base, working) => {
    expect(toWorking(base, hunks).range).toEqual(working);
  });

  it("round-trips every range that maps exactly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: -1, max: 10 }), (s, len) => {
        const working: Range = [s, s + len];
        const base = toBase(working, hunks);
        fc.pre(base.exact);
        expect(toWorking(base.range, hunks).range).toEqual(working);
      }),
    );
  });
});

describe("capChanges", () => {
  const change = (range: Range, digest: string | null = "d"): Change => ({ range, digest });

  it("leaves changes alone when there are few enough, sorted", () => {
    const changes = [change([20, 21]), change([1, 2]), change([1, 0])];
    expect(capChanges(changes, 5)).toEqual([change([1, 0]), change([1, 2]), change([20, 21])]);
  });

  it("merges the closest neighbours first and drops the merged digest", () => {
    const changes = [change([1, 2]), change([10, 10]), change([13, 12]), change([40, 41])];
    expect(capChanges(changes, 3)).toEqual([
      change([1, 2]),
      change([10, 12], null),
      change([40, 41]),
    ]);
  });

  it("keeps merging until the cap holds, covering every line", () => {
    const changes = Array.from({ length: 120 }, (_, i) => change([i * 3 + 1, i * 3 + 1]));
    const capped = capChanges(changes, 50);
    expect(capped).toHaveLength(50);
    for (const { range } of changes) {
      expect(capped.some(({ range: r }) => r[0] <= range[0] && range[1] <= r[1])).toBe(true);
    }
    expect(capped.every(({ range }) => isRange(range))).toBe(true);
  });
});
