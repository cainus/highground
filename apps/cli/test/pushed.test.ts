import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "@highground/log";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Reporter } from "../src/reporter.ts";
import { serverClient } from "../src/server-client.ts";
import {
  cleanupRepos,
  cloneWorkingCopy,
  commitAll,
  eventually,
  lines,
  peerQuery,
  run,
  testServer,
  write,
  type TestServer,
} from "./helpers.ts";
import { makeRepo } from "../../../packages/git/test/helpers.ts";

const logDir = mkdtempSync(join(tmpdir(), "highground-cli-log-"));
const log = createLog({ service: "daemon", dir: logDir });
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  cleanupRepos();
});

/** An origin with a pushed branch `b1` changing line 5, a server mirroring it, and a clone. */
async function setup(b1Line5: string) {
  const origin = makeRepo({ "a.txt": lines(30) });
  run(origin, "checkout", "-q", "-b", "b1");
  write(origin, { "a.txt": lines(30).replace("line5\n", `${b1Line5}\n`) });
  const b1 = commitAll(origin, "b1 work");
  run(origin, "checkout", "-q", "main");
  const wc = cloneWorkingCopy(origin);
  const hg: TestServer = await testServer(0, origin);
  cleanup.push(() => hg.close());
  hg.server.mirror!.track(wc.repo);
  await hg.server.mirror!.round();
  return { origin, b1, wc, hg };
}

async function reporter(dir: string, url: string): Promise<Reporter> {
  const r = new Reporter({ root: dir, server: serverClient(url), log, debounceMs: 50 });
  cleanup.push(() => r.stop());
  await r.start();
  return r;
}

describe("live work against pushed work", () => {
  it("confirms a conflict by merging a snapshot of the working tree with the pushed head", async () => {
    const { b1, wc, hg } = await setup("five from b1");
    write(wc.dir, { "a.txt": lines(30).replace("line5\n", "five, live\n") });
    const r = await reporter(wc.dir, hg.url);

    await eventually(
      () =>
        expect(r.collisions()).toMatchObject([
          {
            type: "DIRECT_OVERLAP",
            confirmed: true,
            severity: "HIGH",
            peer: { kind: "pushed", head_sha: b1 },
          },
        ]),
      10_000,
    );
    // Nothing of the merge is left in the working copy.
    expect(run(wc.dir, "status", "--porcelain")).toBe("M a.txt");
  });

  it("refutes a duplicate change that merges cleanly", async () => {
    const { wc, hg } = await setup("same five");
    write(wc.dir, { "a.txt": lines(30).replace("line5\n", "same five\n") });
    const r = await reporter(wc.dir, hg.url);

    await eventually(
      () =>
        expect(r.collisions()).toMatchObject([
          { type: "DUPLICATE_CHANGE", confirmed: false, severity: "MEDIUM" },
        ]),
      10_000,
    );
  });
});

describe("parked work", () => {
  it("reports a local branch with unpushed commits, which warns its owner's live work", async () => {
    const { wc, hg } = await setup("five from b1");
    run(wc.dir, "checkout", "-q", "-b", "parked-x");
    write(wc.dir, { "a.txt": lines(30).replace("line25\n", "twenty-five, parked\n") });
    const parkedHead = commitAll(wc.dir, "parked work");
    run(wc.dir, "checkout", "-q", "main");
    write(wc.dir, { "a.txt": lines(30).replace("line25\n", "twenty-five, live\n") });
    const r = await reporter(wc.dir, hg.url);

    await eventually(async () => {
      const { warnings } = await peerQuery(hg.url, wc, "a.txt", 25, 25);
      expect(warnings.find((w) => w.peer.kind === "parked")).toMatchObject({
        peer: { branch: "parked-x", head_sha: parkedHead, actor: { id: "daemon" } },
      });
    });
    await eventually(() =>
      expect(r.collisions()).toMatchObject([{ peer: { kind: "parked", branch: "parked-x" } }]),
    );

    // Once the branch is deleted it is no longer parked work.
    run(wc.dir, "branch", "-q", "-D", "parked-x");
    await r.refresh();
    await eventually(() => expect(r.collisions()).toEqual([]));
  });
});

describe("parked work against pushed work", () => {
  it("merges the parked branch's head with the pushed head, and reports the conflict", async () => {
    const { b1, wc, hg } = await setup("five from b1");
    run(wc.dir, "checkout", "-q", "-b", "parked-y");
    write(wc.dir, { "a.txt": lines(30).replace("line5\n", "five, parked\n") });
    commitAll(wc.dir, "parked work");
    run(wc.dir, "checkout", "-q", "main");
    await reporter(wc.dir, hg.url);

    await eventually(() => {
      const parked = hg.server.hub.index
        .entriesAt(wc.repo, "a.txt", Date.now())
        .find((e) => e.kind === "parked");
      expect(parked?.merges).toEqual([{ branch: "b1", head_sha: b1, conflicts: ["a.txt"] }]);
    }, 10_000);
    // The merge ran on commits alone: the checked-out tree is untouched.
    expect(run(wc.dir, "status", "--porcelain")).toBe("");
  });
});

afterAll(() => rmSync(logDir, { recursive: true, force: true }));
