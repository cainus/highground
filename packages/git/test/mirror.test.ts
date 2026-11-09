import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  branches,
  defaultBranch,
  diffCommits,
  diffPaths,
  fetchCommit,
  fetchMirror,
  hasCommit,
  initMirror,
  parkedBranches,
} from "../src/index.ts";
import { cleanupRepos, commitAll, lines, makeRepo, run, write } from "./helpers.ts";

afterAll(cleanupRepos);

/** An "origin" with main and a feature branch, and an empty mirror directory beside it. */
function setup() {
  const origin = makeRepo({ "a.txt": lines(20), "b.txt": "b\n" });
  const base = run(origin, "rev-parse", "HEAD");
  run(origin, "checkout", "-q", "-b", "feature");
  write(origin, { "a.txt": lines(20).replace("line5\n", "five\n"), "new.txt": "n\n" });
  const head = commitAll(origin, "feature work");
  run(origin, "checkout", "-q", "main");
  const mirror = join(mkdtempSync(join(tmpdir(), "highground-mirror-")), "repo.git");
  return { origin, base, head, mirror };
}

describe("mirror plumbing", () => {
  it("clones and fetches every branch, pruning deleted ones", async () => {
    const { origin, head, mirror } = setup();
    await initMirror(mirror, origin);
    await fetchMirror(mirror);
    expect((await branches(mirror)).map((b) => [b.name, b.head])).toEqual([
      ["feature", head],
      ["main", run(origin, "rev-parse", "main")],
    ]);

    run(origin, "branch", "-D", "feature");
    await fetchMirror(mirror);
    expect((await branches(mirror)).map((b) => b.name)).toEqual(["main"]);
  });

  it("follows the remote's default branch", async () => {
    const { origin, mirror } = setup();
    await initMirror(mirror, origin);
    await fetchMirror(mirror);
    expect(await defaultBranch(mirror)).toBe("main");
    run(origin, "symbolic-ref", "HEAD", "refs/heads/feature");
    await fetchMirror(mirror);
    expect(await defaultBranch(mirror)).toBe("feature");
  });

  it("reads each branch's head author and commit time", async () => {
    const { origin, mirror } = setup();
    await initMirror(mirror, origin);
    await fetchMirror(mirror);
    const [feature] = await branches(mirror);
    expect(feature).toMatchObject({ name: "feature", author: "test@example.com" });
    expect(Date.now() - Date.parse(feature!.committedAt)).toBeLessThan(60_000);
  });

  it("passes credentials to git only through the environment", async () => {
    const { origin, mirror } = setup();
    await initMirror(mirror, origin);
    // An extra header is harmless to a local remote; a bad config key would fail the fetch.
    await fetchMirror(mirror, { "http.extraHeader": "Authorization: Basic eDp5" });
    expect(await hasCommit(mirror, run(origin, "rev-parse", "main"))).toBe(true);
    expect(await hasCommit(mirror, "f".repeat(40))).toBe(false);
  });

  it("diffs two commits into reports in the first one's coordinates", async () => {
    const { origin, base, head, mirror } = setup();
    await initMirror(mirror, origin);
    await fetchMirror(mirror);
    expect(await diffCommits(mirror, base, head)).toMatchObject([
      { path: "a.txt", wholeFile: false, changes: [{ range: [5, 5] }] },
      { path: "new.txt", wholeFile: "added", changes: [] },
    ]);
  });

  it("diffs one path between two commits, for translating between bases", async () => {
    const { origin, base, mirror } = setup();
    write(origin, { "a.txt": `top1\ntop2\n${lines(20)}` });
    const moved = commitAll(origin, "main moves");
    await initMirror(mirror, origin);
    await fetchMirror(mirror);

    const hunks = await diffPaths(mirror, base, moved, ["a.txt", "b.txt"]);
    expect(hunks.get("a.txt")).toMatchObject([
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
    ]);
    expect(hunks.get("b.txt")).toEqual([]);
  });
});

describe("parked branches", () => {
  it("lists local branches with commits on neither the default branch nor their own upstream", async () => {
    const { origin } = setup();
    const clone = mkdtempSync(join(tmpdir(), "highground-clone-"));
    execFileSync("git", ["clone", "-q", origin, clone]);
    run(clone, "config", "user.email", "me@example.com");
    run(clone, "config", "user.name", "Me");
    // Pushed and unchanged: not parked. Local only: parked. Ahead of its upstream: parked.
    run(clone, "branch", "-q", "--track", "feature", "origin/feature");
    run(clone, "checkout", "-q", "-b", "local-only");
    write(clone, { "a.txt": lines(20).replace("line9\n", "nine\n") });
    const localHead = commitAll(clone, "local");
    run(clone, "checkout", "-q", "-b", "current", "main");

    const parked = await parkedBranches(clone, "origin/main");
    expect(parked.map((p) => [p.name, p.head, p.base])).toEqual([
      ["local-only", localHead, run(clone, "rev-parse", "origin/main")],
    ]);
    expect(parked[0]).toMatchObject({ author: "me@example.com" });

    run(clone, "checkout", "-q", "feature");
    write(clone, { "b.txt": "more\n" });
    commitAll(clone, "ahead of upstream");
    run(clone, "checkout", "-q", "current");
    expect((await parkedBranches(clone, "origin/main")).map((p) => p.name)).toEqual([
      "feature",
      "local-only",
    ]);
  });

  it("leaves out every branch checked out in a worktree, which is live work there", async () => {
    const { origin } = setup();
    const clone = mkdtempSync(join(tmpdir(), "highground-clone-"));
    execFileSync("git", ["clone", "-q", origin, clone]);
    run(clone, "config", "user.email", "me@example.com");
    run(clone, "config", "user.name", "Me");
    for (const name of ["in-worktree", "parked"]) {
      run(clone, "checkout", "-q", "-b", name, "main");
      write(clone, { "a.txt": lines(20).replace("line9\n", `${name}\n`) });
      commitAll(clone, name);
    }
    run(clone, "checkout", "-q", "-b", "current", "main");
    write(clone, { "b.txt": "current\n" });
    commitAll(clone, "current");
    const tree = `${clone}-wt`;
    run(clone, "worktree", "add", "-q", tree, "in-worktree");

    for (const dir of [clone, tree]) {
      expect((await parkedBranches(dir, "origin/main")).map((p) => p.name)).toEqual(["parked"]);
    }
    run(clone, "worktree", "remove", "--force", tree);
  });

  it("fetches one commit it is told about, without touching refs", async () => {
    const { origin } = setup();
    const clone = mkdtempSync(join(tmpdir(), "highground-clone-"));
    execFileSync("git", [
      "clone",
      "-q",
      "--no-local",
      "--single-branch",
      "-b",
      "main",
      origin,
      clone,
    ]);
    run(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const head = run(origin, "rev-parse", "feature");
    expect(await hasCommit(clone, head)).toBe(false);
    const refs = run(clone, "for-each-ref");

    await fetchCommit(clone, head);
    expect(await hasCommit(clone, head)).toBe(true);
    expect(run(clone, "for-each-ref")).toBe(refs);
  });
});
