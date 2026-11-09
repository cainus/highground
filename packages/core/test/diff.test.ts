import { describe, expect, it } from "vitest";
import { hunkToRange, parseDiff, reportsFromDiff, unquotePath } from "../src/index.ts";

/** A readable stand-in for the SHA-256 digest; distinguishes [] from [""]. */
const digest = (lines: string[]): string => JSON.stringify(lines);

// Captured from `git -c core.quotePath=false diff -U0 -M --histogram HEAD` on git 2.55.
const REAL_DIFF = [
  "diff --git a/added.txt b/added.txt",
  "new file mode 100644",
  "index 0000000..3e75765",
  "--- /dev/null",
  "+++ b/added.txt",
  "@@ -0,0 +1 @@",
  "+new",
  "diff --git a/bin.dat b/bin.dat",
  "index bdc955b..8835708 100644",
  "Binary files a/bin.dat and b/bin.dat differ",
  "diff --git a/deleted.txt b/deleted.txt",
  "deleted file mode 100644",
  "index 286c5f5..0000000",
  "--- a/deleted.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/mod.txt b/mod.txt",
  "index f696b4b..7eace36 100644",
  "--- a/mod.txt",
  "+++ b/mod.txt",
  "@@ -0,0 +1 @@",
  "+top",
  "@@ -3 +4 @@ line2",
  "-line3",
  "+line3 X",
  "@@ -8,2 +8,0 @@ line7",
  "-line8",
  "-line9",
  "@@ -15,0 +15 @@ line15",
  "+inserted",
  "diff --git a/old name.txt b/new name.txt",
  "similarity index 91%",
  "rename from old name.txt",
  "rename to new name.txt",
  "index 2749a43..240e77d 100644",
  "--- a/old name.txt\t",
  "+++ b/new name.txt\t",
  "@@ -10 +10 @@ r9",
  "-r10",
  "+r10 Y",
  "diff --git a/pure-rename.txt b/renamed.txt",
  "similarity index 100%",
  "rename from pure-rename.txt",
  "rename to renamed.txt",
  "",
].join("\n");

describe("parseDiff", () => {
  const files = parseDiff(REAL_DIFF);

  it("finds one record per file", () => {
    expect(files.map((f) => [f.basePath, f.newPath])).toEqual([
      [null, "added.txt"],
      ["bin.dat", "bin.dat"],
      ["deleted.txt", null],
      ["mod.txt", "mod.txt"],
      ["old name.txt", "new name.txt"],
      ["pure-rename.txt", "renamed.txt"],
    ]);
  });

  it("reads hunk headers, including omitted counts", () => {
    expect(files[3]?.hunks).toEqual([
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, added: ["top"] },
      { oldStart: 3, oldCount: 1, newStart: 4, newCount: 1, added: ["line3 X"] },
      { oldStart: 8, oldCount: 2, newStart: 8, newCount: 0, added: [] },
      { oldStart: 15, oldCount: 0, newStart: 15, newCount: 1, added: ["inserted"] },
    ]);
  });

  it("flags binary files", () => {
    expect(files.map((f) => f.binary)).toEqual([false, true, false, false, false, false]);
  });

  it("ignores mode-only changes and no-newline markers", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/end.txt b/end.txt",
      "index 1..2 100644",
      "--- a/end.txt",
      "+++ b/end.txt",
      "@@ -4 +4 @@",
      "-four",
      "\\ No newline at end of file",
      "+four!",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parseDiff(diff)).toEqual([
      { basePath: "run.sh", newPath: "run.sh", binary: false, hunks: [] },
      {
        basePath: "end.txt",
        newPath: "end.txt",
        binary: false,
        hunks: [
          {
            oldStart: 4,
            oldCount: 1,
            newStart: 4,
            newCount: 1,
            added: ["four!", "\\ No newline at end of file"],
          },
        ],
      },
    ]);
  });

  it("reads content lines that look like file headers by the hunk's line counts", () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -2,2 +2,2 @@",
      "--- removed line starting with two dashes",
      "-plain",
      "+++ added line starting with two pluses",
      "+plain",
      "@@ -9 +9 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(parseDiff(diff)).toEqual([
      {
        basePath: "x",
        newPath: "x",
        binary: false,
        hunks: [
          {
            oldStart: 2,
            oldCount: 2,
            newStart: 2,
            newCount: 2,
            added: ["++ added line starting with two pluses", "plain"],
          },
          { oldStart: 9, oldCount: 1, newStart: 9, newCount: 1, added: ["b"] },
        ],
      },
    ]);
  });

  it("reads quoted paths", () => {
    const diff = [
      'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
      "new file mode 100644",
      'Binary files /dev/null and "b/tab\\there.txt" differ',
    ].join("\n");
    expect(parseDiff(diff)).toEqual([
      { basePath: null, newPath: "tab\there.txt", binary: true, hunks: [] },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("rejects a hunk header it cannot read", () => {
    expect(() => parseDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ nonsense @@\n")).toThrow(
      /hunk header/,
    );
  });
});

describe("unquotePath", () => {
  it.each([
    ["plain/path.ts", "plain/path.ts"],
    ['"a\\"b"', 'a"b'],
    ['"back\\\\slash"', "back\\slash"],
    ['"new\\nline"', "new\nline"],
    ['"caf\\303\\251"', "café"],
  ])("%s → %s", (input, expected) => {
    expect(unquotePath(input)).toBe(expected);
  });
});

describe("hunkToRange", () => {
  it("covers the replaced or deleted base lines", () => {
    expect(hunkToRange({ oldStart: 3, oldCount: 1, newStart: 4, newCount: 1, added: [] })).toEqual([
      3, 3,
    ]);
    expect(hunkToRange({ oldStart: 8, oldCount: 2, newStart: 8, newCount: 0, added: [] })).toEqual([
      8, 9,
    ]);
  });

  it("maps a pure insertion to the insertion point after its base line", () => {
    expect(
      hunkToRange({ oldStart: 15, oldCount: 0, newStart: 15, newCount: 1, added: [] }),
    ).toEqual([16, 15]);
    expect(hunkToRange({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, added: [] })).toEqual([
      1, 0,
    ]);
  });
});

describe("reportsFromDiff", () => {
  it("states each change in base coordinates with a digest of its new content, per PRD §3.2, and why a whole file is reported", () => {
    expect(reportsFromDiff(parseDiff(REAL_DIFF), digest)).toEqual([
      { path: "added.txt", wholeFile: "added", changes: [] },
      { path: "bin.dat", wholeFile: "binary", changes: [] },
      { path: "deleted.txt", wholeFile: "deleted", changes: [] },
      {
        path: "mod.txt",
        wholeFile: false,
        changes: [
          { range: [1, 0], digest: '["top"]' },
          { range: [3, 3], digest: '["line3 X"]' },
          { range: [8, 9], digest: "[]" },
          { range: [16, 15], digest: '["inserted"]' },
        ],
      },
      {
        path: "old name.txt",
        wholeFile: false,
        changes: [{ range: [10, 10], digest: '["r10 Y"]' }],
      },
      { path: "new name.txt", wholeFile: "renamed", changes: [] },
      { path: "pure-rename.txt", wholeFile: false, changes: [] },
      { path: "renamed.txt", wholeFile: "renamed", changes: [] },
    ]);
  });
});
