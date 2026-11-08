import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";
import { FakeGitHub } from "./fake-github.ts";
import { ALICE, REPO, SHA } from "./fixtures.ts";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let gh: FakeGitHub;
const running: RunningServer[] = [];

beforeAll(async () => {
  db = await freshDatabase();
  gh = await new FakeGitHub().start();
  gh.users.set("ghu_alice", new Set(["acme/api"]));
  gh.users.set("ghu_outsider", new Set());
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});
afterAll(async () => {
  await db.close();
  await gh.stop();
});

async function server(): Promise<RunningServer> {
  const s = await startServer({
    databaseUrl: db.url,
    port: 0,
    github: {
      appId: gh.appId,
      privateKey: gh.privateKey,
      clientId: gh.clientId,
      clientSecret: gh.clientSecret,
      apiUrl: gh.url,
      webUrl: gh.url,
    },
  });
  running.push(s);
  return s;
}

const heartbeat = (s: RunningServer, token?: string) =>
  fetch(`${s.url}/api/v1/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      repo: REPO,
      working_copy_id: ALICE,
      actor: { type: "cli", id: "daemon" },
      author: "alice@acme.com",
      branch: "feature",
      base_sha: SHA,
      scope: "complete",
      files: [],
    }),
  });

const query = (s: RunningServer, path: string, token?: string) =>
  fetch(
    `${s.url}${path}?${new URLSearchParams({ repo: REPO, path: "a.ts", start: "1", end: "1", working_copy_id: ALICE, base_sha: SHA })}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} },
  );

describe("authorization against GitHub (ADR 0004)", () => {
  it.each([
    ["no token", undefined, 401],
    ["a token GitHub does not know", "ghu_forged", 401],
    ["a token without read access", "ghu_outsider", 403],
    ["a token with read access", "ghu_alice", 200],
  ])("answers a heartbeat with %s: %i", async (_name, token, status) => {
    const s = await server();
    expect((await heartbeat(s, token)).status).toBe(status);
  });

  it("guards queries and subscriptions the same way", async () => {
    const s = await server();
    expect((await query(s, "/api/v1/warnings")).status).toBe(401);
    expect((await query(s, "/api/v1/warnings", "ghu_outsider")).status).toBe(403);
    expect((await query(s, "/api/v1/warnings", "ghu_alice")).status).toBe(200);
    expect((await query(s, "/api/v1/subscribe")).status).toBe(401);
  });

  it("asks GitHub once per token and repository within five minutes", async () => {
    const s = await server();
    const before = gh.requests.filter((r) => r === "GET /repos/acme/api").length;
    for (let i = 0; i < 3; i++) expect((await heartbeat(s, "ghu_alice")).status).toBe(200);
    expect(gh.requests.filter((r) => r === "GET /repos/acme/api").length - before).toBe(1);
  });

  it("tells a CLI how to sign in, and refreshes its token with the App's secret", async () => {
    const s = await server();
    const config = await (await fetch(`${s.url}/api/v1/auth/github`)).json();
    expect(config).toEqual({ client_id: gh.clientId, web_url: gh.url });

    gh.refreshes.set("r-1", "ghu_refreshed");
    const res = await fetch(`${s.url}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "r-1" }),
    });
    expect(await res.json()).toMatchObject({ access_token: "ghu_refreshed" });
  });

  it("answers 503 when GitHub cannot say, and asks again next time", async () => {
    const s = await server();
    gh.rateLimited.add("ghu_alice");
    try {
      expect((await heartbeat(s, "ghu_alice")).status).toBe(503);
    } finally {
      gh.rateLimited.delete("ghu_alice");
    }
    expect((await heartbeat(s, "ghu_alice")).status).toBe(200);
  });

  it("refuses to start with neither a GitHub App nor an explicit authorizer", async () => {
    await expect(startServer({ databaseUrl: db.url, port: 0 })).rejects.toThrow(/auth/);
  });
});
