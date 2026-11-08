import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshDatabase } from "./database.ts";
import { ALICE, BOB, REPO, SHA } from "./fixtures.ts";

/** `main.ts` as a real process: what an operator, Docker and a crash see. */

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
let db: Awaited<ReturnType<typeof freshDatabase>>;
let logDir: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  db = await freshDatabase();
  logDir = mkdtempSync(join(tmpdir(), "highground-main-log-"));
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});
afterAll(async () => {
  await db.close();
  rmSync(logDir, { recursive: true, force: true });
});

interface Started {
  child: ChildProcess;
  url: string;
  exited: Promise<number | null>;
}

function launch(env: Record<string, string>) {
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { child, exited };
}

/** Starts the server from the environment and waits for its `listening` line on stdout. */
async function start(): Promise<Started> {
  const { child, exited } = launch({
    DATABASE_URL: db.url,
    HIGHGROUND_ALLOW_ALL: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_DIR: logDir,
    LOG_STDOUT: "1",
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  for await (const line of createInterface({ input: child.stdout! })) {
    const entry = JSON.parse(line) as { msg: string; url?: string };
    if (entry.msg === "listening" && entry.url) return { child, url: entry.url, exited };
  }
  throw new Error(`the server exited before listening: ${stderr}`);
}

const send = (url: string) =>
  fetch(`${url}/api/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: REPO,
      working_copy_id: BOB,
      actor: { type: "cli", id: "daemon" },
      author: "bob@acme.dev",
      branch: "feature",
      base_sha: SHA,
      scope: "partial",
      files: [{ path: "a.ts", changes: [{ range: [50, 75], digest: null }] }],
      ttl_seconds: 300,
    }),
  });

const collides = async (url: string) => {
  const params = new URLSearchParams({
    repo: REPO,
    path: "a.ts",
    start: "60",
    end: "60",
    working_copy_id: ALICE,
    base_sha: SHA,
  });
  const res = await fetch(`${url}/api/v1/warnings?${params}`);
  return ((await res.json()) as { has_collisions: boolean }).has_collisions;
};

describe("main", () => {
  it("survives being killed: work that reached the log is warned on again, unsent by anyone", async () => {
    const first = await start();
    expect((await send(first.url)).status).toBe(200);
    const sql = postgres(db.url, { max: 1, onnotice: () => {} });
    await expect
      .poll(
        async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM heartbeats`)[0]?.n,
      )
      .toBe(1);
    await sql.end();

    first.child.kill("SIGKILL");
    await first.exited;

    const second = await start();
    expect(await collides(second.url)).toBe(true);
  });

  it("stops cleanly on SIGTERM, exiting 0 and saying so in its log", async () => {
    const { child, exited } = await start();
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    const lines = readdirSync(logDir).flatMap((f) =>
      readFileSync(join(logDir, f), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { msg: string; service: string }),
    );
    expect(lines.map((l) => l.msg)).toEqual(expect.arrayContaining(["shutting down", "stopped"]));
  });

  it("refuses a bad configuration with exit code 2, naming what is wrong", async () => {
    const { child, exited } = launch({ HIGHGROUND_ALLOW_ALL: "1", LOG_DIR: logDir });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    expect(await exited).toBe(2);
    expect(stderr).toMatch(/DATABASE_URL/);
  });

  it("exits 1, logging why, when it cannot start", async () => {
    const { exited } = launch({
      DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
      HIGHGROUND_ALLOW_ALL: "1",
      LOG_DIR: logDir,
    });
    expect(await exited).toBe(1);
    const fatal = readdirSync(logDir)
      .flatMap((f) => readFileSync(join(logDir, f), "utf8").trim().split("\n"))
      .map((l) => JSON.parse(l) as { level: string; msg: string })
      .filter((l) => l.level === "fatal");
    expect(fatal).toContainEqual(expect.objectContaining({ msg: "could not start" }));
  });
});
