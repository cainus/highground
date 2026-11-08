import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "@highground/log";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addWorkingCopy } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { DaemonFileSchema, daemonFilePath } from "../src/discovery.ts";
import type { daemonContract } from "../src/local-contract.ts";
import {
  cleanupRepos,
  eventually,
  lines,
  makeWorkingCopy,
  peerHeartbeat,
  peerQuery,
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

  it("starts watching a working copy added to the config while it runs", async () => {
    const configDir = join(scratch, "config");
    const d = await daemon([], configDir);
    const wc = makeWorkingCopy({ "a.txt": lines(10) });
    const { dir } = wc;
    write(dir, { "a.txt": lines(10).replace("line2\n", "two\n") });

    await addWorkingCopy(configDir, dir);
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 2, 2)).warnings).toHaveLength(1);
    });
    expect(d.reporters()).toHaveLength(1);
  });
});
