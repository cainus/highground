import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkingCopyWatcher } from "../src/watcher.ts";
import {
  cleanupRepos,
  commitAll,
  eventually,
  lines,
  makeWorkingCopy,
  run,
  write,
} from "./helpers.ts";

const watchers: WorkingCopyWatcher[] = [];
afterEach(() => {
  for (const w of watchers.splice(0)) w.close();
  cleanupRepos();
});

/** A watch is live a moment after it is made; the reporter's keepalive covers that gap. */
const live = () => new Promise((r) => setTimeout(r, 300));

/** A watcher counting the changes it reports, once its watches are live. */
async function watching(root: string, recursive: boolean) {
  const seen = { changes: 0 };
  const watcher = new WorkingCopyWatcher(() => seen.changes++, { recursive });
  watchers.push(watcher);
  await watcher.sync(root);
  await live();
  return { watcher, seen };
}

/** Lets pending filesystem events arrive, then says how many changes were reported. */
async function settle(seen: { changes: number }): Promise<number> {
  await new Promise((r) => setTimeout(r, 300));
  return seen.changes;
}

describe.each([
  ["one recursive watch", true],
  ["a watch per directory", false],
])("WorkingCopyWatcher, %s", (_name, recursive) => {
  it("reports edits, new directories and commits", async () => {
    const { dir } = makeWorkingCopy({ "a.txt": lines(3), "src/b.txt": "b\n" });
    const { watcher, seen } = await watching(dir, recursive);

    write(dir, { "src/b.txt": "changed\n" });
    await eventually(() => expect(seen.changes).toBeGreaterThan(0));

    let before = await settle(seen);
    mkdirSync(join(dir, "fresh"));
    await watcher.sync(dir);
    await live();
    write(dir, { "fresh/c.txt": "c\n" });
    await eventually(() => expect(seen.changes).toBeGreaterThan(before));

    before = await settle(seen);
    commitAll(dir, "commit");
    await eventually(() => expect(seen.changes).toBeGreaterThan(before));
  });

  it("reports a commit in a linked worktree, whose git directory is outside it", async () => {
    const { dir } = makeWorkingCopy({ "a.txt": lines(3) });
    const tree = `${dir}-wt`;
    run(dir, "worktree", "add", "-q", "-b", "wt", tree);
    const { seen } = await watching(tree, recursive);

    write(tree, { "a.txt": "x\n" });
    run(tree, "commit", "-qam", "in the worktree");
    await eventually(() => expect(seen.changes).toBeGreaterThan(0));
    const before = await settle(seen);
    run(tree, "checkout", "-q", "-b", "another");
    await eventually(() => expect(seen.changes).toBeGreaterThan(before));
    run(dir, "worktree", "remove", "--force", tree);
  });

  it("reports an edit to the working copy's summary, the one file of its own it reads", async () => {
    const { dir } = makeWorkingCopy({ "a.txt": "a\n" });
    write(dir, { ".highground/daemon.json": "{}\n" });
    const { seen } = await watching(dir, recursive);

    write(dir, { ".highground/summary.md": "Why this work exists\n" });
    await eventually(() => expect(seen.changes).toBeGreaterThan(0));
  });

  it("ignores ignored files, git's object store and its own directory", async () => {
    const { dir } = makeWorkingCopy({ ".gitignore": "node_modules/\n*.log\n", "a.txt": "a\n" });
    const ignored = {
      "node_modules/pkg/index.js": "x\n",
      "debug.log": "x\n",
      ".highground/daemon.json": "{}\n",
    };
    write(dir, ignored);
    const { seen } = await watching(dir, recursive);

    write(dir, Object.fromEntries(Object.keys(ignored).map((path) => [path, "changed\n"])));
    write(dir, { "node_modules/pkg/new.js": "x\n" });
    run(dir, "hash-object", "-w", "--stdin");
    expect(await settle(seen)).toBe(0);
  });
});

describe("WorkingCopyWatcher on macOS and Windows", () => {
  // libuv keeps macOS's watches in one FSEvents stream and re-registers every path when
  // one closes, so a watch per directory costs time quadratic in the directories.
  it.runIf(process.platform === "darwin" || process.platform === "win32")(
    "holds a working copy of thousands of directories in one watch, and closes it at once",
    async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 3000; i++) files[`d${i % 60}/e${i}/f.txt`] = "x\n";
      const { dir } = makeWorkingCopy(files);
      const watcher = new WorkingCopyWatcher(() => {});
      await watcher.sync(dir);
      expect(watcher.handles).toBe(1);

      const started = performance.now();
      watcher.close();
      expect(performance.now() - started).toBeLessThan(200);
    },
  );
});
