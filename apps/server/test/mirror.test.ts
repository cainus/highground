import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowAll } from "../src/auth.ts";
import { startServer, type RunningServer } from "../src/server.ts";
import { commitAll, lines, makeRepo, run, write } from "../../../packages/git/test/helpers.ts";
import { freshDatabase } from "./database.ts";
import { FakeGitHub } from "./fake-github.ts";
import { ALICE, BOB } from "./fixtures.ts";

const REPO = "github.com/acme/api";
let db: Awaited<ReturnType<typeof freshDatabase>>;
let gh: FakeGitHub;
const scratch = mkdtempSync(join(tmpdir(), "highground-mirror-test-"));
const running: RunningServer[] = [];

beforeAll(async () => {
  db = await freshDatabase();
  gh = await new FakeGitHub().start();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  const sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql`TRUNCATE heartbeats, repos`;
  await sql.end();
});
afterAll(async () => {
  await db.close();
  await gh.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/** A server mirroring `origin` as `github.com/acme/api`, with the fake GitHub for PRs. */
async function server(origin: string, name = "a"): Promise<RunningServer> {
  const s = await startServer({
    databaseUrl: db.url,
    port: 0,
    graceMs: 200,
    sweepMs: 100,
    auth: allowAll,
    github: {
      appId: gh.appId,
      privateKey: gh.privateKey,
      clientId: gh.clientId,
      clientSecret: gh.clientSecret,
      apiUrl: gh.url,
      webUrl: gh.url,
    },
    mirror: {
      dir: join(scratch, `${name}-${running.length}-${Date.now()}`),
      fetchMs: 3_600_000,
      remote: { url: () => origin, config: async () => ({}) },
    },
  });
  running.push(s);
  return s;
}

/** An origin with main (a.txt, 30 lines) and whatever branches the test adds. */
function origin(): { dir: string; main: string } {
  const dir = makeRepo({ "a.txt": lines(30) });
  return { dir, main: run(dir, "rev-parse", "HEAD") };
}

function branch(dir: string, name: string, files: Record<string, string>, from = "main"): string {
  run(dir, "checkout", "-q", "-b", name, from);
  write(dir, files);
  const head = commitAll(dir, `${name} work`);
  run(dir, "checkout", "-q", "main");
  return head;
}

async function warnings(s: RunningServer, base: string, start: number, end: number, extra = {}) {
  const params = new URLSearchParams({
    repo: REPO,
    path: "a.txt",
    start: String(start),
    end: String(end),
    working_copy_id: ALICE,
    base_sha: base,
    ...extra,
  });
  const res = await fetch(`${s.url}/api/v1/warnings?${params}`);
  return ((await res.json()) as { warnings: Record<string, any>[] }).warnings;
}

async function heartbeat(s: RunningServer, id: string, base: string, range: [number, number]) {
  const res = await fetch(`${s.url}/api/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: REPO,
      working_copy_id: id,
      actor: { type: "cli", id: "daemon" },
      author: "dev@acme.com",
      branch: `live-${id.slice(0, 4)}`,
      base_sha: base,
      scope: "complete",
      files: [{ path: "a.txt", changes: [{ range, digest: null }] }],
    }),
  });
  return (await res.json()) as { warnings: Record<string, any>[] };
}

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

describe("pushed work", () => {
  it("warns live work about an unmerged pushed branch, with its head, author and PR", async () => {
    const o = origin();
    const head = branch(o.dir, "feature/b1", { "a.txt": lines(30).replace("line5\n", "five\n") });
    gh.pulls.set("acme/api", [{ head: "feature/b1", number: 9 }]);
    const s = await server(o.dir);
    s.mirror!.track(REPO);
    await s.mirror!.round();

    expect(await warnings(s, o.main, 5, 5)).toMatchObject([
      {
        type: "DIRECT_OVERLAP",
        approximate: false,
        peer: {
          kind: "pushed",
          branch: "feature/b1",
          head_sha: head,
          author: "test@example.com",
          pr_url: "https://github.com/acme/api/pull/9",
          lines: [5, 5],
        },
      },
    ]);
  });

  it("starts mirroring a repository the first time a heartbeat names it", async () => {
    const o = origin();
    branch(o.dir, "b1", { "a.txt": lines(30).replace("line5\n", "five\n") });
    const s = await server(o.dir);
    await heartbeat(s, BOB, o.main, [20, 20]);
    await eventually(async () => expect(await warnings(s, o.main, 5, 5)).toHaveLength(1));
  });

  it("stops warning when a branch is deleted or merged", async () => {
    const o = origin();
    branch(o.dir, "gone", { "a.txt": lines(30).replace("line5\n", "five\n") });
    const merged = branch(o.dir, "merged", { "a.txt": lines(30).replace("line9\n", "nine\n") });
    const s = await server(o.dir);
    s.mirror!.track(REPO);
    await s.mirror!.round();
    expect(await warnings(s, o.main, 5, 9)).toHaveLength(2);

    run(o.dir, "branch", "-D", "gone");
    run(o.dir, "merge", "-q", "--ff-only", merged);
    await s.mirror!.round();
    expect(await warnings(s, o.main, 5, 9)).toEqual([]);
  });

  it("never warns live work about the pushed copy of its own branch", async () => {
    const o = origin();
    branch(o.dir, "mine", { "a.txt": lines(30).replace("line5\n", "five\n") });
    const s = await server(o.dir);
    s.mirror!.track(REPO);
    await s.mirror!.round();
    expect(await warnings(s, o.main, 5, 5, { branch: "mine" })).toEqual([]);
  });

  it("is published by one instance and seen by all", async () => {
    const o = origin();
    branch(o.dir, "b1", { "a.txt": lines(30).replace("line5\n", "five\n") });
    const one = await server(o.dir, "one");
    const two = await server(o.dir, "two");
    for (const s of [one, two]) s.mirror!.track(REPO);
    await Promise.all([one.mirror!.round(), two.mirror!.round()]);

    for (const s of [one, two]) {
      await eventually(async () => expect(await warnings(s, o.main, 5, 5)).toHaveLength(1));
    }
    const sql = postgres(db.url, { max: 1, onnotice: () => {} });
    const origins =
      await sql`SELECT DISTINCT origin FROM heartbeats WHERE body->>'kind' = 'pushed'`;
    await sql.end();
    expect(origins).toHaveLength(1);
  });
});

describe("speculative merges", () => {
  it("confirms a conflict between two pushed branches", async () => {
    const o = origin();
    branch(o.dir, "b1", { "a.txt": lines(30).replace("line5\n", "five\n") });
    branch(o.dir, "b2", { "a.txt": lines(30).replace("line5\n", "FIVE\n") });
    const s = await server(o.dir);
    s.mirror!.track(REPO);
    await s.mirror!.round();

    await eventually(async () => {
      const collisions = s.hub.index.collisionsAt(REPO, "a.txt", Date.now());
      const all = [...collisions.values()].flatMap((m) => [...m.values()]);
      expect(all).toHaveLength(2);
      expect(all.every((w) => w.confirmed === true && w.severity === "HIGH")).toBe(true);
    });
  });

  it("refutes a duplicate change that merges cleanly", async () => {
    const o = origin();
    branch(o.dir, "b1", { "a.txt": lines(30).replace("line5\n", "five\n") });
    branch(o.dir, "b2", { "a.txt": lines(30).replace("line5\n", "five\n"), "b.txt": "x\n" });
    const s = await server(o.dir);
    s.mirror!.track(REPO);
    await s.mirror!.round();

    await eventually(async () => {
      const collisions = s.hub.index.collisionsAt(REPO, "a.txt", Date.now());
      const all = [...collisions.values()].flatMap((m) => [...m.values()]);
      expect(all.map((w) => [w.type, w.confirmed])).toEqual([
        ["DUPLICATE_CHANGE", false],
        ["DUPLICATE_CHANGE", false],
      ]);
    });
  });
});

describe("translation between bases", () => {
  it("translates a peer on an older base exactly once the mirror has both commits", async () => {
    const o = origin();
    const old = o.main;
    write(o.dir, { "a.txt": `top1\ntop2\ntop3\ntop4\ntop5\n${lines(30)}` });
    const moved = commitAll(o.dir, "main grows at the top");
    const s = await server(o.dir);
    s.mirror!.track(REPO);
    await s.mirror!.round();

    // Bob works on the old base at lines 20–22; on the new base those are 25–27.
    await heartbeat(s, BOB, old, [20, 22]);
    const exact = await eventually(async () => {
      const [w] = await warnings(s, moved, 25, 25);
      expect(w).toMatchObject({ approximate: false, peer: { lines: [25, 27] } });
      return w;
    });
    expect(exact!.your_lines).toEqual([25, 25]);
    // Line 20 on the new base is old line 15: clear of Bob, by exact translation.
    expect((await warnings(s, moved, 20, 20)).filter((w) => w.type === "DIRECT_OVERLAP")).toEqual(
      [],
    );
  });

  it("shows the radar in the default branch's head, translating older work into it", async () => {
    const o = origin();
    const old = o.main;
    write(o.dir, { "a.txt": `top1\ntop2\ntop3\ntop4\ntop5\n${lines(30)}` });
    const moved = commitAll(o.dir, "main grows at the top");
    const s = await server(o.dir);
    s.mirror!.track(REPO);
    await s.mirror!.round();

    await heartbeat(s, BOB, old, [20, 22]);
    await eventually(async () => {
      const [file] = s.hub.radar(REPO).files;
      expect(file).toMatchObject({
        base_sha: moved,
        work: [{ base_sha: old, lines: [[25, 27]], approximate: false }],
      });
    });
  });

  it("fetches when a heartbeat names a base the mirror has not seen yet", async () => {
    const o = origin();
    const s = await server(o.dir);
    s.mirror!.track(REPO);
    await s.mirror!.round();
    write(o.dir, { "a.txt": `top\n${lines(30)}` });
    const moved = commitAll(o.dir, "main moves after the last fetch");

    await heartbeat(s, BOB, o.main, [20, 22]);
    await eventually(async () => {
      expect(await warnings(s, moved, 21, 21)).toMatchObject([
        { approximate: false, peer: { lines: [21, 23] } },
      ]);
    });
  });
});
