import { HeartbeatSchema, type HeartbeatInput } from "@highground/core";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowAll } from "../src/auth.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";
import { ALICE, BOB, CAROL, REPO, SHA } from "./fixtures.ts";

let db: Awaited<ReturnType<typeof freshDatabase>>;
const running: RunningServer[] = [];

beforeAll(async () => {
  db = await freshDatabase();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  const sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql`TRUNCATE heartbeats`;
  await sql.end();
});
afterAll(async () => {
  await db.close();
});

async function server(
  options: { graceMs?: number; sweepMs?: number } = {},
): Promise<RunningServer> {
  const s = await startServer({ databaseUrl: db.url, port: 0, auth: allowAll, ...options });
  running.push(s);
  return s;
}

const body = (workingCopyId: string, files: HeartbeatInput["files"], extra: object = {}) => ({
  repo: REPO,
  working_copy_id: workingCopyId,
  actor: { type: "cli", id: "daemon" },
  author: "dev@acme.com",
  branch: "feature",
  base_sha: SHA,
  scope: "partial",
  files,
  ...extra,
});
const lines = (path: string, start: number, end: number) => ({
  path,
  changes: [{ range: [start, end], digest: null }],
});

async function post(s: RunningServer, payload: object) {
  const res = await fetch(`${s.url}/api/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: (await res.json()) as { warnings: { type: string }[] } };
}

async function query(
  s: RunningServer,
  workingCopyId: string,
  path: string,
  start: number,
  end: number,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams({
    repo: REPO,
    path,
    start: String(start),
    end: String(end),
    working_copy_id: workingCopyId,
    base_sha: SHA,
    ...extra,
  });
  const res = await fetch(`${s.url}/api/v1/warnings?${params}`);
  return (await res.json()) as {
    has_collisions: boolean;
    warnings: { type: string; peer: { working_copy_id: string } }[];
  };
}

/** Reads SSE `data:` payloads from a stream until `count` arrive. */
async function readEvents(
  res: Response,
  count: number,
): Promise<{ event: string; warning: { type: string } }[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: { event: string; warning: { type: string } }[] = [];
  let buffer = "";
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (data) events.push(JSON.parse(data));
    }
  }
  reader.releaseLock();
  return events;
}

describe("REST", () => {
  it("answers a heartbeat with the collisions it causes", async () => {
    const s = await server();
    expect((await post(s, body(BOB, [lines("a.ts", 50, 75)]))).json.warnings).toEqual([]);

    const res = await post(s, body(ALICE, [lines("a.ts", 45, 62)]));
    expect(res.status).toBe(200);
    expect(res.json.warnings).toMatchObject([
      { type: "DIRECT_OVERLAP", peer: { working_copy_id: BOB } },
    ]);
  });

  it("answers a read-only warnings query", async () => {
    const s = await server();
    await post(s, body(BOB, [lines("a.ts", 50, 75)]));
    const res = await query(s, ALICE, "a.ts", 70, 80);
    expect(res.has_collisions).toBe(true);
    expect(res.warnings).toMatchObject([
      { type: "DIRECT_OVERLAP", peer: { working_copy_id: BOB } },
    ]);
    expect((await query(s, ALICE, "a.ts", 500, 500)).has_collisions).toBe(false);
  });

  it("rejects an invalid heartbeat with 400", async () => {
    const s = await server();
    expect((await post(s, body(BOB, [lines("a.ts", 9, 5)]))).status).toBe(400);
  });

  it("refuses pushed work from a client: only the server's mirror publishes it", async () => {
    const s = await server();
    const res = await post(s, body(BOB, [lines("a.ts", 1, 2)], { kind: "pushed" }));
    expect(res.status).toBe(403);
  });

  it("leaves out the pushed copy of the asker's own branch", async () => {
    const s = await server();
    s.hub.heartbeat(
      HeartbeatSchema.parse(
        body(CAROL, [lines("a.ts", 10, 12)], {
          kind: "pushed",
          branch: "feature",
          head_sha: "c".repeat(40),
        }),
      ),
    );
    expect((await query(s, ALICE, "a.ts", 11, 11)).warnings).toHaveLength(1);
    expect((await query(s, ALICE, "a.ts", 11, 11, { branch: "feature" })).warnings).toEqual([]);
  });

  it("writes every heartbeat to the log within a flush of acknowledging it", async () => {
    const s = await server();
    await post(s, body(BOB, [lines("a.ts", 1, 1)]));
    const sql = postgres(db.url, { max: 1, onnotice: () => {} });
    await expect
      .poll(
        async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM heartbeats`)[0]?.n,
      )
      .toBe(1);
    await sql.end();
  });
});

