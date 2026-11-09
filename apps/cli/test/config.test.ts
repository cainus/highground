import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addRepository, configFile, readConfig } from "../src/config.ts";
import { cleanupRepos, makeWorkingCopy, run } from "./helpers.ts";

const scratch = mkdtempSync(join(tmpdir(), "highground-config-"));
afterAll(() => {
  cleanupRepos();
  rmSync(scratch, { recursive: true, force: true });
});

let configs = 0;
const freshDir = () => join(scratch, `config-${++configs}`);

describe("config", () => {
  it("reads an older config's working copies as the repositories they belong to", async () => {
    const dir = freshDir();
    mkdirSync(dir);
    writeFileSync(
      configFile(dir),
      JSON.stringify({ server: "http://hg.test", workingCopies: ["/old/one", "/old/two"] }),
    );
    expect(await readConfig(dir)).toEqual({
      server: "http://hg.test",
      repositories: ["/old/one", "/old/two"],
    });
  });

  it("adds a repository once, by any of its worktrees, and drops entries that are gone", async () => {
    const dir = freshDir();
    mkdirSync(dir);
    const wc = makeWorkingCopy({ "a.txt": "a\n" });
    const tree = `${wc.dir}-linked`;
    run(wc.dir, "worktree", "add", "-q", "-b", "linked", tree);
    writeFileSync(
      configFile(dir),
      JSON.stringify({ workingCopies: [join(scratch, "deleted-worktree"), tree] }),
    );

    expect(await addRepository(dir, wc.dir)).toBe(false);
    const other = makeWorkingCopy({ "b.txt": "b\n" });
    expect(await addRepository(dir, other.dir)).toBe(true);

    const written = JSON.parse(readFileSync(configFile(dir), "utf8"));
    expect(written).toEqual({ repositories: [realpathSync(tree), realpathSync(other.dir)] });
    run(wc.dir, "worktree", "remove", "--force", tree);
  });
});
