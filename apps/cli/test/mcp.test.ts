import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLog } from "@highground/log";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon.ts";
import { daemonFilePath } from "../src/discovery.ts";
import { createMcpServer, type RadarAnswer } from "../src/mcp.ts";
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
const scratch = mkdtempSync(join(tmpdir(), "highground-mcp-"));
const logDir = join(scratch, "logs");
const log = createLog({ service: "mcp", dir: logDir });
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
  hg = await testServer();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
afterAll(async () => {
  await hg.close();
  cleanupRepos();
  rmSync(scratch, { recursive: true, force: true });
});

/** An MCP client connected in memory to a Highground MCP server running in `cwd`. */
async function agent(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const server = createMcpServer({ cwd, env, log, daemonTimeoutMs: 500 });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent as unknown as RadarAnswer;
  };
  return {
    intent: (path: string, ranges: [number, number][], intent = "work") =>
      call("broadcast_edit_intent", { path, ranges, intent }),
    check: (path: string, ranges: [number, number][]) => call("check_file_radar", { path, ranges }),
    client,
  };
}

async function runDaemon(dir: string): Promise<Daemon> {
  const d = new Daemon({ server: hg.url, dirs: [dir], log, reporter: { debounceMs: 50 } });
  await d.start();
  cleanup.push(() => d.stop());
  return d;
}

describe("highground mcp", () => {
  it("lists its two tools", async () => {
    const wc = makeWorkingCopy({ "a.txt": "x\n" });
    const { dir } = wc;
    const { client } = await agent(dir);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["broadcast_edit_intent", "check_file_radar"]);
  });

  it("goes through the daemon announced in the working copy, in working-copy lines", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    write(dir, { "a.txt": `new1\nnew2\n${lines(20)}` });
    await runDaemon(dir);
    await peerHeartbeat(hg.url, wc, "a.txt", [[10, 11]]);
    mkdirSync(join(dir, "src"));

    // From a subdirectory, naming the file relative to it.
    const answer = await (await agent(join(dir, "src"))).intent("../a.txt", [[12, 13]], "rename");
    expect(answer).toMatchObject({ route: "daemon", degraded: false });
    expect(answer.warnings).toMatchObject([{ your_lines: [12, 13], peer: { lines: [12, 13] } }]);

    const seen = (await peerQuery(hg.url, wc, "a.txt", 10, 11)).warnings;
    expect(seen.find((w) => w.peer.actor.type === "agent")).toMatchObject({
      peer: { actor: { id: expect.stringMatching(/^test-agent-[0-9a-f]{6}$/) }, intent: "rename" },
    });
  });

  it("uses HIGHGROUND_DAEMON_URL ahead of the discovery file", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    const d = await runDaemon(dir);
    await eventually(() => readFileSync(daemonFilePath(dir)));
    // Point the file at nothing; only the environment can reach the daemon.
    const file = JSON.parse(readFileSync(daemonFilePath(dir), "utf8")) as { port: number };
    writeFileSync(daemonFilePath(dir), JSON.stringify({ ...file, port: 1 }));
    await peerHeartbeat(hg.url, wc, "a.txt", [[5, 5]]);

    const answer = await (
      await agent(dir, { HIGHGROUND_DAEMON_URL: `http://127.0.0.1:${d.port}` })
    ).check("a.txt", [[5, 5]]);
    expect(answer).toMatchObject({ route: "daemon", warnings: [{ type: "DIRECT_OVERLAP" }] });
  });

  it("runs git itself when no daemon answers", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    write(dir, { "a.txt": lines(20).replace("line1\n", "") });
    await peerHeartbeat(hg.url, wc, "a.txt", [[10, 10]]);

    const answer = await (
      await agent(dir, { HIGHGROUND_SERVER_URL: hg.url })
    ).check("a.txt", [[9, 9]]);
    expect(answer).toMatchObject({
      route: "git",
      degraded: false,
      warnings: [{ your_lines: [9, 9], peer: { lines: [9, 9] } }],
    });
  });

  it("fails open with the reason when nothing answers", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(5) });
    const { dir } = wc;
    const answer = await (await agent(dir)).intent("a.txt", [[1, 2]]);
    expect(answer).toMatchObject({ route: null, degraded: true, warnings: [] });
    expect(answer.reason).toMatch(/no daemon announced/);
    expect(answer.reason).toMatch(/no server/);
  });

  it("fails open outside any working copy", async () => {
    const answer = await (await agent(scratch)).check("a.txt", [[1, 1]]);
    expect(answer).toMatchObject({ degraded: true, warnings: [] });
    expect(answer.reason).toMatch(/not in a git working copy/);
  });

  it("refuses a path outside the working copy, failing open", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(5) });
    const { dir } = wc;
    const answer = await (
      await agent(dir, { HIGHGROUND_SERVER_URL: hg.url })
    ).check("../x.txt", [[1, 1]]);
    expect(answer).toMatchObject({ degraded: true });
    expect(answer.reason).toMatch(/not inside the working copy/);
  });

  it("finds its working copy without git, as in a container mounting the worktree elsewhere", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(20) });
    const { dir } = wc;
    await runDaemon(dir);
    await eventually(() => readFileSync(daemonFilePath(dir)));
    await peerHeartbeat(hg.url, wc, "a.txt", [[5, 5]]);
    // The container sees the files and .highground/ at another path, and no usable .git.
    const mount = join(scratch, "workspace");
    cpSync(dir, mount, { recursive: true, filter: (src) => !src.includes(`${dir}/.git`) });

    const answer = await (await agent(join(mount))).check("a.txt", [[5, 5]]);
    expect(answer).toMatchObject({ route: "daemon", warnings: [{ type: "DIRECT_OVERLAP" }] });
  });

  it("writes nothing but protocol messages to stdout when run as a process", async () => {
    const wc = makeWorkingCopy({ "a.txt": lines(5) });
    const { dir } = wc;
    const child = spawn(
      process.execPath,
      [new URL("../src/main.ts", import.meta.url).pathname, "mcp"],
      {
        cwd: dir,
        env: {
          ...process.env,
          HIGHGROUND_LOG_DIR: logDir,
          HIGHGROUND_SERVER_URL: "http://127.0.0.1:1",
        },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    const out = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const next = async () =>
      JSON.parse((await out.next()).value as string) as Record<string, unknown>;

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "1" },
      },
    });
    expect(await next()).toMatchObject({ jsonrpc: "2.0", id: 1 });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "check_file_radar", arguments: { path: "a.txt", ranges: [[1, 1]] } },
    });
    const reply = await next();
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 2 });
    expect((reply.result as { structuredContent: RadarAnswer }).structuredContent.degraded).toBe(
      true,
    );

    child.stdin.end();
    child.kill();
  });
});
