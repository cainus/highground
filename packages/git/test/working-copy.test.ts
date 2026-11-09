import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  derivedId,
  ensureIdentity,
  ensureRepositoryIdentity,
  fileHunks,
  findIdentity,
  RepoStateError,
  repoState,
  watchTargets,
} from "../src/index.ts";
import { cleanupRepos, commitAll, lines, makeRepo, run, write } from "./helpers.ts";

afterAll(cleanupRepos);

/** A repo whose `origin` is GitHub, with `origin/main` at the current commit and `origin/HEAD` naming it. */
function withOrigin(dir: string, defaultBranch = "main", setHead = true): string {
  run(dir, "remote", "add", "origin", "git@github.com:acme/api.git");
  run(dir, "update-ref", `refs/remotes/origin/${defaultBranch}`, "HEAD");
  if (setHead) {
    run(dir, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${defaultBranch}`);
  }
  return dir;
}

describe("repoState", () => {
  it("names the repo, base, branch and author of a working copy", async () => {
    const dir = withOrigin(makeRepo({ "a.txt": lines(3) }));
    const base = run(dir, "rev-parse", "HEAD");
    run(dir, "checkout", "-q", "-b", "feature/x");
    write(dir, { "a.txt": lines(4) });
    commitAll(dir, "feature work");
    mkdirSync(join(dir, "sub"));

    expect(await repoState(join(dir, "sub"))).toEqual({
      root: run(dir, "rev-parse", "--show-toplevel"),
      commonDir: realpathSync(join(dir, ".git")),
      repo: "github.com/acme/api",
      defaultRef: "origin/main",
      base,
      branch: "feature/x",
      author: "test@example.com",
    });
  });

  it("finds the default branch without origin/HEAD", async () => {
    const dir = withOrigin(makeRepo({ "a.txt": "x\n" }), "master", false);
    expect((await repoState(dir)).defaultRef).toBe("origin/master");
  });

  it("calls a detached HEAD by name", async () => {
    const dir = withOrigin(makeRepo({ "a.txt": "x\n" }));
    run(dir, "checkout", "-q", "--detach");
    expect((await repoState(dir)).branch).toBe("HEAD");
  });

  it.each([
    ["not-a-repository", () => tmpdir()],
    ["no-remote", (dir: string) => dir],
    [
      "unrecognised-remote",
      (dir: string) => {
        run(dir, "remote", "add", "origin", "/srv/git/api.git");
        return dir;
      },
    ],
    [
      "no-default-branch",
      (dir: string) => {
        run(dir, "remote", "add", "origin", "https://github.com/acme/api");
        return dir;
      },
    ],
  ])("says why it cannot: %s", async (reason, prepare) => {
    const dir = prepare(makeRepo({ "a.txt": "x\n" }));
    const error = await repoState(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoStateError);
    expect((error as RepoStateError).reason).toBe(reason);
  });

  it("says a working copy that was deleted no longer exists", async () => {
    const dir = withOrigin(makeRepo({ "a.txt": "x\n" }));
    rmSync(dir, { recursive: true, force: true });
    const error = (await repoState(dir).catch((e: unknown) => e)) as RepoStateError;
    expect(error.reason).toBe("missing");
    expect(error.message).toBe(`${dir} no longer exists`);
  });

  it("names the git directory every worktree of a repository shares", async () => {
    const dir = withOrigin(makeRepo({ "a.txt": "x\n" }));
    const tree = `${dir}-wt`;
    run(dir, "worktree", "add", "-q", tree);
    expect((await repoState(tree)).commonDir).toBe((await repoState(dir)).commonDir);
    run(dir, "worktree", "remove", "--force", tree);
  });
});

describe("fileHunks", () => {
  it("is the file's hunks from the base to the working tree, uncommitted edits included", async () => {
    const dir = makeRepo({ "a.txt": lines(10) });
    const base = run(dir, "rev-parse", "HEAD");
    write(dir, { "a.txt": lines(10).replace("line3\n", "three\n3b\n").replace("line8\n", "") });

    expect(await fileHunks(dir, base, "a.txt")).toEqual([
      { oldStart: 3, oldCount: 1, newStart: 3, newCount: 2, added: ["three", "3b"] },
      { oldStart: 8, oldCount: 1, newStart: 8, newCount: 0, added: [] },
    ]);
  });

  it("is empty for an unchanged file", async () => {
    const dir = makeRepo({ "a.txt": lines(3) });
    expect(await fileHunks(dir, run(dir, "rev-parse", "HEAD"), "a.txt")).toEqual([]);
  });

  it.each([
    ["a file not in the base", "new.txt"],
    ["a binary file", "b.bin"],
  ])("is null for %s, which counts as the whole file", async (_name, path) => {
    const dir = makeRepo({ "a.txt": "x\n", "b.bin": "\0\x01" });
    const base = run(dir, "rev-parse", "HEAD");
    write(dir, { "new.txt": "hello\n", "b.bin": "\0\x02" });
    expect(await fileHunks(dir, base, path)).toBeNull();
  });
});

describe("working-copy identity", () => {
  it("creates one id, keeps it, and keeps it out of git", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const id = await ensureIdentity(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ensureIdentity(dir)).toBe(id);
    expect(readFileSync(join(dir, ".highground/id"), "utf8").trim()).toBe(id);
    expect(run(dir, "status", "--porcelain")).toBe("");
    const exclude = readFileSync(join(dir, ".git/info/exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/.highground/")).toHaveLength(1);
  });

  it("shares one id between concurrent creators", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const ids = await Promise.all(Array.from({ length: 8 }, () => ensureIdentity(dir)));
    expect(new Set(ids).size).toBe(1);
  });

  it("puts a linked worktree's exclusion in the shared exclude file", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const tree = `${dir}-wt`;
    run(dir, "worktree", "add", "-q", tree);
    await ensureIdentity(tree);
    expect(run(tree, "status", "--porcelain")).toBe("");
    run(dir, "worktree", "remove", "--force", tree);
  });

  it("does not bring back a working copy that was deleted", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    rmSync(dir, { recursive: true, force: true });
    await expect(ensureIdentity(dir)).rejects.toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  it("is found from anywhere inside the working copy without git", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const id = await ensureIdentity(dir);
    mkdirSync(join(dir, "src/deep"), { recursive: true });
    writeFileSync(join(dir, "src/deep/f.ts"), "");

    expect(await findIdentity(join(dir, "src/deep"))).toEqual({ root: dir, id });
    expect(await findIdentity("/")).toBeNull();
  });
});

describe("repository identity", () => {
  it("is one id for every worktree of a repository, kept in the git directory they share", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const tree = `${dir}-wt`;
    run(dir, "worktree", "add", "-q", tree);
    const id = await ensureRepositoryIdentity(tree);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ensureRepositoryIdentity(dir)).toBe(id);
    expect(id).not.toBe(await ensureIdentity(dir));
    expect(run(dir, "status", "--porcelain")).toBe("");
    run(dir, "worktree", "remove", "--force", tree);
  });

  it("differs between two clones", async () => {
    const one = makeRepo({ "a.txt": "x\n" });
    const two = makeRepo({ "a.txt": "x\n" });
    expect(await ensureRepositoryIdentity(one)).not.toBe(await ensureRepositoryIdentity(two));
  });

  it("is shared by concurrent creators", async () => {
    const dir = makeRepo({ "a.txt": "x\n" });
    const ids = await Promise.all(Array.from({ length: 8 }, () => ensureRepositoryIdentity(dir)));
    expect(new Set(ids).size).toBe(1);
  });
});

describe("watchTargets", () => {
  it("lists the directories holding tracked or untracked files, and the git directory, but not ignored ones", async () => {
    const dir = makeRepo({ "a.txt": "x\n", ".gitignore": "node_modules/\n" });
    for (const d of ["src/deep", "node_modules/pkg", "fresh"])
      mkdirSync(join(dir, d), { recursive: true });
    write(dir, { "src/deep/f.ts": "", "node_modules/pkg/i.js": "", "fresh/new.txt": "" });
    commitAll(dir, "src");
    const root = run(dir, "rev-parse", "--show-toplevel");

    expect((await watchTargets(root)).sort()).toEqual(
      [
        root,
        join(root, "fresh"),
        join(root, "src"),
        join(root, "src/deep"),
        join(root, ".git"),
      ].sort(),
    );
  });
});

describe("derivedId", () => {
  it("is a stable UUID per name, distinct between names and never split ambiguously", () => {
    const id = derivedId("pushed", "github.com/acme/api", "feature/x");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(derivedId("pushed", "github.com/acme/api", "feature/x")).toBe(id);
    expect(derivedId("parked", "github.com/acme/api", "feature/x")).not.toBe(id);
    expect(derivedId("a", "bc")).not.toBe(derivedId("ab", "c"));
  });
});
