import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "@highground/log";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addRepository } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { DaemonFileSchema, daemonFilePath } from "../src/discovery.ts";
import type { daemonContract } from "../src/local-contract.ts";
import {
  cleanupRepos,
  commitAll,
  eventually,
  lines,
  makeWorkingCopy,
  peerHeartbeat,
  peerQuery,
  run,
  testServer,
  write,
  type TestServer,
} from "./helpers.ts";

let hg: TestServer;
const scratch = mkdtempSync(join(tmpdir(), "highground-daemon-"));
const log = createLog({ service: "daemon", dir: join(scratch, "logs") });
const daemons: Daemon[] = [];

beforeAll(async () => {
  hg = await testServer();
});
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
});
afterAll(async () => {
  await hg.close();
  cleanupRepos();
  rmSync(scratch, { recursive: true, force: true });
});

async function daemon(dirs: string[], configDir?: string): Promise<Daemon> {
  const d = new Daemon({
    server: hg.url,
    dirs,
    log,
    followMs: 100,
    reporter: { debounceMs: 50 },
    ...(configDir ? { configDir } : {}),
  });
  daemons.push(d);
  await d.start();
  return d;
}

const local = (d: Daemon, secret = d.secret): ContractRouterClient<typeof daemonContract> =>
  createORPCClient(
    new RPCLink({
      url: `http://127.0.0.1:${d.port}/rpc`,
      headers: { authorization: `Bearer ${secret}` },
    }),
  );

const idOf = (dir: string) => readFileSync(join(dir, ".highground/id"), "utf8").trim();

describe("Daemon", () => {
  it("announces itself in each working copy, readable only by its owner, and withdraws on stop", async () => {
    const one = makeWorkingCopy({ "a.txt": "x\n" }).dir;
    const two = makeWorkingCopy({ "a.txt": "x\n" }).dir;
    const d = await daemon([one, two]);

    for (const dir of [one, two]) {
      const path = daemonFilePath(dir);
      await eventually(() => expect(existsSync(path)).toBe(true));
      expect(DaemonFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))).toMatchObject({
        port: d.port,
        addresses: ["127.0.0.1", "host.docker.internal"],
        secret: d.secret,
        server: hg.url,
        pid: process.pid,
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    await d.stop();
    expect(existsSync(daemonFilePath(one))).toBe(false);
  });

  it("refuses local calls without its secret", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(5) });
    const { dir } = wc;
    const d = await daemon([dir]);
    const call = local(d, "wrong").check({
      working_copy_id: idOf(dir),
      path: "a.txt",
      ranges: [[1, 1]],
    });
    await expect(call).rejects.toMatchObject({ status: 401 });
  });

  it("sends an agent's intent in base lines and answers in the agent's own lines", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    // Two lines added at the top: working-copy line n is base line n - 2 below them.
    write(dir, { "a.txt": `new1\nnew2\n${lines(20)}` });
    const d = await daemon([dir]);
    await peerHeartbeat(hg.url, wc, "a.txt", [[10, 11]]);

    const { warnings } = await local(d).intent({
      working_copy_id: idOf(dir),
      actor: { type: "agent", id: "agent-1" },
      path: "a.txt",
      ranges: [[12, 13]],
      intent: "refactor",
    });
    expect(warnings).toMatchObject([
      {
        type: "DIRECT_OVERLAP",
        your_lines: [12, 13],
        peer: { lines: [12, 13], intent: "peer work" },
      },
    ]);

    // The peer sees the intent at base lines 10–11, with what the agent said.
    const { warnings: seen } = await peerQuery(hg.url, wc, "a.txt", 10, 10);
    expect(seen.find((w) => w.peer.actor.id === "agent-1")).toMatchObject({
      peer: { lines: [10, 11], intent: "refactor" },
    });
  });

  it("checks without announcing", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    const d = await daemon([dir]);
    await peerHeartbeat(hg.url, wc, "a.txt", [[5, 5]]);

    const { warnings } = await local(d).check({
      working_copy_id: idOf(dir),
      path: "a.txt",
      ranges: [
        [3, 4],
        [30, 31],
      ],
    });
    expect(warnings.map((w) => w.type)).toEqual(["DIRECT_OVERLAP"]);
    expect((await peerQuery(hg.url, wc, "a.txt", 3, 4)).warnings).toEqual([]);
  });

  it("answers NOT_FOUND for a working copy it does not watch", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(5) });
    const { dir } = wc;
    const d = await daemon([dir]);
    const call = local(d).check({
      working_copy_id: "99999999-9999-4999-8999-999999999999",
      path: "a.txt",
      ranges: [[1, 1]],
    });
    await expect(call).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("starts following a repository added to the config while it runs", async () => {
    const configDir = join(scratch, "config");
    const d = await daemon([], configDir);
    const wc = makeWorkingCopy({ "a.txt": lines(10) });
    const tree = `${wc.dir}-linked`;
    run(wc.dir, "worktree", "add", "-q", "-b", "linked", tree);
    write(tree, { "a.txt": lines(10).replace("line2\n", "two\n") });

    await addRepository(configDir, wc.dir);
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 2, 2)).warnings).toHaveLength(1);
    });
    expect(roots(d)).toEqual([wc.dir, tree].map((p) => realpathSync(p)).sort());
  });
});

const roots = (d: Daemon) =>
  d
    .reporters()
    .map((r) => r.root)
    .sort();