describe("SSE subscription", () => {
  it("pushes collision_started and collision_ended to a subscribed working copy", async () => {
    const s = await server();
    const params = new URLSearchParams({ repo: REPO, working_copy_id: ALICE });
    const stream = await fetch(`${s.url}/api/v1/subscribe?${params}`, {
      headers: { accept: "text/event-stream" },
    });
    expect(stream.headers.get("content-type")).toMatch(/text\/event-stream/);

    await post(s, body(ALICE, [lines("a.ts", 45, 62)]));
    await post(s, body(BOB, [lines("a.ts", 50, 75)]));
    await post(s, body(BOB, [{ path: "a.ts", changes: [] }]));

    expect(await readEvents(stream, 2)).toMatchObject([
      { event: "collision_started", warning: { type: "DIRECT_OVERLAP" } },
      { event: "collision_ended", warning: { type: "DIRECT_OVERLAP" } },
    ]);
    await stream.body?.cancel();
  });

  it("replays current collisions to a new subscriber", async () => {
    const s = await server();
    await post(s, body(ALICE, [lines("a.ts", 45, 62)]));
    await post(s, body(BOB, [lines("a.ts", 50, 75)]));
    const params = new URLSearchParams({ repo: REPO, working_copy_id: ALICE });
    const stream = await fetch(`${s.url}/api/v1/subscribe?${params}`);
    expect(await readEvents(stream, 1)).toMatchObject([{ event: "collision_started" }]);
    await stream.body?.cancel();
  });
});

describe("durability and scale-out", () => {
  it("rebuilds live state from the log after a restart", async () => {
    const first = await server();
    await post(first, body(BOB, [lines("a.ts", 50, 75)]));
    await first.close();
    running.splice(running.indexOf(first), 1);

    const second = await server();
    expect((await query(second, ALICE, "a.ts", 60, 60)).has_collisions).toBe(true);
  });

  it("keeps two instances on one database in step", async () => {
    const a = await server();
    const b = await server();
    await post(a, body(BOB, [lines("a.ts", 50, 75)]));
    await expect
      .poll(async () => (await query(b, ALICE, "a.ts", 60, 60)).has_collisions)
      .toBe(true);
  });
});

describe("presence", () => {
  it("clears a working copy whose stream closes and does not come back", async () => {
    const s = await server({ graceMs: 300 });
    const params = new URLSearchParams({ repo: REPO, working_copy_id: BOB });
    const stream = await fetch(`${s.url}/api/v1/subscribe?${params}`);
    await post(s, body(BOB, [lines("a.ts", 50, 75)]));
    expect((await query(s, ALICE, "a.ts", 60, 60)).has_collisions).toBe(true);

    await stream.body?.cancel();
    await expect
      .poll(async () => (await query(s, ALICE, "a.ts", 60, 60)).has_collisions)
      .toBe(false);

    // The clear is in the log, so a restart does not bring Bob back.
    await s.close();
    running.splice(running.indexOf(s), 1);
    const again = await server();
    expect((await query(again, ALICE, "a.ts", 60, 60)).has_collisions).toBe(false);
  });

  it("does not clear anyone when the server itself shuts down", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const s = await server({ graceMs: 100 });
      const params = new URLSearchParams({ repo: REPO, working_copy_id: BOB });
      await fetch(`${s.url}/api/v1/subscribe?${params}`);
      await post(s, body(BOB, [lines("a.ts", 50, 75)]));
      await s.close();
      running.splice(running.indexOf(s), 1);
      await new Promise((r) => setTimeout(r, 300));

      // No clear was attempted: none failed against the closed pool, none was logged.
      expect(rejections).toEqual([]);
      const sql = postgres(db.url, { max: 1, onnotice: () => {} });
      const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM heartbeats`;
      await sql.end();
      expect(row?.count).toBe(1);
      const again = await server();
      expect((await query(again, ALICE, "a.ts", 60, 60)).has_collisions).toBe(true);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("keeps a working copy that reconnects within the grace period", async () => {
    const s = await server({ graceMs: 1_000 });
    const params = new URLSearchParams({ repo: REPO, working_copy_id: BOB });
    const first = await fetch(`${s.url}/api/v1/subscribe?${params}`);
    await post(s, body(BOB, [lines("a.ts", 50, 75)]));
    await first.body?.cancel();
    const second = await fetch(`${s.url}/api/v1/subscribe?${params}`);
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await query(s, ALICE, "a.ts", 60, 60)).has_collisions).toBe(true);
    await second.body?.cancel();
  });
});

describe("expiry", () => {
  it("stops warning about a silent client within ttl + 5 s", async () => {
    const s = await server({ sweepMs: 5_000 });
    await post(s, body(BOB, [lines("a.ts", 50, 75)], { ttl_seconds: 5 }));
    const start = Date.now();
    await expect
      .poll(async () => (await query(s, ALICE, "a.ts", 60, 60)).has_collisions, {
        timeout: 10_000,
        interval: 250,
      })
      .toBe(false);
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 15_000);
});
