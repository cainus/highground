import { contract, type Radar } from "@highground/core";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowAll } from "../src/auth.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";
import { ALICE, BOB, file, heartbeat, REPO } from "./fixtures.ts";

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

async function server(): Promise<{
  s: RunningServer;
  client: ContractRouterClient<typeof contract>;
}> {
  const s = await startServer({ databaseUrl: db.url, port: 0, auth: allowAll, radarMs: 200 });
  running.push(s);
  return { s, client: createORPCClient(new RPCLink({ url: `${s.url}/rpc` })) };
}

const workingCopies = (radar: Radar) =>
  radar.files.flatMap((f) => f.work.map((w) => `${f.path}:${w.working_copy_id.slice(0, 4)}`));

describe("the radar over the API", () => {
  it("answers a snapshot of the repository", async () => {
    const { s, client } = await server();
    s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [1, 3])]));
    expect(workingCopies(await client.radar({ repo: REPO }))).toEqual(["a.ts:1111"]);
  });

  it("streams a snapshot at once, then one per burst of changes", async () => {
    const { s, client } = await server();
    const controller = new AbortController();
    const stream = await client.watchRadar({ repo: REPO }, { signal: controller.signal });
    const first = await stream.next();
    expect(first.value).toEqual({
      repo: REPO,
      files: [],
      reporting: { working_copies: 0, last_heartbeat_at: null },
    });

    // Five heartbeats within the window are one update, carrying all of them.
    const started = Date.now();
    s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [1, 3])]));
    for (let i = 0; i < 4; i++) s.hub.heartbeat(heartbeat(BOB, [file("a.ts", [2 + i, 2 + i])]));
    const next = await stream.next();
    expect(workingCopies(next.value as Radar)).toEqual(["a.ts:1111", "a.ts:2222"]);
    expect((next.value as Radar).files[0]!.collisions).toHaveLength(1);

    // Work in another repository does not wake this stream.
    s.hub.heartbeat(heartbeat(ALICE, [file("a.ts", [9, 9])], { repo: "github.com/acme/other" }));
    s.hub.heartbeat(heartbeat(BOB, [file("b.ts", [1, 1])]));
    const third = await stream.next();
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(workingCopies(third.value as Radar)).toEqual(["a.ts:1111", "a.ts:2222", "b.ts:2222"]);
    controller.abort();
  });
});
