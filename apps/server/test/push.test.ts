import { execFileSync } from "node:child_process";
import { createECDH, randomBytes, type ECDH } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Agent, createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ece from "http_ece";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateVAPIDKeys } from "web-push";
import { startServer, type RunningServer } from "../src/server.ts";
import { freshDatabase } from "./database.ts";
import { FakeGitHub } from "./fake-github.ts";
import { ALICE, BOB, file, heartbeat } from "./fixtures.ts";
import { signIn } from "./sign-in.ts";

/** A browser's push subscription: the endpoint, and the keys only the browser can decrypt with. */
interface Browser {
  endpoint: string;
  ecdh: ECDH;
  auth: Buffer;
}

/** A throwaway certificate for 127.0.0.1: push services are always HTTPS. */
function certificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "highground-push-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A push service: records what it receives, and answers 201 unless told otherwise. */
class FakePushService {
  readonly tls = certificate();
  /** Trusts this service's certificate, as the server's HTTPS client. */
  readonly agent = new Agent({ ca: this.tls.cert });
  readonly received: { endpoint: string; authorization: string; body: Buffer }[] = [];
  /** Endpoint path → the status to answer with. */
  readonly status = new Map<string, number>();
  url = "";
  #server: Server = createServer(this.tls, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    this.received.push({
      endpoint: req.url ?? "",
      authorization: req.headers.authorization ?? "",
      body: Buffer.concat(chunks),
    });
    res.writeHead(this.status.get(req.url ?? "") ?? 201).end();
  });

  async start(): Promise<this> {
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    this.url = `https://127.0.0.1:${(this.#server.address() as { port: number }).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
  browser(name: string): Browser {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return { endpoint: `${this.url}/${name}`, ecdh, auth: randomBytes(16) };
  }
  /** What one browser was sent, decrypted with its own keys. */
  messages(browser: Browser): Record<string, string>[] {
    return this.received
      .filter((r) => `${this.url}${r.endpoint}` === browser.endpoint)
      .map((r) =>
        JSON.parse(
          ece
            .decrypt(r.body, {
              version: "aes128gcm",
              privateKey: browser.ecdh,
              authSecret: browser.auth.toString("base64url"),
            })
            .toString(),
        ),
      );
  }
}

let db: Awaited<ReturnType<typeof freshDatabase>>;
let sql: postgres.Sql;
let gh: FakeGitHub;
let pushes: FakePushService;
const vapid = generateVAPIDKeys();
const running: RunningServer[] = [];

beforeAll(async () => {
  db = await freshDatabase();
  sql = postgres(db.url, { onnotice: () => {} });
  gh = await new FakeGitHub().start();
  pushes = await new FakePushService().start();
  for (const [token, id, login, readable] of [
    ["ghu_alice", 1, "alice", true],
    ["ghu_bob", 2, "bob", true],
    ["ghu_eve", 3, "eve", false],
  ] as const) {
    gh.users.set(token, new Set(readable ? ["acme/api"] : []));
    gh.profiles.set(token, { id, login, emails: [{ email: `${login}@acme.com`, verified: true }] });
  }
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
  await sql`TRUNCATE heartbeats, collision_events, sessions, push_subscriptions`;
  pushes.received.length = 0;
  pushes.status.clear();
});
afterAll(async () => {
  await sql.end();
  await db.close();
  await gh.stop();
  await pushes.stop();
});

async function server(): Promise<RunningServer> {
  const s = await startServer({
    databaseUrl: db.url,
    port: 0,
    sessionKey: randomBytes(32),
    recorderMs: 50,
    github: {
      appId: gh.appId,
      privateKey: gh.privateKey,
      clientId: gh.clientId,
      clientSecret: gh.clientSecret,
      apiUrl: gh.url,
      webUrl: gh.url,
    },
    push: {
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
      subject: "mailto:ops@acme.com",
      agent: pushes.agent,
    },
  });
  running.push(s);
  return s;
}

const subscribe = (s: RunningServer, session: string, browser: Browser) =>
  fetch(`${s.url}/api/v1/push/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: session },
    body: JSON.stringify({
      endpoint: browser.endpoint,
      keys: {
        p256dh: browser.ecdh.getPublicKey().toString("base64url"),
        auth: browser.auth.toString("base64url"),
      },
    }),
  });

