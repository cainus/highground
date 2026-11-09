import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { diffRanges, mergeBase, mergeTree, snapshot } from "../src/index.ts";
import { cleanupRepos, commitAll, lines, makeRepo, run, write } from "./helpers.ts";

afterAll(cleanupRepos);

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("mergeBase", () => {
  it("is the commit where a branch left main", async () => {
    const dir = makeRepo({ "a.txt": lines(5) });
    const forkPoint = run(dir, "rev-parse", "HEAD");
    run(dir, "checkout", "-q", "-b", "feature");
    write(dir, { "a.txt": lines(6) });
    commitAll(dir, "feature work");
    run(dir, "checkout", "-q", "main");
    write(dir, { "b.txt": "main moved on\n" });
    commitAll(dir, "main work");
    run(dir, "checkout", "-q", "feature");

    expect(await mergeBase(dir, "main")).toBe(forkPoint);
  });
});

describe("diffRanges", () => {
  it("covers committed-but-unpushed and uncommitted changes in base coordinates", async () => {
    const dir = makeRepo({ "a.txt": lines(20) });
    const base = run(dir, "rev-parse", "HEAD");
    run(dir, "checkout", "-q", "-b", "feature");
    write(dir, { "a.txt": lines(20).replace("line3\n", "line3 committed\n") });
    commitAll(dir, "committed, not pushed");
    write(dir, {
      "a.txt": lines(20).replace("line3\n", "line3 committed\n").replace("line12\n", ""),
    });

    expect(await diffRanges(dir, base)).toEqual([
      {
        path: "a.txt",
        wholeFile: false,
        changes: [
          { range: [3, 3], digest: sha256("line3 committed\n") },
          { range: [12, 12], digest: sha256("") },
        ],
      },
    ]);
  });

  it("reports untracked files as whole-file, and skips ignored ones", async () => {
    const dir = makeRepo({ "a.txt": lines(3), ".gitignore": "ignored.txt\n" });
    write(dir, { "new.txt": "hello\n", "ignored.txt": "secret\n" });

    expect(await diffRanges(dir, run(dir, "rev-parse", "HEAD"))).toEqual([
      { path: "new.txt", wholeFile: "added", changes: [] },
    ]);
  });

  it("is empty for a clean working copy", async () => {
    const dir = makeRepo({ "a.txt": lines(3) });
    expect(await diffRanges(dir, run(dir, "rev-parse", "HEAD"))).toEqual([]);
  });
});

describe("snapshot", () => {
  it("captures tracked edits and untracked files without touching the index or stash", async () => {
    const dir = makeRepo({ "a.txt": lines(3) });
    write(dir, { "a.txt": "changed\n", "new.txt": "untracked\n" });

    const sha = await snapshot(dir);

    expect(run(dir, "show", `${sha}:a.txt`)).toBe("changed");
    expect(run(dir, "show", `${sha}:new.txt`)).toBe("untracked");
    expect(run(dir, "rev-parse", `${sha}^`)).toBe(run(dir, "rev-parse", "HEAD"));
    expect(run(dir, "diff", "--cached", "--name-only")).toBe("");
    expect(run(dir, "ls-files", "--others", "--exclude-standard")).toBe("new.txt");
    expect(run(dir, "stash", "list")).toBe("");
  });
});

describe("mergeTree", () => {
  it("reports the conflicted paths of a speculative merge", async () => {
    const dir = makeRepo({ "a.txt": lines(10), "b.txt": lines(10) });
    run(dir, "checkout", "-q", "-b", "ours");
    write(dir, {
      "a.txt": lines(10).replace("line5\n", "ours\n"),
      "b.txt": lines(10).replace("line1\n", "x\n"),
    });
    const ours = commitAll(dir, "ours");
    run(dir, "checkout", "-q", "-b", "theirs", "main");
    write(dir, {
      "a.txt": lines(10).replace("line5\n", "theirs\n"),
      "b.txt": lines(10).replace("line9\n", "y\n"),
    });
    const theirs = commitAll(dir, "theirs");

    expect(await mergeTree(dir, ours, theirs)).toEqual({ clean: false, conflicts: ["a.txt"] });
  });

  it("is clean when the changes merge", async () => {
    const dir = makeRepo({ "a.txt": lines(10) });
    run(dir, "checkout", "-q", "-b", "ours");
    write(dir, { "a.txt": lines(10).replace("line1\n", "ours\n") });
    const ours = commitAll(dir, "ours");
    run(dir, "checkout", "-q", "-b", "theirs", "main");
    write(dir, { "a.txt": lines(10).replace("line9\n", "theirs\n") });
    const theirs = commitAll(dir, "theirs");

    expect(await mergeTree(dir, ours, theirs)).toEqual({ clean: true, conflicts: [] });
  });
});
