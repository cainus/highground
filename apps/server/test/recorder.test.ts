import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowAll } from "../src/auth.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";
import { ALICE, BOB, CAROL, file, heartbeat, REPO } from "./fixtures.ts";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let sql: postgres.Sql;
const running: RunningServer[] = [];

beforeAll(async () => {
  db = await freshDatabase();
  sql = postgres(db.url, { onnotice: () => {} });
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  await sql`TRUNCATE heartbeats, collision_events`;
});
afterAll(async () => {
  await sql.end();
  await db.close();
});

async function server(): Promise<RunningServer> {
  const s = await startServer({
    databaseUrl: db.url,
    port: 0,
    auth: allowAll,
    graceMs: 200,
    sweepMs: 50,
    recorderMs: 50,
  });
  running.push(s);
  return s;
}

interface Row {
  path: string;
  type: string;
  severity: string;
  a_author: string;
  b_author: string;
  started_at: Date;
  ended_at: Date | null;
  ended_by: string | null;
  changed_course: boolean;
}
const rows = () => sql<Row[]>`SELECT * FROM collision_events ORDER BY id`;

async function eventually<T>(check: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

const agent = { type: "agent" as const, id: "claude-7" };

describe("the collision recorder (plan 05)", () => {
  it("records one episode per colliding pair, from its start to its end", async () => {
    const s = await server();
    await eventually(async () => expect(s.recorder!.leading).toBe(true));
    s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [10, 12])]));
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [11, 11])]));
    // Bob's lines move under the same collision: still one episode.
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [12, 12])]));
    await eventually(async () => {
      expect(await rows()).toMatchObject([
        { path: "a.ts", type: "DIRECT_OVERLAP", severity: "HIGH", ended_at: null },
      ]);
    });

    s.hub.heartbeat(heartbeat(BOB, [file("a.ts")]));
    await eventually(async () => {
      const [row] = await rows();
      expect(row!.ended_at).not.toBeNull();
      expect(row!.ended_by).toBe(row!.a_author === "2222@acme.com" ? "a" : "b");
      expect(row!.changed_course).toBe(false);
    });
  });

  it("leaves other pairs' episodes open when a third actor changes the same path", async () => {
    const s = await server();
    await eventually(async () => expect(s.recorder!.leading).toBe(true));
    s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [10, 12])]));
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [11, 11])]));
    // Carol works on the same file without colliding, then leaves it.
    s.hub.heartbeat(heartbeat(CAROL, [file("a.ts", [90, 90])]));
    s.hub.heartbeat(heartbeat(CAROL, [file("a.ts")]));
    await s.recorder.flush();
    expect(await rows()).toMatchObject([
      { a_author: expect.any(String), b_author: expect.any(String), ended_at: null },
    ]);
  });

  it("keeps the strongest verdict an episode reached", async () => {
    const s = await server();
    await eventually(async () => expect(s.recorder!.leading).toBe(true));
    s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [10, 10])]));
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [14, 14])]));
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [10, 10])]));
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [14, 14])]));
    await eventually(async () =>
      expect(await rows()).toMatchObject([
        { type: "DIRECT_OVERLAP", severity: "HIGH", ended_at: null },
      ]),
    );
  });

  it("counts an agent withdrawing its own intent as changing course", async () => {
    const s = await server();
    await eventually(async () => expect(s.recorder!.leading).toBe(true));
    s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [10, 12])]));
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [11, 11])], { actor: agent }));
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [40, 41])], { actor: agent }));
    await eventually(async () =>
      expect(await rows()).toMatchObject([{ ended_by: expect.any(String), changed_course: true }]),
    );
  });

  it("does not count an agent whose work expired as changing course", async () => {
    const s = await server();
    await eventually(async () => expect(s.recorder!.leading).toBe(true));
    s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [10, 12])]));
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [11, 11])], { actor: agent, ttl_seconds: 5 }));
    await eventually(
      async () =>
        expect(await rows()).toMatchObject([{ ended_by: "expired", changed_course: false }]),
      8_000,
    );
  });

  it("retries writes the database refused, so a database blip loses no history", async () => {
    const s = await server();
    await eventually(async () => expect(s.recorder!.leading).toBe(true));
    await sql`ALTER TABLE collision_events ADD CONSTRAINT refuse CHECK (false) NOT VALID`;
    try {
      s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [10, 12])]));
      s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [11, 11])]));
      s.hub.heartbeat(heartbeat(BOB, [file("a.ts")]));
      await new Promise((r) => setTimeout(r, 300));
      expect(await rows()).toHaveLength(0);
    } finally {
      await sql`ALTER TABLE collision_events DROP CONSTRAINT refuse`;
    }
    await eventually(async () =>
      expect(await rows()).toMatchObject([{ path: "a.ts", ended_at: expect.any(Date) }]),
    );
  });

  it("writes what is still pending when the server closes", async () => {
    const s = await server();
    await eventually(async () => expect(s.recorder!.leading).toBe(true));
    s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [10, 12])]));
    s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [11, 11])]));
    running.splice(running.indexOf(s), 1);
    await s.close();
    expect(await rows()).toMatchObject([{ path: "a.ts", ended_at: null }]);
  });

  it("records on one instance only, and the next one takes over open episodes", async () => {
    const first = await server();
    await eventually(async () => expect(first.recorder!.leading).toBe(true));
    const second = await server();
    first.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [10, 12])]));
    first.hub.heartbeat(heartbeat(BOB, [file("a.ts", [11, 11])]));
    await eventually(async () => expect(await rows()).toHaveLength(1));
    expect(second.recorder!.leading).toBe(false);

    await first.close();
    running.splice(running.indexOf(first), 1);
    await eventually(async () => expect(second.recorder!.leading).toBe(true));
    // The episode stays open — not ended and reopened — and still ends when it ends.
    second.hub.heartbeat(heartbeat(BOB, [file("a.ts", [30, 30])]));
    await eventually(async () => {
      const all = await rows();
      expect(all).toHaveLength(1);
      expect(all[0]!.ended_at).not.toBeNull();
    });
  });

  it("closes, on taking over, episodes that ended while no one was recording", async () => {
    await sql`INSERT INTO collision_events
      (pair_key, repo, path, a_id, a_working_copy_id, a_actor, a_author, a_kind,
       b_id, b_working_copy_id, b_actor, b_author, b_kind, type, severity, approximate, started_at)
      VALUES ('stale', ${REPO}, 'gone.ts', 'x', ${ALICE}, '{"type":"cli","id":"daemon"}', 'a@x', 'live',
              'y', ${BOB}, '{"type":"cli","id":"daemon"}', 'b@x', 'live',
              'DIRECT_OVERLAP', 'HIGH', false, now() - interval '1 hour')`;
    const s = await server();
    await eventually(async () => expect(s.recorder!.leading).toBe(true));
    await eventually(async () =>
      expect(await rows()).toMatchObject([{ path: "gone.ts", ended_by: "expired" }]),
    );
  });

  it("deletes episodes that ended more than a year ago", async () => {
    await sql`INSERT INTO collision_events
      (pair_key, repo, path, a_id, a_working_copy_id, a_actor, a_author, a_kind,
       b_id, b_working_copy_id, b_actor, b_author, b_kind, type, severity, approximate,
       started_at, ended_at, ended_by)
      VALUES ('old', ${REPO}, 'old.ts', 'x', ${ALICE}, '{"type":"cli","id":"daemon"}', 'a@x', 'live',
              'y', ${BOB}, '{"type":"cli","id":"daemon"}', 'b@x', 'live',
              'DIRECT_OVERLAP', 'HIGH', false,
              now() - interval '400 days', now() - interval '399 days', 'a')`;
    const s = await server();
    await eventually(async () => expect(s.recorder!.leading).toBe(true));
    await s.recorder!.prune();
    expect(await rows()).toEqual([]);
  });
});
