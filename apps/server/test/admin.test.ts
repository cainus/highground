import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Admin } from "@highground/core";
import { createLogs } from "@highground/log";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";
import { FakeGitHub } from "./fake-github.ts";
import { ALICE, BOB } from "./fixtures.ts";
import { signIn } from "./sign-in.ts";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let sql: postgres.Sql;
let gh: FakeGitHub;
const logDir = mkdtempSync(join(tmpdir(), "highground-frontend-log-"));
const running: RunningServer[] = [];

beforeAll(async () => {
  db = await freshDatabase();
  sql = postgres(db.url, { onnotice: () => {} });
  gh = await new FakeGitHub().start();
  gh.users.set("ghu_alice", new Set(["acme/api", "acme/web"]));
  gh.profiles.set("ghu_alice", { id: 1, login: "alice", emails: [] });
  gh.uninstalled.add("acme/web");
  await sql`INSERT INTO repos (repo, last_fetch_at, last_error) VALUES
    ('github.com/acme/api', now(), NULL),
    ('github.com/acme/web', now(), 'fetch failed: 404'),
    ('github.com/acme/secret', now(), NULL)`;
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  await sql`TRUNCATE client_status`;
});
afterAll(async () => {
  await sql.end();
  await db.close();
  await gh.stop();
  rmSync(logDir, { recursive: true, force: true });
});

async function server(): Promise<RunningServer> {
  const s = await startServer({
    databaseUrl: db.url,
    port: 0,
    sessionKey: randomBytes(32),
    github: {
      appId: gh.appId,
      privateKey: gh.privateKey,
      clientId: gh.clientId,
      clientSecret: gh.clientSecret,
      apiUrl: gh.url,
      webUrl: gh.url,
    },
    log: createLogs({ dir: logDir }),
  });
  running.push(s);
  return s;
}

const post = (s: RunningServer, path: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${s.url}/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const status = (repo: string, workingCopyId: string, degraded: string | null) => ({
  repo,
  working_copy_id: workingCopyId,
  client: "mcp",
  version: "0.1.0",
  route: "git",
  degraded,
});

describe("admin (PRD §10)", () => {
  it("shows each readable repository's mirror health and GitHub App installation", async () => {
    const s = await server();
    const session = await signIn(s, gh, "ghu_alice");
    const admin = (await (
      await fetch(`${s.url}/api/v1/admin`, { headers: { cookie: session } })
    ).json()) as Admin;
    expect(admin.github).toEqual({ configured: true });
    expect(admin.repos).toMatchObject([
      { repo: "github.com/acme/api", last_error: null, installation: "ok" },
      { repo: "github.com/acme/web", last_error: "fetch failed: 404", installation: "missing" },
    ]);
    expect(admin.repos[0]!.last_fetch_at).toEqual(expect.any(String));
  });

  it("lists the clients that reported trouble in the last hour, in readable repositories", async () => {
    const s = await server();
    const auth = { authorization: "Bearer ghu_alice" };
    expect(
      (
        await post(
          s,
          "/client-status",
          status("github.com/acme/api", ALICE, "daemon unreachable: ECONNREFUSED"),
          auth,
        )
      ).status,
    ).toBe(200);
    await post(s, "/client-status", status("github.com/acme/api", BOB, null), auth);
    await sql`UPDATE client_status SET reported_at = now() - interval '2 hours' WHERE working_copy_id = ${BOB}`;
    await post(s, "/client-status", status("github.com/acme/api", BOB, "old trouble"), auth);
    await sql`UPDATE client_status SET reported_at = now() - interval '2 hours' WHERE working_copy_id = ${BOB}`;
    // A client may only report on a repository its user can read.
    expect(
      (await post(s, "/client-status", status("github.com/acme/secret", ALICE, "x"), auth)).status,
    ).toBe(403);

    const session = await signIn(s, gh, "ghu_alice");
    const { clients } = (await (
      await fetch(`${s.url}/api/v1/admin`, { headers: { cookie: session } })
    ).json()) as Admin;
    expect(clients).toMatchObject([
      {
        repo: "github.com/acme/api",
        working_copy_id: ALICE,
        client: "mcp",
        route: "git",
        degraded: "daemon unreachable: ECONNREFUSED",
      },
    ]);
  });
});

describe("frontend logs (PRD §9)", () => {
  const lines = (n: number) => ({
    lines: Array.from({ length: n }, (_, i) => ({
      time: new Date().toISOString(),
      level: "error",
      msg: `boom ${i}`,
      request_id: "r-1",
    })),
  });
  const written = () =>
    readdirSync(logDir)
      .flatMap((f) => readFileSync(join(logDir, f), "utf8").split("\n"))
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  it("writes a signed-in browser's lines as the frontend, with who sent them", async () => {
    const s = await server();
    const session = await signIn(s, gh, "ghu_alice");
    expect((await post(s, "/logs", lines(2), { cookie: session })).status).toBe(200);
    expect(written().slice(-2)).toMatchObject([
      { service: "frontend", level: "error", msg: "boom 0", request_id: "r-1", login: "alice" },
      { service: "frontend", msg: "boom 1" },
    ]);
  });

  it("refuses anonymous logs and batches over 64 KB", async () => {
    const s = await server();
    expect((await post(s, "/logs", lines(1), {})).status).toBe(401);
    const session = await signIn(s, gh, "ghu_alice");
    const huge = {
      lines: [{ time: new Date().toISOString(), level: "info", msg: "x".repeat(70_000) }],
    };
    expect((await post(s, "/logs", huge, { cookie: session })).status).toBe(413);
  });

  it("drops lines past 100 a minute per session", async () => {
    const s = await server();
    const session = await signIn(s, gh, "ghu_alice");
    const before = written().length;
    for (let i = 0; i < 3; i++) await post(s, "/logs", lines(50), { cookie: session });
    expect(written().length - before).toBe(100);
  });
});
