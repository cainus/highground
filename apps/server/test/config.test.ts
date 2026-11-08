import { describe, expect, it } from "vitest";
import { allowAll } from "../src/auth.ts";
import { configFromEnv } from "../src/config.ts";

const DB = "postgres://hg:hg@db:5432/hg";
const KEY = Buffer.alloc(32, 7).toString("base64");
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n";
const github = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: PEM,
  GITHUB_CLIENT_ID: "Iv1.abc",
  GITHUB_CLIENT_SECRET: "shh",
};
const vapid = {
  VAPID_PUBLIC_KEY: "BPub",
  VAPID_PRIVATE_KEY: "priv",
  VAPID_SUBJECT: "mailto:ops@acme.dev",
};
const noFiles = (path: string): string => {
  throw new Error(`unexpected read of ${path}`);
};

/** The message a bad environment stops the server with. */
const problem = (env: Record<string, string>, read = noFiles) => {
  try {
    configFromEnv(env, read);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the configuration to be refused");
};

describe("configFromEnv", () => {
  it("runs open only when asked, listening on every interface at 8080", () => {
    const config = configFromEnv({ DATABASE_URL: DB, HIGHGROUND_ALLOW_ALL: "1" }, noFiles);
    expect(config.server).toMatchObject({ databaseUrl: DB, host: "0.0.0.0", port: 8080 });
    expect(config.server.auth).toBe(allowAll);
    expect(config.server.github).toBeUndefined();
    expect(config.log).toEqual({ dir: "logs", stdout: false });
  });

  it("names every missing or malformed setting at once", () => {
    const message = problem({ PORT: "eighty", SESSION_KEY: "short" });
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/SESSION_KEY/);
  });

  it("refuses to start with neither a GitHub App nor an explicit choice to run open", () => {
    expect(problem({ DATABASE_URL: DB })).toMatch(/GITHUB_APP_ID.*HIGHGROUND_ALLOW_ALL/s);
  });

  it("refuses a partial GitHub App rather than quietly running without one", () => {
    const message = problem({ DATABASE_URL: DB, GITHUB_APP_ID: "123", GITHUB_CLIENT_ID: "x" });
    expect(message).toMatch(/GITHUB_APP_PRIVATE_KEY/);
    expect(message).toMatch(/GITHUB_CLIENT_SECRET/);
  });

  it("configures the App, web sign-in, Web Push and the mirror", () => {
    const config = configFromEnv(
      {
        DATABASE_URL: DB,
        ...github,
        ...vapid,
        SESSION_KEY: KEY,
        PUBLIC_URL: "https://hg.acme.dev",
        GITHUB_API_URL: "https://ghe.acme.dev/api/v3",
        GITHUB_WEB_URL: "https://ghe.acme.dev",
        MIRROR_DIR: "/data/mirror",
        WEB_DIR: "/app/web",
        LOG_DIR: "/data/logs",
        LOG_STDOUT: "1",
        PORT: "4000",
      },
      noFiles,
    );
    expect(config.server).toMatchObject({
      port: 4000,
      publicUrl: "https://hg.acme.dev",
      github: {
        appId: "123",
        privateKey: PEM,
        clientId: "Iv1.abc",
        clientSecret: "shh",
        apiUrl: "https://ghe.acme.dev/api/v3",
        webUrl: "https://ghe.acme.dev",
      },
      push: { publicKey: "BPub", privateKey: "priv", subject: "mailto:ops@acme.dev" },
      mirror: { dir: "/data/mirror" },
      webDir: "/app/web",
    });
    expect(config.server.auth).toBeUndefined();
    expect(config.server.sessionKey?.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(config.log).toEqual({ dir: "/data/logs", stdout: true });
  });

  it("reads a secret from the file a _FILE variable names, as Docker mounts secrets", () => {
    const files: Record<string, string> = { "/run/secrets/key": PEM, "/run/secrets/s": "shh\n" };
    const { GITHUB_APP_PRIVATE_KEY: _, GITHUB_CLIENT_SECRET: __, ...rest } = github;
    const config = configFromEnv(
      {
        DATABASE_URL: DB,
        ...rest,
        GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/key",
        GITHUB_CLIENT_SECRET_FILE: "/run/secrets/s",
      },
      (path) => files[path] ?? noFiles(path),
    );
    expect(config.server.github).toMatchObject({ privateKey: PEM, clientSecret: "shh" });
  });

  it("refuses a setting given both directly and as a file", () => {
    expect(
      problem({ DATABASE_URL: DB, ...github, GITHUB_CLIENT_SECRET_FILE: "/run/secrets/s" }),
    ).toMatch(/GITHUB_CLIENT_SECRET.*GITHUB_CLIENT_SECRET_FILE/);
  });

  it("accepts a private key whose newlines were escaped to fit one line", () => {
    const config = configFromEnv(
      { DATABASE_URL: DB, ...github, GITHUB_APP_PRIVATE_KEY: PEM.replaceAll("\n", "\\n") },
      noFiles,
    );
    expect(config.server.github?.privateKey).toBe(PEM);
  });

  it("refuses Web Push without web sign-in, which it needs to know whom to tell", () => {
    expect(problem({ DATABASE_URL: DB, HIGHGROUND_ALLOW_ALL: "1", ...vapid })).toMatch(
      /VAPID.*SESSION_KEY/s,
    );
  });

  it("refuses a partial VAPID key pair", () => {
    expect(
      problem({ DATABASE_URL: DB, ...github, SESSION_KEY: KEY, VAPID_PUBLIC_KEY: "BPub" }),
    ).toMatch(/VAPID_PRIVATE_KEY/);
  });

  it("treats an empty variable as unset, as compose passes one", () => {
    const config = configFromEnv(
      { DATABASE_URL: DB, HIGHGROUND_ALLOW_ALL: "1", PUBLIC_URL: "", GITHUB_APP_ID: "", PORT: "" },
      noFiles,
    );
    expect(config.server).toMatchObject({ port: 8080, auth: allowAll });
    expect(config.server.publicUrl).toBeUndefined();
  });

  it("mirrors only with a GitHub App to fetch with, whatever the image's MIRROR_DIR says", () => {
    const config = configFromEnv(
      { DATABASE_URL: DB, HIGHGROUND_ALLOW_ALL: "1", MIRROR_DIR: "/data/mirror" },
      noFiles,
    );
    expect(config.server.mirror).toBeUndefined();
  });

  it("refuses to be both open and behind a GitHub App", () => {
    expect(problem({ DATABASE_URL: DB, ...github, HIGHGROUND_ALLOW_ALL: "1" })).toMatch(
      /HIGHGROUND_ALLOW_ALL/,
    );
  });

  it("logs to stdout by default in production", () => {
    const config = configFromEnv(
      { DATABASE_URL: DB, HIGHGROUND_ALLOW_ALL: "1", NODE_ENV: "production" },
      noFiles,
    );
    expect(config.log.stdout).toBe(true);
  });
});
