import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HeartbeatLog } from "../src/db/heartbeat-log.ts";
import { maintainPartitions } from "../src/db/partitions.ts";
import { freshDatabase } from "./database.ts";
import { ALICE, BOB, file, heartbeat } from "./fixtures.ts";

const DAY = 86_400_000;
let db: Awaited<ReturnType<typeof freshDatabase>>;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await freshDatabase();
  sql = postgres(db.url, { onnotice: () => {} });
});
afterAll(async () => {
  await sql.end();
  await db.close();
});

const partitions = async (): Promise<string[]> =>
  (
    await sql<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'heartbeats' ORDER BY 1`
  ).map((r) => r.name);

describe("maintainPartitions", () => {
  it("creates today's partition and three days ahead, idempotently", async () => {
    const now = new Date("2026-11-07T15:00:00Z");
    const first = await maintainPartitions(sql, now);
    expect(first.created).toEqual([
      "heartbeats_20261107",
      "heartbeats_20261108",
      "heartbeats_20261109",
      "heartbeats_20261110",
    ]);
    expect((await maintainPartitions(sql, now)).created).toEqual([]);
  });

  it("drops partitions whose whole day is more than three days old", async () => {
    const now = new Date("2026-11-07T15:00:00Z");
    await maintainPartitions(sql, new Date(now.getTime() - 6 * DAY));
    const { dropped } = await maintainPartitions(sql, now);
    // Nov 4 ends at Nov 5 00:00, inside the last 72 h, so it stays.
    expect(dropped).toEqual(["heartbeats_20261101", "heartbeats_20261102", "heartbeats_20261103"]);
    // Nov 5–6 were never created: only "today" and three days ahead of each call are.
    expect(await partitions()).toEqual([
      "heartbeats_20261104",
      "heartbeats_20261107",
      "heartbeats_20261108",
      "heartbeats_20261109",
      "heartbeats_20261110",
    ]);
  });
});

describe("HeartbeatLog", () => {
  beforeAll(async () => {
    await maintainPartitions(sql, new Date());
  });

  const rowCount = async () =>
    (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM heartbeats`)[0]?.n ?? 0;

  it("stores each heartbeat with the time it was applied, and reads them back in order", async () => {
    const log = new HeartbeatLog(sql, "instance-a");
    const at = Date.now();
    await Promise.all([
      log.append(heartbeat(ALICE, [file("a.ts", [1, 1])]), at),
      log.append(heartbeat(BOB, [file("b.ts", [2, 2])]), at + 1),
    ]);

    const rows = await log.since(new Date(at - 60_000));
    expect(rows.map((r) => [r.heartbeat.working_copy_id, r.receivedAt])).toEqual([
      [ALICE, at],
      [BOB, at + 1],
    ]);
    expect(rows[0]?.heartbeat.files[0]?.changes).toEqual([{ range: [1, 1], digest: null }]);
    expect(await log.since(new Date(at + 60_000))).toEqual([]);
    await log.stop();
  });

  it("group-commits heartbeats that arrive together into one insert", async () => {
    const log = new HeartbeatLog(sql, "instance-a", { flushMs: 20 });
    const before = await rowCount();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        log.append(heartbeat(ALICE, [file(`f${i}.ts`, [1, 1])]), Date.now()),
      ),
    );
    expect(log.flushes).toBe(1);
    expect((await rowCount()) - before).toBe(50);
    await log.stop();
  });

  it("splits a burst larger than the batch limit", async () => {
    const log = new HeartbeatLog(sql, "instance-a", { flushMs: 20, maxBatch: 100 });
    await Promise.all(
      Array.from({ length: 250 }, () =>
        log.append(heartbeat(ALICE, [file("a.ts", [1, 1])]), Date.now()),
      ),
    );
    expect(log.flushes).toBe(3);
    await log.stop();
  });

  it("keeps retrying a failed batch until it commits, losing nothing", async () => {
    const errors: unknown[] = [];
    const log = new HeartbeatLog(sql, "instance-a", {
      flushMs: 1,
      retryMs: 20,
      onError: (e) => errors.push(e),
    });
    // A month ahead has no partition yet, so the insert fails until one exists.
    const future = Date.now() + 30 * 86_400_000;
    const done = log.append(heartbeat(ALICE, [file("a.ts", [1, 1])]), future);
    await expect.poll(() => errors.length).toBeGreaterThan(0);
    await maintainPartitions(sql, new Date(future), { ahead: 0, keepDays: 365 });
    await done;
    expect((await log.since(new Date(future - 1))).length).toBe(1);
    await log.stop();
  });

  it("writes everything still pending when stopped", async () => {
    const log = new HeartbeatLog(sql, "instance-a", { flushMs: 60_000 });
    const before = await rowCount();
    void log.append(heartbeat(ALICE, [file("a.ts", [1, 1])]), Date.now());
    await log.stop();
    expect((await rowCount()) - before).toBe(1);
  });

  it("notifies other instances with the heartbeat itself, but not the one that wrote it", async () => {
    const a = new HeartbeatLog(sql, "instance-a");
    const b = new HeartbeatLog(sql, "instance-b");
    const seenByA: string[] = [];
    const seenByB: [string, number][] = [];
    const stopA = await a.listen((hb) => seenByA.push(hb.working_copy_id));
    const stopB = await b.listen((hb, at) => seenByB.push([hb.working_copy_id, at]));

    const at = Date.now();
    await a.append(heartbeat(ALICE, [file("a.ts", [1, 1])]), at);
    await expect.poll(() => seenByB).toEqual([[ALICE, at]]);
    expect(seenByA).toEqual([]);
    expect(b.fetches).toBe(0);

    await stopA();
    await stopB();
    await a.stop();
    await b.stop();
  });

  it("fetches a heartbeat too large to ride in the notification", async () => {
    const a = new HeartbeatLog(sql, "instance-a");
    const b = new HeartbeatLog(sql, "instance-b");
    const seen: number[] = [];
    const stop = await b.listen((hb) => seen.push(hb.files.length));
    const big = heartbeat(
      BOB,
      Array.from({ length: 200 }, (_, i) => file(`src/some/long/path/file-${i}.ts`, [1, 1])),
    );
    await a.append(big, Date.now());
    await expect.poll(() => seen).toEqual([200]);
    expect(b.fetches).toBe(1);
    await stop();
    await a.stop();
    await b.stop();
  });
});
