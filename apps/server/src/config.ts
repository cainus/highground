import { readFileSync } from "node:fs";
import { z } from "zod";
import { allowAll } from "./auth.ts";
import type { ServerOptions } from "./server.ts";

/** What `main.ts` runs: the server's options, and where its logs go. */
export interface Config {
  server: Omit<ServerOptions, "log">;
  log: { dir: string; stdout: boolean };
}

type Env = Record<string, string | undefined>;

const GITHUB = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;
const VAPID = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

const Url = z.url({ protocol: /^https?$/ });
const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/ });
const Port = z.coerce.number().int().min(0).max(65_535);

/**
 * The server's configuration from the environment (plan 06). Every problem is collected
 * and reported together, each naming its variable. A secret `X` may instead be read from
 * the file `X_FILE` names, as Docker mounts secrets; giving both is a mistake.
 */
export function configFromEnv(
  given: Env,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Config {
  const problems: string[] = [];
  // Compose passes an unset `${X:-}` as an empty string: empty means unset.
  const env: Env = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== ""));

  const value = (name: string): string | undefined => {
    const direct = env[name];
    const file = env[`${name}_FILE`];
    if (direct !== undefined && file !== undefined) {
      problems.push(`${name}: set either ${name} or ${name}_FILE, not both`);
      return undefined;
    }
    if (file !== undefined) {
      try {
        const text = read(file);
        // A one-line secret loses the newline editors add; a PEM keeps its shape.
        return /\n./.test(text) ? text : text.replace(/\r?\n$/, "");
      } catch (error) {
        problems.push(`${name}_FILE: cannot read ${file} (${(error as Error).message})`);
        return undefined;
      }
    }
    return direct;
  };
  const parsed = <T>(
    name: string,
    schema: z.ZodType<T>,
    raw: string | undefined,
  ): T | undefined => {
    if (raw === undefined) return undefined;
    const result = schema.safeParse(raw);
    if (result.success) return result.data;
    problems.push(
      `${name}: ${result.error.issues[0]?.message ?? "invalid"} (got ${JSON.stringify(raw)})`,
    );
    return undefined;
  };
  /** All of a group or none: a partial group is reported, never ignored. */
  const group = <const K extends readonly string[]>(
    names: K,
  ): Record<K[number], string> | undefined => {
    const values = names.map((name) => value(name));
    const missing = names.filter((_, i) => values[i] === undefined);
    if (missing.length === names.length) return undefined;
    if (missing.length > 0) {
      problems.push(
        `${missing.join(", ")}: needed along with ${names.filter((n) => !missing.includes(n)).join(", ")}`,
      );
      return undefined;
    }
    return Object.fromEntries(names.map((name, i) => [name, values[i]])) as Record<
      K[number],
      string
    >;
  };

  const databaseUrl = parsed("DATABASE_URL", DatabaseUrl, value("DATABASE_URL"));
  if (env.DATABASE_URL === undefined && env.DATABASE_URL_FILE === undefined) {
    problems.push("DATABASE_URL: required, e.g. postgres://user:password@host:5432/highground");
  }
  const port = parsed("PORT", Port, env.PORT) ?? 8080;
  const publicUrl = parsed("PUBLIC_URL", Url, env.PUBLIC_URL);
  const allowAllRequested = env.HIGHGROUND_ALLOW_ALL === "1";

  const app = group(GITHUB);
  const apiUrl = parsed("GITHUB_API_URL", Url, env.GITHUB_API_URL);
  const webUrl = parsed("GITHUB_WEB_URL", Url, env.GITHUB_WEB_URL);
  if (app && allowAllRequested) {
    problems.push(
      "HIGHGROUND_ALLOW_ALL: unset it to authorize through the GitHub App, or unset GITHUB_* to run open",
    );
  }
  if (
    !app &&
    !allowAllRequested &&
    !GITHUB.some((name) => problems.some((p) => p.includes(name)))
  ) {
    problems.push(
      `${GITHUB.join(", ")}: configure a GitHub App, or set HIGHGROUND_ALLOW_ALL=1 to run open to everyone`,
    );
  }

  const rawKey = value("SESSION_KEY");
  let sessionKey: Buffer | undefined;
  if (rawKey !== undefined) {
    sessionKey = Buffer.from(rawKey, "base64");
    if (sessionKey.length !== 32) {
      problems.push("SESSION_KEY: must be 32 bytes in base64, e.g. from `openssl rand -base64 32`");
      sessionKey = undefined;
    }
  }

  const keys = group(VAPID);
  if (keys && !(app && sessionKey)) {
    problems.push(
      "VAPID_*: Web Push needs web sign-in, so a GitHub App and SESSION_KEY, to know whom to tell",
    );
  }

  if (problems.length > 0) {
    throw new Error(`highground server: bad configuration\n  ${problems.join("\n  ")}`);
  }

  const stdoutDefault = env.NODE_ENV === "production";
  return {
    server: {
      databaseUrl: databaseUrl!,
      host: env.HOST || "0.0.0.0",
      port,
      ...(publicUrl ? { publicUrl } : {}),
      ...(app
        ? {
            github: {
              appId: app.GITHUB_APP_ID,
              // An env var holds one line; a key pasted with `\n` escapes is still the key.
              privateKey: app.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"),
              clientId: app.GITHUB_CLIENT_ID,
              clientSecret: app.GITHUB_CLIENT_SECRET,
              ...(apiUrl ? { apiUrl } : {}),
              ...(webUrl ? { webUrl } : {}),
            },
          }
        : { auth: allowAll }),
      ...(sessionKey ? { sessionKey } : {}),
      ...(keys
        ? {
            push: {
              publicKey: keys.VAPID_PUBLIC_KEY,
              privateKey: keys.VAPID_PRIVATE_KEY,
              subject: keys.VAPID_SUBJECT,
            },
          }
        : {}),
      // The mirror fetches with the App's installation tokens: no App, nothing to fetch with.
      ...(app && env.MIRROR_DIR ? { mirror: { dir: env.MIRROR_DIR } } : {}),
      ...(env.WEB_DIR ? { webDir: env.WEB_DIR } : {}),
    },
    log: {
      dir: env.LOG_DIR || "logs",
      stdout: env.LOG_STDOUT === undefined ? stdoutDefault : env.LOG_STDOUT === "1",
    },
  };
}
