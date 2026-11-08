import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or, sql as raw } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { sessions } from "./db/schema.ts";
import type { GitHubApp, GitHubUser, UserTokens } from "./github.ts";

/** A signed-in dashboard user, with a GitHub token that is current. */
export interface Session {
  githubId: number;
  login: string;
  avatarUrl: string;
  emails: string[];
  token: string;
}

/** Refresh GitHub's token this long before it expires; requests meanwhile use the old one. */
const REFRESH_AHEAD_MS = 60 * 60_000;
/** How long one request may hold the refresh before another may try. */
const REFRESH_CLAIM_MS = 30_000;
/** Sessions unused this long are deleted, whatever their tokens say. */
const IDLE_MS = 30 * 24 * 60 * 60_000;
/** `last_seen_at` is written at most this often per session. */
const SEEN_EVERY_MS = 5 * 60_000;

const hashOf = (value: string) => createHash("sha256").update(value).digest("base64url");
const inSeconds = (now: number, seconds: number | undefined) =>
  seconds === undefined ? null : new Date(now + seconds * 1000);

export interface SessionsOptions {
  sql: postgres.Sql;
  /** 32 bytes: the AES-256-GCM key for GitHub's tokens at rest. */
  key: Buffer;
  github: GitHubApp;
  now?: () => number;
}

/**
 * Dashboard sessions in Postgres, so any instance can serve any browser. Only the
 * cookie's hash is stored, and GitHub's tokens are encrypted under the instance's key
 * with the hash as associated data, so a row copied to another session cannot be read.
 */
export class Sessions {
  readonly #db;
  readonly #options: SessionsOptions;
  readonly #now: () => number;

  constructor(options: SessionsOptions) {
    if (options.key.length !== 32) throw new Error("the session key must be 32 bytes");
    this.#options = options;
    this.#db = drizzle(options.sql);
    this.#now = options.now ?? Date.now;
  }

  /** Stores a new session; returns the cookie value, which exists nowhere else. */
  async create(tokens: UserTokens, user: GitHubUser, emails: string[]): Promise<string> {
    const value = randomBytes(32).toString("base64url");
    const idHash = hashOf(value);
    const now = this.#now();
    await this.#db.insert(sessions).values({
      idHash,
      githubId: user.id,
      login: user.login,
      avatarUrl: user.avatar_url,
      emails,
      token: this.#seal(tokens.access_token, idHash),
      refreshToken: tokens.refresh_token ? this.#seal(tokens.refresh_token, idHash) : null,
      tokenExpiresAt: inSeconds(now, tokens.expires_in),
      refreshExpiresAt: inSeconds(now, tokens.refresh_token_expires_in),
    });
    return value;
  }

  /** The session behind a cookie value, refreshing its token when due; undefined if none. */
  async resolve(value: string): Promise<Session | undefined> {
    const idHash = hashOf(value);
    const [row] = await this.#db.select().from(sessions).where(eq(sessions.idHash, idHash));
    if (!row) return undefined;
    const now = this.#now();
    if (row.lastSeenAt.getTime() < now - IDLE_MS) {
      await this.#db.delete(sessions).where(eq(sessions.idHash, idHash));
      return undefined;
    }
    let token = this.#open(row.token, idHash);
    const due = row.tokenExpiresAt && row.tokenExpiresAt.getTime() - REFRESH_AHEAD_MS < now;
    if (due && row.refreshToken) {
      token = (await this.#refresh(idHash, this.#open(row.refreshToken, idHash))) ?? token;
    }
    if (row.lastSeenAt.getTime() < now - SEEN_EVERY_MS) {
      void this.#db
        .update(sessions)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(sessions.idHash, idHash))
        .catch(() => {});
    }
    return {
      githubId: row.githubId,
      login: row.login,
      avatarUrl: row.avatarUrl,
      emails: row.emails,
      token,
    };
  }

  /**
   * Every session of a user with this verified email, with its current token as stored:
   * whom to tell about that author's work, and whose access to check first.
   */
  async withEmail(email: string): Promise<{ githubId: number; token: string }[]> {
    const rows = await this.#db
      .select({ idHash: sessions.idHash, githubId: sessions.githubId, token: sessions.token })
      .from(sessions)
      .where(raw`${sessions.emails} ? ${email}`);
    return rows.map((row) => ({
      githubId: row.githubId,
      token: this.#open(row.token, row.idHash),
    }));
  }

  async delete(value: string): Promise<void> {
    await this.#db.delete(sessions).where(eq(sessions.idHash, hashOf(value)));
  }

  /** Deletes sessions that can no longer work: idle, or past their refresh token's life. */
  async prune(): Promise<void> {
    const now = new Date(this.#now());
    await this.#db
      .delete(sessions)
      .where(
        or(
          lt(sessions.lastSeenAt, new Date(now.getTime() - IDLE_MS)),
          lt(sessions.refreshExpiresAt, now),
        ),
      );
  }

  /**
   * Refreshes one session's token, if no other request is already doing so. GitHub's
   * refresh tokens work once, so a claim (a conditional update, never a lock anyone
   * waits on) picks one request; the others carry on with the still-valid old token.
   */
  async #refresh(idHash: string, refreshToken: string): Promise<string | undefined> {
    const now = new Date(this.#now());
    const claimed = await this.#db
      .update(sessions)
      .set({ refreshingUntil: new Date(now.getTime() + REFRESH_CLAIM_MS) })
      .where(
        and(
          eq(sessions.idHash, idHash),
          or(isNull(sessions.refreshingUntil), lt(sessions.refreshingUntil, now)),
        ),
      )
      .returning({ idHash: sessions.idHash });
    if (claimed.length === 0) return undefined;
    try {
      const tokens = await this.#options.github.refresh(refreshToken);
      const at = this.#now();
      await this.#db
        .update(sessions)
        .set({
          token: this.#seal(tokens.access_token, idHash),
          ...(tokens.refresh_token
            ? { refreshToken: this.#seal(tokens.refresh_token, idHash) }
            : {}),
          tokenExpiresAt: inSeconds(at, tokens.expires_in),
          ...(tokens.refresh_token_expires_in
            ? { refreshExpiresAt: inSeconds(at, tokens.refresh_token_expires_in) }
            : {}),
          refreshingUntil: null,
        })
        .where(eq(sessions.idHash, idHash));
      return tokens.access_token;
    } catch {
      // The old token may still work; the claim lapses and a later request tries again.
      await this.#db
        .update(sessions)
        .set({ refreshingUntil: raw`NULL` })
        .where(eq(sessions.idHash, idHash))
        .catch(() => {});
      return undefined;
    }
  }

  /** `iv ‖ tag ‖ ciphertext`, bound to the session by `aad`. */
  #seal(plain: string, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#options.key, iv).setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  #open(sealed: Buffer, aad: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.#options.key, sealed.subarray(0, 12))
      .setAAD(Buffer.from(aad))
      .setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
  }
}
