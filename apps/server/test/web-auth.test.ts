import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";
import { FakeGitHub } from "./fake-github.ts";
import { ALICE, REPO, SHA } from "./fixtures.ts";
import { cookies, signIn as signInAs } from "./sign-in.ts";

let db: Awaited<ReturnType<typeof freshDatabase>>;
let sql: postgres.Sql;
let gh: FakeGitHub;
const running: RunningServer[] = [];

beforeAll(async () => {
  db = await freshDatabase();
  sql = postgres(db.url, { onnotice: () => {} });
  gh = await new FakeGitHub().start();
  gh.users.set("ghu_web", new Set(["acme/api"]));
  gh.profiles.set("ghu_web", {
    id: 77,
    login: "alice",
    emails: [
      { email: "alice@acme.com", verified: true },
      { email: "alice@unverified.example", verified: false },
    ],
  });
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  gh.webUser = undefined;
  await sql`DELETE FROM sessions`;
});
afterAll(async () => {
  await sql.end();
  await db.close();
  await gh.stop();
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
  });
  running.push(s);
  return s;
}

const signIn = (s: RunningServer) => signInAs(s, gh, "ghu_web");

const rpc = (s: RunningServer, path: string, cookie?: string, body?: unknown) =>
  fetch(`${s.url}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const heartbeat = {
  repo: REPO,
  working_copy_id: ALICE,
  actor: { type: "cli", id: "daemon" },
  author: "alice@acme.com",
  branch: "feature",
  base_sha: SHA,
  scope: "complete",
  files: [],
};

describe("signing in on the web (plan 05)", () => {
  it("sends the browser to GitHub with PKCE and a state it can check", async () => {
    const s = await server();
    const res = await fetch(`${s.url}/auth/login`, { redirect: "manual" });
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(`${gh.url}/login/oauth/authorize`);
    expect(to.searchParams.get("client_id")).toBe(gh.clientId);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("redirect_uri")).toBe(`${s.url}/auth/callback`);
    expect(to.searchParams.get("state")).toMatch(/^[\w-]{20,}$/);
    expect(cookies(res).get("hg_oauth")!.header).toMatch(/HttpOnly/i);
  });

  it("signs in, and the session knows who the user is", async () => {
    const s = await server();
    const session = await signIn(s);
    const me = await (await rpc(s, "/me", session)).json();
    expect(me).toEqual({
      login: "alice",
      avatar_url: `${gh.url}/a/77`,
      emails: ["alice@acme.com"],
    });
  });

  it("sets a session cookie scripts cannot read and other sites cannot send", async () => {
    const s = await server();
    gh.webUser = "ghu_web";
    const start = await fetch(`${s.url}/auth/login`, { redirect: "manual" });
    const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const callback = await fetch(authorize.headers.get("location")!, {
      redirect: "manual",
      headers: { cookie: cookies(start).get("hg_oauth")!.pair },
    });
    const header = cookies(callback).get("hg_session")!.header;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//i);
  });

  it("keeps neither the cookie nor GitHub's tokens readable in the database", async () => {
    const s = await server();
    const session = await signIn(s);
    const value = session.split("=")[1]!;
    const rows = await sql`SELECT * FROM sessions`;
    expect(rows).toHaveLength(1);
    // Every column's raw bytes, so a token stored in the clear inside bytea is found too.
    const raw = Buffer.concat(
      Object.values(rows[0]!).map((v) =>
        Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v) ?? ""),
      ),
    );
    expect(raw.includes(value)).toBe(false);
    expect(raw.includes("ghu_web")).toBe(false);
    expect(raw.includes("r-ghu_web")).toBe(false);
  });

  it("refuses a callback whose state does not match the browser's", async () => {
    const s = await server();
    gh.webUser = "ghu_web";
    const start = await fetch(`${s.url}/auth/login`, { redirect: "manual" });
    const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const back = new URL(authorize.headers.get("location")!);
    back.searchParams.set("state", "forged");
    const callback = await fetch(back, {
      redirect: "manual",
      headers: { cookie: cookies(start).get("hg_oauth")!.pair },
    });
    expect(callback.status).toBe(400);
    expect(cookies(callback).has("hg_session")).toBe(false);
  });

  it("authorizes a session exactly as it would the user's own token", async () => {
    const s = await server();
    const session = await signIn(s);
    expect((await rpc(s, "/heartbeat", session, heartbeat)).status).toBe(200);
    const elsewhere = { ...heartbeat, repo: "github.com/acme/secret" };
    expect((await rpc(s, "/heartbeat", session, elsewhere)).status).toBe(403);
    expect((await rpc(s, "/me", "hg_session=not-a-session")).status).toBe(401);
  });

  it("lists the tracked repositories the user can read", async () => {
    const s = await server();
    await sql`INSERT INTO repos (repo) VALUES ('github.com/acme/api'), ('github.com/acme/secret')
              ON CONFLICT DO NOTHING`;
    const session = await signIn(s);
    expect(await (await rpc(s, "/repos", session)).json()).toEqual({
      repos: ["github.com/acme/api"],
    });
  });

  it("refreshes GitHub's token behind the session before it expires", async () => {
    const s = await server();
    const session = await signIn(s);
    await sql`UPDATE sessions SET token_expires_at = now() + interval '1 minute'`;
    gh.refreshes.set("r-ghu_web", "ghu_web2");
    gh.users.set("ghu_web2", new Set(["acme/api"]));
    gh.profiles.set("ghu_web2", gh.profiles.get("ghu_web")!);
    expect((await rpc(s, "/heartbeat", session, heartbeat)).status).toBe(200);
    const [row] = await sql<{ expires: Date }[]>`SELECT token_expires_at AS expires FROM sessions`;
    expect(row!.expires.getTime()).toBeGreaterThan(Date.now() + 3_600_000);
  });

  it("signs out: the session is gone and its cookie is cleared", async () => {
    const s = await server();
    const session = await signIn(s);
    const out = await fetch(`${s.url}/auth/logout`, {
      method: "POST",
      headers: { cookie: session },
    });
    expect(out.status).toBe(204);
    expect(cookies(out).get("hg_session")!.header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect((await rpc(s, "/me", session)).status).toBe(401);
  });
});
