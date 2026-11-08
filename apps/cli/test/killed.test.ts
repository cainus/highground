import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupRepos,
  eventually,
  lines,
  makeWorkingCopy,
  peerQuery,
  testServer,
  write,
  type TestServer,
} from "./helpers.ts";

/**
 * PRD §12, criterion 5, in real time: a daemon killed outright, with no chance to say
 * goodbye, stops warning anyone within 10 s, because its stream closed. The server runs
 * with production timing: a 10 s grace period and a 5 s sweep.
 */

let hg: TestServer;
const scratch = mkdtempSync(join(tmpdir(), "highground-killed-"));
let child: ChildProcess | undefined;

beforeAll(async () => {
  hg = await testServer(0, undefined, { graceMs: 10_000, sweepMs: 5_000 });
});
afterAll(async () => {
  child?.kill("SIGKILL");
  await hg.close();
  cleanupRepos();
  rmSync(scratch, { recursive: true, force: true });
});

describe("a killed daemon", () => {
  it("stops warning its peers within 10 s of dying", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    write(wc.dir, { "a.txt": lines(20).replace("line10\n", "changed10\n") });
    child = spawn(
      process.execPath,
      [new URL("../src/main.ts", import.meta.url).pathname, "daemon", wc.dir, "--server", hg.url],
      {
        env: {
          ...process.env,
          HIGHGROUND_CONFIG_DIR: join(scratch, "config"),
          HIGHGROUND_LOG_DIR: join(scratch, "logs"),
        },
        stdio: "ignore",
      },
    );
    const exited = new Promise((resolve) => child?.once("exit", resolve));
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 10, 10)).has_collisions).toBe(true);
    }, 15_000);

    child.kill("SIGKILL");
    await exited;
    const killedAt = Date.now();
    await eventually(async () => {
      expect((await peerQuery(hg.url, wc, "a.txt", 10, 10)).has_collisions).toBe(false);
    }, 12_000);
    const gone = Date.now() - killedAt;
    // Presence cleared it, not its TTL (60 s), and not before the grace period.
    expect(gone).toBeGreaterThanOrEqual(9_500);
    expect(gone).toBeLessThan(10_500);
  }, 40_000);
});
