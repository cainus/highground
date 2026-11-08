import type { History } from "@highground/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowAll } from "../src/auth.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";
import { ALICE, BOB, CAROL, REPO } from "./fixtures.ts";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let sql: postgres.Sql;
let s: RunningServer;

const daemon = { type: "cli", id: "daemon" };
const claude = { type: "agent", id: "claude-1" };

/** An episode `daysAgo` days back, between two sides. */
async function episode(
  daysAgo: number,
  path: string,
  severity: string,
  [aWc, aActor, aAuthor]: [string, object, string],
  [bWc, bActor, bAuthor]: [string, object, string],
  extra: { changed?: boolean; repo?: string } = {},
) {
  await sql`INSERT INTO collision_events
    (pair_key, repo, path, a_id, a_working_copy_id, a_actor, a_author, a_kind,
     b_id, b_working_copy_id, b_actor, b_author, b_kind, type, severity, approximate,
     started_at, ended_at, ended_by, changed_course)
    VALUES (${`${Math.random()}`}, ${extra.repo ?? REPO}, ${path}, 'a', ${aWc}, ${sql.json(aActor)},
            ${aAuthor}, 'live', 'b', ${bWc}, ${sql.json(bActor)}, ${bAuthor}, 'live',
            ${severity === "HIGH" ? "DIRECT_OVERLAP" : "PROXIMITY_ALERT"}, ${severity}, false,
            now() - make_interval(days => ${daysAgo}), now() - make_interval(days => ${daysAgo}),
            'b', ${extra.changed ?? false})`;
}

beforeAll(async () => {
  db = await freshDatabase();
  sql = postgres(db.url, { onnotice: () => {} });
  const alice: [string, object, string] = [ALICE, daemon, "alice@acme.com"];
  const bob: [string, object, string] = [BOB, daemon, "bob@acme.com"];
  const agent: [string, object, string] = [CAROL, claude, "carol@acme.com"];
  await episode(0, "a.ts", "HIGH", alice, bob);
  await episode(0, "a.ts", "MEDIUM", bob, alice);
  await episode(1, "a.ts", "HIGH", alice, agent, { changed: true });
  await episode(1, "b.ts", "HIGH", agent, bob);
  await episode(3, "b.ts", "LOW", alice, bob);
  await episode(40, "old.ts", "HIGH", alice, bob);
  await episode(0, "x.ts", "HIGH", alice, bob, { repo: "github.com/acme/other" });
  s = await startServer({ databaseUrl: db.url, port: 0, auth: allowAll });
});
afterAll(async () => {
  await s.close();
  await sql.end();
  await db.close();
});

const history = async (days?: number) =>
  (
    await fetch(
      `${s.url}/api/v1/history?${new URLSearchParams({ repo: REPO, ...(days ? { days: String(days) } : {}) })}`,
    )
  ).json() as Promise<History>;

describe("collision history (PRD §10)", () => {
  it("counts episodes per day by severity, with a row for every day in the window", async () => {
    const { days } = await history(7);
    expect(days).toHaveLength(7);
    const today = new Date().toISOString().slice(0, 10);
    expect(days.at(-1)).toEqual({ day: today, HIGH: 1, MEDIUM: 1, LOW: 0 });
    expect(days.at(-2)).toMatchObject({ HIGH: 2, MEDIUM: 0, LOW: 0 });
    expect(days.at(-4)).toMatchObject({ HIGH: 0, LOW: 1 });
  });

  it("ranks the hottest files, with the worst severity each reached", async () => {
    expect((await history()).files).toEqual([
      { path: "a.ts", collisions: 3, worst: "HIGH" },
      { path: "b.ts", collisions: 2, worst: "HIGH" },
    ]);
  });

  it("ranks actor pairs, whichever side each was on", async () => {
    expect((await history()).pairs[0]).toEqual({
      a: "alice@acme.com",
      b: "bob@acme.com",
      collisions: 3,
    });
    expect((await history()).pairs).toContainEqual({
      a: "alice@acme.com",
      b: "carol@acme.com · claude-1",
      collisions: 1,
    });
  });

  it("says how often agents warned at HIGH changed course", async () => {
    expect((await history()).agents).toEqual({ warned: 2, changed_course: 1 });
  });

  it("looks back up to a year", async () => {
    expect((await history(365)).files.map((f) => f.path)).toContain("old.ts");
    expect((await fetch(`${s.url}/api/v1/history?repo=${REPO}&days=366`)).status).toBe(400);
  });
});
