import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { serverClient } from "./server-client.ts";

/** One sign-in per server, since each instance has its own GitHub App. */
const StoredSchema = z.record(
  z.string(),
  z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    /** When the access token expires; absent when it does not. */
    expires_at: z.iso.datetime({ offset: true }).optional(),
  }),
);
type Stored = z.infer<typeof StoredSchema>;

export const credentialsFile = (dir: string) => join(dir, "credentials.json");

/** Refresh this long before the access token expires, so no request carries a dying one. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** A lock older than this was left by a process that died while refreshing. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

const keyOf = (server: string) => server.replace(/\/+$/, "");

async function readStored(dir: string): Promise<Stored> {
  const text = await readFile(credentialsFile(dir), "utf8").catch(() => "{}");
  return StoredSchema.parse(JSON.parse(text));
}

/** Writes the file whole, readable only by the user, so no reader sees half of it. */
async function writeStored(dir: string, stored: Stored): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${credentialsFile(dir)}.${randomUUID()}`;
  await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, credentialsFile(dir));
}

/**
 * Runs `fn` holding the credentials file's lock. GitHub's refresh tokens work once, so a
 * daemon and MCP servers refreshing together would otherwise spend the same token and
 * sign the user out.
 */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = `${credentialsFile(dir)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > STALE_LOCK_MS) await rm(lock, { force: true });
      else if (Date.now() > deadline) throw new Error(`credentials are locked: ${lock}`);
      else await sleep(25 + Math.random() * 50);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

const expiresAt = (now: number, seconds: number | undefined) =>
  seconds === undefined ? undefined : new Date(now + seconds * 1000).toISOString();

export interface CredentialsOptions {
  /** The config directory holding `credentials.json`. */
  dir: string;
  server: string;
  env: NodeJS.ProcessEnv;
}

/**
 * The user's GitHub token for one server: `HIGHGROUND_TOKEN` when set (containers),
 * else the stored sign-in, refreshed through the server shortly before it expires.
 */
export class Credentials {
  readonly #options: CredentialsOptions;
  #refreshing: Promise<string | undefined> | undefined;

  constructor(options: CredentialsOptions) {
    this.#options = options;
  }

  /** The token to send, or undefined when the user has not signed in to this server. */
  async token(): Promise<string | undefined> {
    const { env, dir, server } = this.#options;
    if (env.HIGHGROUND_TOKEN) return env.HIGHGROUND_TOKEN;
    const entry = (await readStored(dir))[keyOf(server)];
    if (!entry || this.#fresh(entry)) return entry?.access_token;
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  #fresh(entry: Stored[string]): boolean {
    return (
      !entry.refresh_token ||
      !entry.expires_at ||
      Date.parse(entry.expires_at) - REFRESH_MARGIN_MS > Date.now()
    );
  }

  async #refresh(): Promise<string | undefined> {
    const { dir, server } = this.#options;
    return withLock(dir, async () => {
      // Another process may have refreshed while this one waited for the lock.
      const stored = await readStored(dir);
      const entry = stored[keyOf(server)];
      if (!entry || this.#fresh(entry)) return entry?.access_token;
      const tokens = await serverClient(server).refresh({ refresh_token: entry.refresh_token! });
      stored[keyOf(server)] = {
        access_token: tokens.access_token,
        ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
        ...(tokens.expires_in ? { expires_at: expiresAt(Date.now(), tokens.expires_in) } : {}),
      };
      await writeStored(dir, stored);
      return tokens.access_token;
    });
  }
}

export interface LoginOptions {
  server: string;
  /** The config directory to store the sign-in in. */
  dir: string;
  /** Where to tell the user what to do. */
  print: (line: string) => void;
}

const DeviceCodeSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.url(),
  expires_in: z.number(),
  interval: z.number(),
});

const PollSchema = z.union([
  z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
  }),
  z.object({ error: z.string(), interval: z.number().optional() }),
]);

async function postForm(url: string, form: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Signs in to a server with GitHub's device flow, through the server's own GitHub App,
 * and stores the tokens (0600). The client secret stays on the server; only refreshes
 * need it.
 */
export async function login({ server, dir, print }: LoginOptions): Promise<void> {
  const { client_id, web_url } = await serverClient(server).authConfig();
  const device = DeviceCodeSchema.parse(
    await postForm(`${web_url}/login/device/code`, { client_id }),
  );
  print(`Open ${device.verification_uri} and enter the code ${device.user_code}`);

  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = device.interval * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the code expired before it was entered; try again");
    await sleep(intervalMs);
    const answer = PollSchema.parse(
      await postForm(`${web_url}/login/oauth/access_token`, {
        client_id,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    );
    if ("access_token" in answer) {
      await withLock(dir, async () => {
        const stored = await readStored(dir);
        stored[keyOf(server)] = {
          access_token: answer.access_token,
          ...(answer.refresh_token ? { refresh_token: answer.refresh_token } : {}),
          ...(answer.expires_in ? { expires_at: expiresAt(Date.now(), answer.expires_in) } : {}),
        };
        await writeStored(dir, stored);
      });
      print(`Signed in to ${server}`);
      return;
    }
    switch (answer.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        // GitHub names the new interval; RFC 8628 says add five seconds.
        intervalMs = (answer.interval ?? intervalMs / 1000 + 5) * 1000;
        continue;
      case "expired_token":
        throw new Error("the code expired before it was entered; try again");
      case "access_denied":
        throw new Error("sign-in was denied on GitHub");
      default:
        throw new Error(`GitHub device flow: ${answer.error}`);
    }
  }
}
