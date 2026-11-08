import type { Admin } from "@highground/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "@highground/log";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Reporter, type ReporterOptions } from "../src/reporter.ts";
import { serverClient } from "../src/server-client.ts";
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
const logDir = mkdtempSync(join(tmpdir(), "highground-cli-log-"));
const log = createLog({ service: "daemon", dir: logDir });
const reporters: Reporter[] = [];

beforeAll(async () => {
  hg = await testServer();
});
afterEach(async () => {
  await Promise.all(reporters.splice(0).map((r) => r.stop()));
});
afterAll(async () => {
  await hg.close();
  cleanupRepos();
  rmSync(logDir, { recursive: true, force: true });
});

async function reporter(
  root: string,
  options: Partial<ReporterOptions> = {},
  url = hg.url,
): Promise<Reporter> {
  const r = new Reporter({
    root,
    server: serverClient(url),
    log,
    debounceMs: 50,
    keepaliveMs: 60_000,
    ...options,
  });
  reporters.push(r);
  await r.start();
  return r;
}

const logLines = () =>
  readFileSync(join(logDir, `highground-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("Reporter", () => {
  it("reports live work as it is saved, and clears it when the edit is undone", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    const r = await reporter(dir);

    write(dir, { "a.txt": lines(20).replace("line5\n", "five\n") });
    const seen = await eventually(async () => {
      const { warnings } = await peerQuery(hg.url, wc, "a.txt", 5, 5);
      expect(warnings).toHaveLength(1);
      return warnings[0]!;
    });
    expect(seen).toMatchObject({
      type: "DIRECT_OVERLAP",
      peer: { working_copy_id: r.id, actor: { type: "cli", id: "daemon" }, lines: [5, 5] },
    });
    expect(seen.peer.author).toBe("test@example.com");

    write(dir, { "a.txt": lines(20) });
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 5, 5)).warnings).toEqual([]);
    });
  });

  it("stops reporting when stopped: its stream closes and the server clears its work", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    write(dir, { "a.txt": lines(20).replace("line5\n", "five\n") });
    const r = await reporter(dir);
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 5, 5)).warnings).toHaveLength(1);
    });

    const stopping = Date.now();
    await r.stop();
    expect(Date.now() - stopping).toBeLessThan(1_000);
    // The test server's presence grace is 200 ms; the TTL alone would take 60 s.
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 5, 5)).warnings).toEqual([]);
    }, 3_000);
  });

  it("reports edits in new directories and untracked files", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(3) });
    const { dir } = wc;
    await reporter(dir);
    write(dir, { "new.txt": "hello\n" });
    await eventually(async () => {
      const { warnings } = await peerQuery(hg.url, wc, "new.txt", 1, 0);
      expect(warnings.map((w) => w.peer.lines)).toEqual([null]);
    });
  });

  it("recomputes on every keepalive, so an edit the watcher missed still arrives", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    const r = await reporter(dir, { watch: false, keepaliveMs: 150 });
    const before = r.sent;
    write(dir, { "a.txt": lines(20).replace("line9\n", "nine\n") });
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 9, 9)).warnings).toHaveLength(1);
    });
    await eventually(() => expect(r.sent).toBeGreaterThan(before + 2));
  });

  it("sends every file when there are more than one heartbeat holds", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(3) });
    const { dir } = wc;
    write(dir, Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`f${i}.txt`, `${i}\n`])));
    await reporter(dir);
    for (const path of ["f0.txt", "f249.txt"]) {
      await eventually(async () => {
        expect((await peerQuery(hg.url, wc, path, 1, 0)).warnings).toHaveLength(1);
      });
    }
  });

  it("caps a file's changes at 50 and still covers every changed line", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(400) });
    const { dir } = wc;
    await reporter(dir);
    write(dir, { "a.txt": lines(400).replace(/line(\d*[05])\n/g, "changed$1\n") });
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 395, 395)).warnings).toHaveLength(1);
    });
    expect((await peerQuery(hg.url, wc, "a.txt", 5, 5)).warnings).toHaveLength(1);
  });

  it("follows collisions with its working copy over the subscription", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    const r = await reporter(dir);
    write(dir, { "a.txt": lines(20).replace("line5\n", "five\n") });
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 5, 5)).warnings).toHaveLength(1);
    });

    await peerHeartbeat(hg.url, wc, "a.txt", [[4, 6]]);
    await eventually(() =>
      expect(r.collisions()).toMatchObject([
        { type: "DIRECT_OVERLAP", path: "a.txt", peer: { actor: { id: "peer-agent" } } },
      ]),
    );
    await peerHeartbeat(hg.url, wc, "a.txt", []);
    await eventually(() => expect(r.collisions()).toEqual([]));
  });

  it("fails open while the server is down and catches up when it comes back", async () => {
    const port = await freePort();
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    write(dir, { "a.txt": lines(20).replace("line7\n", "seven\n") });
    const r = await reporter(dir, { keepaliveMs: 100 }, `http://127.0.0.1:${port}`);

    expect(r.degraded).toMatch(/fetch failed|ECONNREFUSED/);
    expect(logLines().some((l) => l.level === "warn" && l.msg === "heartbeat failed")).toBe(true);

    const late = await testServer(port);
    try {
      await eventually(async () => {
        expect((await peerQuery(late.url, wc, "a.txt", 7, 7)).warnings).toHaveLength(1);
      });
      expect(r.degraded).toBeNull();
      // The admin page hears what the outage was, once the server can be told.
      await eventually(async () => {
        const { clients } = (await (await fetch(`${late.url}/api/v1/admin`)).json()) as Admin;
        expect(clients.find((c) => c.repo === wc.repo)).toMatchObject({
          client: "daemon",
          route: null,
          degraded: expect.stringMatching(/^recovered after: .*(fetch failed|ECONNREFUSED)/),
        });
      });
    } finally {
      await r.stop();
      await late.close();
    }
  });

  it("degrades with the reason when the working copy cannot be reported", async () => {
    const wc = makeWorkingCopy({ "a.txt": "x\n" });
    const { dir } = wc;
    const { run } = await import("./helpers.ts");
    run(dir, "remote", "remove", "origin");
    const r = await reporter(dir);
    expect(r.degraded).toMatch(/no origin remote/);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}