describe("following a repository's worktrees", () => {
  it("reports a worktree added while it runs, and drops one that is removed", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(10) });
    const d = await daemon([wc.dir]);
    expect(roots(d)).toEqual([realpathSync(wc.dir)]);

    const tree = `${wc.dir}-new`;
    run(wc.dir, "worktree", "add", "-q", "-b", "new", tree);
    write(tree, { "a.txt": lines(10).replace("line2\n", "two\n") });
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 2, 2)).warnings).toHaveLength(1);
    });
    expect(roots(d)).toEqual([wc.dir, tree].map((p) => realpathSync(p)).sort());

    run(wc.dir, "worktree", "remove", "--force", tree);
    await eventually(() => expect(roots(d)).toEqual([realpathSync(wc.dir)]));
  });

  it("drops a worktree whose directory was deleted without telling git", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(10) });
    const tree = `${wc.dir}-doomed`;
    run(wc.dir, "worktree", "add", "-q", "-b", "doomed", tree);
    const d = await daemon([tree]);
    expect(roots(d)).toHaveLength(2);

    rmSync(tree, { recursive: true, force: true });
    await eventually(() => expect(roots(d)).toEqual([realpathSync(wc.dir)]));
  });

  it("follows a repository once, however many of its worktrees it is given", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(10) });
    const tree = `${wc.dir}-twin`;
    run(wc.dir, "worktree", "add", "-q", "-b", "twin", tree);
    const d = await daemon([wc.dir, tree, wc.dir]);
    expect(roots(d)).toEqual([wc.dir, tree].map((p) => realpathSync(p)).sort());
  });
});

describe("merging two live worktrees it reports", () => {
  it("confirms their collision with git's merge of both working trees, and redoes it as they change", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(40) });
    const tree = `${wc.dir}-other`;
    run(wc.dir, "worktree", "add", "-q", "-b", "other", tree);
    write(wc.dir, { "a.txt": lines(40).replace("line10\n", "ten here\n") });
    write(tree, { "a.txt": lines(40).replace("line20\n", "twenty there\n") });
    await daemon([wc.dir]);

    const pair = () =>
      [...hg.server.hub.index.collisionsAt(wc.repo, "a.txt", Date.now()).values()].flatMap((m) => [
        ...m.values(),
      ]);
    // Ten lines apart: nearby, and git merges them cleanly.
    await eventually(() =>
      expect(pair()).toMatchObject([
        { type: "PROXIMITY_ALERT", confirmed: false, severity: "LOW" },
        { type: "PROXIMITY_ALERT", confirmed: false, severity: "LOW" },
      ]),
    );

    write(tree, { "a.txt": lines(40).replace("line10\n", "ten, differently\n") });
    await eventually(() =>
      expect(pair()).toMatchObject([
        { type: "DIRECT_OVERLAP", confirmed: true, severity: "HIGH" },
        { type: "DIRECT_OVERLAP", confirmed: true, severity: "HIGH" },
      ]),
    );
  });
});

describe("parked work in a repository with several worktrees", () => {
  /** A repository with a parked branch and a second worktree on a branch of its own. */
  function worktrees() {
    const wc = makeWorkingCopy({ "a.txt": lines(30) });
    for (const [branch, line] of [
      ["parked-x", 25],
      ["feature-wt", 5],
    ] as const) {
      run(wc.dir, "checkout", "-q", "-b", branch, "main");
      write(wc.dir, { "a.txt": lines(30).replace(`line${line}\n`, `${branch}\n`) });
      commitAll(wc.dir, branch);
    }
    run(wc.dir, "checkout", "-q", "main");
    const tree = `${wc.dir}-wt`;
    run(wc.dir, "worktree", "add", "-q", tree, "feature-wt");
    return { wc, tree };
  }
  const entries = (repo: string) => hg.server.hub.index.entriesAt(repo, "a.txt", Date.now());

  it("reports each parked branch once, and no branch a worktree has checked out", async () => {
    const { wc, tree } = worktrees();
    const d = await daemon([tree, wc.dir]);

    await eventually(() =>
      expect(
        entries(wc.repo)
          .map((e) => [e.kind, e.branch])
          .sort(),
      ).toEqual([
        ["live", "feature-wt"],
        ["parked", "parked-x"],
      ]),
    );
    // One worktree sends the parked branch; the other sends only its own live work.
    const sent = async (i: number) => {
      const r = d.reporters()[i]!;
      const before = r.sent;
      await r.refresh();
      return r.sent - before;
    };
    expect([await sent(0), await sent(1)]).toEqual([2, 1]);
  });

  it("keeps reporting it from another worktree once the one reporting it is deleted", async () => {
    const { wc, tree } = worktrees();
    const d = await daemon([tree, wc.dir]);
    const parked = () => entries(wc.repo).filter((e) => e.kind === "parked");
    await eventually(() => expect(parked()).toHaveLength(1));
    const { workingCopyId, receivedAt } = parked()[0]!;

    run(wc.dir, "worktree", "remove", "--force", tree);
    await Promise.all(d.reporters().map((r) => r.refresh()));
    await Promise.all(d.reporters().map((r) => r.refresh()));

    // Its branch is now checked out nowhere, so it is parked work too.
    await eventually(() =>
      expect(parked().sort((a, b) => a.branch.localeCompare(b.branch))).toMatchObject([
        { branch: "feature-wt" },
        {
          workingCopyId,
          branch: "parked-x",
          receivedAt: expect.toSatisfy((t: number) => t > receivedAt),
        },
      ]),
    );
    // Nothing the daemon writes brings the deleted worktree back.
    expect(existsSync(tree)).toBe(false);
  });
});
