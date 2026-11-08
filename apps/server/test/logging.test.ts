import { createLogs } from "@highground/log";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowAll, type Authorizer } from "../src/auth.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";
import { BOB, REPO, SHA } from "./fixtures.ts";

let db: Awaited<ReturnType<typeof freshDatabase>>;
const running: RunningServer[] = [];

beforeAll(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});
afterAll(async () => {
  await db.close();
});

type Line = Record<string, unknown>;

/** A server whose log lines are collected, parsed, in order. */
async function server(options: { auth?: Authorizer; slowMs?: number } = {}) {
  const lines: Line[] = [];
  const log = createLogs({ echo: { write: (line: string) => lines.push(JSON.parse(line)) } });
  const s = await startServer({ databaseUrl: db.url, auth: allowAll, log, ...options });
  running.push(s);
  return { s, lines };
}

const heartbeat = (s: RunningServer, headers: Record<string, string> = {}) =>
  fetch(`${s.url}/api/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      repo: REPO,
      working_copy_id: BOB,
      actor: { type: "cli", id: "daemon" },
      author: "bob@acme.dev",
      branch: "feature",
      base_sha: SHA,
      scope: "partial",
      files: [{ path: "a.ts", changes: [{ range: [1, 2], digest: null }] }],
    }),
  });

describe("server logging", () => {
  it("logs an unexpected failure once, with its stack and the request's id", async () => {
    const broken: Authorizer = {
      authorize: () => Promise.reject(new Error("kaboom")),
    };
    const { s, lines } = await server({ auth: broken });
    const res = await heartbeat(s, { "x-request-id": "req-123" });

    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toBe("req-123");
    const failures = lines.filter((l) => l.msg === "request failed");
    expect(failures).toEqual([
      expect.objectContaining({ level: "error", service: "backend", requestId: "req-123" }),
    ]);
    expect(String(failures[0]?.error)).toMatch(/kaboom[\s\S]*at /);
  });

  it("gives a request without a usable id a fresh one", async () => {
    const { s } = await server();
    const res = await heartbeat(s, { "x-request-id": "not a token; " + "x".repeat(200) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("writes nothing for requests that went as expected", async () => {
    const { s, lines } = await server();
    expect((await heartbeat(s)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(lines.filter((l) => l.level !== "info" || l.msg !== "listening")).toEqual([]);
  });

  it("logs a slow request at warn, with what it was and how long it took", async () => {
    const { s, lines } = await server({ slowMs: 0 });
    await heartbeat(s, { "x-request-id": "slow-1" });
    await expect
      .poll(() => lines.find((l) => l.msg === "slow request"))
      .toMatchObject({
        level: "warn",
        requestId: "slow-1",
        method: "POST",
        url: "/api/v1/heartbeat",
        status: 200,
        ms: expect.any(Number),
      });
  });

  it("does not count an event stream's lifetime as a slow request", async () => {
    const { s, lines } = await server({ slowMs: 0 });
    const params = new URLSearchParams({ repo: REPO, working_copy_id: BOB });
    const stream = await fetch(`${s.url}/api/v1/subscribe?${params}`);
    await stream.body?.cancel();
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.filter((l) => l.msg === "slow request")).toEqual([]);
  });

  it("says where it listens", async () => {
    const { s, lines } = await server();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: "info", msg: "listening", url: s.url }),
    );
  });
});