async function eventually(check: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
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

/** Two live working copies, Alice's and Bob's, changing `a.ts`. */
const work = (wc: string, author: string, range: [number, number]) =>
  heartbeat(wc, [file("a.ts", range)], { author });

describe("Web Push (PRD §10)", () => {
  it("serves the VAPID public key the browser subscribes with", async () => {
    const s = await server();
    expect(await (await fetch(`${s.url}/api/v1/push/key`)).json()).toEqual({
      public_key: vapid.publicKey,
    });
  });

  it("subscribes only a signed-in browser", async () => {
    const s = await server();
    expect((await subscribe(s, "hg_session=nobody", pushes.browser("x"))).status).toBe(401);
  });

  it("notifies both owners once when their work starts colliding at HIGH", async () => {
    const s = await server();
    const alice = pushes.browser("alice");
    const bob = pushes.browser("bob");
    expect((await subscribe(s, await signIn(s, gh, "ghu_alice"), alice)).status).toBe(200);
    expect((await subscribe(s, await signIn(s, gh, "ghu_bob"), bob)).status).toBe(200);
    await eventually(() => expect(s.recorder.leading).toBe(true));

    s.hub.heartbeat(work(ALICE, "alice@acme.com", [10, 12]));
    s.hub.heartbeat(work(BOB, "bob@acme.com", [11, 11]));
    await eventually(() => {
      expect(pushes.messages(alice)).toHaveLength(1);
      expect(pushes.messages(bob)).toHaveLength(1);
    });
    expect(pushes.messages(alice)[0]).toMatchObject({
      title: "HIGH: a.ts",
      url: "/radar/github.com/acme/api?path=a.ts",
    });
    expect(pushes.messages(alice)[0]!.body).toContain("bob@acme.com");
    expect(pushes.received[0]!.authorization).toMatch(/^vapid t=/);

    // The same collision moving is not news.
    s.hub.heartbeat(work(BOB, "bob@acme.com", [12, 12]));
    await new Promise((r) => setTimeout(r, 300));
    expect(pushes.received).toHaveLength(2);
  });

  it("does not notify about a MEDIUM collision", async () => {
    const s = await server();
    const alice = pushes.browser("alice");
    await subscribe(s, await signIn(s, gh, "ghu_alice"), alice);
    await eventually(() => expect(s.recorder.leading).toBe(true));
    s.hub.heartbeat(work(ALICE, "alice@acme.com", [10, 10]));
    s.hub.heartbeat(work(BOB, "bob@acme.com", [14, 14]));
    await eventually(async () => expect(await sql`SELECT 1 FROM collision_events`).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(pushes.received).toEqual([]);
  });

  it("tells no one who can no longer read the repository", async () => {
    const s = await server();
    const eve = pushes.browser("eve");
    await subscribe(s, await signIn(s, gh, "ghu_eve"), eve);
    await eventually(() => expect(s.recorder.leading).toBe(true));
    s.hub.heartbeat(work(ALICE, "eve@acme.com", [10, 12]));
    s.hub.heartbeat(work(BOB, "bob@acme.com", [11, 11]));
    await eventually(async () =>
      expect(await sql`SELECT 1 FROM collision_events WHERE notified_at IS NOT NULL`).toHaveLength(
        1,
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(pushes.messages(eve)).toEqual([]);
  });

  it("forgets a subscription the push service says is gone", async () => {
    const s = await server();
    const alice = pushes.browser("alice");
    pushes.status.set("/alice", 410);
    await subscribe(s, await signIn(s, gh, "ghu_alice"), alice);
    await eventually(() => expect(s.recorder.leading).toBe(true));
    s.hub.heartbeat(work(ALICE, "alice@acme.com", [10, 12]));
    s.hub.heartbeat(work(BOB, "bob@acme.com", [11, 11]));
    await eventually(async () =>
      expect(await sql`SELECT 1 FROM push_subscriptions`).toHaveLength(0),
    );
  });
});
