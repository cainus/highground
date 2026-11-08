import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLog } from "@highground/log";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../server/src/server.ts";
import { freshDatabase } from "../../server/test/database.ts";
import { FakeGitHub } from "../../server/test/fake-github.ts";
import { Credentials, credentialsFile, login } from "../src/credentials.ts";
import { Daemon } from "../src/daemon.ts";
import { serverClient } from "../src/server-client.ts";
import { cleanupRepos, eventually, lines, makeWorkingCopy, write } from "./helpers.ts";

let gh: FakeGitHub;
let db: Awaited<ReturnType<typeof freshDatabase>>;
let hg: RunningServer;
const scratch = mkdtempSync(join(tmpdir(), "highground-auth-"));
let dirs = 0;
const freshDir = () => join(scratch, `config-${++dirs}`);

beforeAll(async () => {
  gh = await new FakeGitHub().start();
  db = await freshDatabase();
  hg = await startServer({
    databaseUrl: db.url,
    port: 0,
    graceMs: 200,
    sweepMs: 100,
    github: {
      appId: gh.appId,
      privateKey: gh.privateKey,
      clientId: gh.clientId,
      clientSecret: gh.clientSecret,
      apiUrl: gh.url,
      webUrl: gh.url,
    },
  });
});
afterAll(async () => {
  await hg.close();
  await db.close();
  await gh.stop();
  cleanupRepos();
  rmSync(scratch, { recursive: true, force: true });
});

/** Credentials for `hg` that expire `inMs` from now. */
function storeCredentials(dir: string, token: string, refresh: string, inMs: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    credentialsFile(dir),
    JSON.stringify({
      [hg.url]: {
        access_token: token,
        refresh_token: refresh,
        expires_at: new Date(Date.now() + inMs).toISOString(),
      },
    }),
    { mode: 0o600 },
  );
}

describe("highground login (device flow)", () => {
  it("signs in through the server's GitHub App and keeps the tokens private to the user", async () => {
    gh.autoApprove = "ghu_login";
    const dir = freshDir();
    const said: string[] = [];
    try {
      await login({ server: hg.url, dir, print: (line) => said.push(line) });
    } finally {
      gh.autoApprove = undefined;
    }
    expect(said.join("\n")).toContain("ABCD-1234");
    expect(said.join("\n")).toContain(`${gh.url}/login/device`);
    expect(statSync(credentialsFile(dir)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(credentialsFile(dir), "utf8"));
    expect(stored[hg.url]).toMatchObject({
      access_token: "ghu_login",
      refresh_token: "r-ghu_login",
    });
    expect(await new Credentials({ dir, server: hg.url, env: {} }).token()).toBe("ghu_login");
  });

  it("stops when the user denies the request", async () => {
    gh.deviceError = "access_denied";
    try {
      await expect(login({ server: hg.url, dir: freshDir(), print: () => {} })).rejects.toThrow(
        /denied/,
      );
    } finally {
      gh.deviceError = undefined;
    }
  });
});

describe("Credentials", () => {
  it("refreshes an expiring token once, however many processes ask at the same time", async () => {
    const dir = freshDir();
    storeCredentials(dir, "ghu_stale", "r-1", 30_000);
    gh.refreshes.set("r-1", "ghu_fresh");
    // A daemon and two MCP servers: separate processes sharing one credentials file.
    const tokens = await Promise.all(
      [1, 2, 3].map(() => new Credentials({ dir, server: hg.url, env: {} }).token()),
    );
    expect(tokens).toEqual(["ghu_fresh", "ghu_fresh", "ghu_fresh"]);
    const stored = JSON.parse(readFileSync(credentialsFile(dir), "utf8"));
    expect(stored[hg.url].refresh_token).toBe("r-ghu_fresh");
    expect(statSync(credentialsFile(dir)).mode & 0o777).toBe(0o600);
  });

  it("uses HIGHGROUND_TOKEN over any stored sign-in, for containers", async () => {
    const dir = freshDir();
    storeCredentials(dir, "ghu_stored", "r-x", 3_600_000);
    const env = { HIGHGROUND_TOKEN: "ghu_env" };
    expect(await new Credentials({ dir, server: hg.url, env }).token()).toBe("ghu_env");
  });

  it("has no token for a server it never signed in to", async () => {
    expect(await new Credentials({ dir: freshDir(), server: hg.url, env: {} }).token()).toBe(
      undefined,
    );
  });
});

describe("authenticated reporting", () => {
  it("sends the signed-in user's token, so the server accepts the daemon's work", async () => {
    const wc = makeWorkingCopy({ "a.ts": lines(10) });
    const owner = wc.repo.split("/").slice(1).join("/");
    gh.users.set("ghu_daemon", new Set([owner]));
    const dir = freshDir();
    storeCredentials(dir, "ghu_daemon", "r-d", 3_600_000);

    const anonymous = serverClient(hg.url);
    const query = {
      repo: wc.repo,
      path: "a.ts",
      start: 2,
      end: 2,
      working_copy_id: crypto.randomUUID(),
      base_sha: wc.base,
    };
    await expect(anonymous.warnings(query)).rejects.toMatchObject({ status: 401 });

    const daemon = new Daemon({
      server: hg.url,
      dirs: [wc.dir],
      configDir: dir,
      env: {},
      log: createLog({ service: "daemon", dir: join(scratch, "logs") }),
      reporter: { debounceMs: 50 },
    });
    write(wc.dir, { "a.ts": lines(10).replace("line2\n", "changed\n") });
    await daemon.start();
    try {
      const signedIn = serverClient(hg.url, new Credentials({ dir, server: hg.url, env: {} }));
      await eventually(async () => {
        const { warnings } = await signedIn.warnings(query);
        expect(warnings).toHaveLength(1);
      });
    } finally {
      await daemon.stop();
    }
  });
});
