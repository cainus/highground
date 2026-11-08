import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Access, GitHubApp } from "./github.ts";

/** Decides whether a request may read or report on a repository (ADR 0004). */
export interface Authorizer {
  /**
   * Resolves when the request's credentials may act on `repo`; otherwise throws an
   * `UNAUTHORIZED` (no or unknown credentials) or `FORBIDDEN` (no access) error.
   */
  authorize(authorization: string | undefined, repo: string): Promise<void>;
}

/** For tests and single-user installs that accept every request. */
export const allowAll: Authorizer = { authorize: async () => {} };

/** How long an answer from GitHub is trusted. */
const READ_TTL_MS = 5 * 60_000;
/** Refusals are rechecked sooner, so a newly granted user is not kept out for long. */
const REFUSED_TTL_MS = 30_000;
const MAX_CACHED = 50_000;

/**
 * Accepts a GitHub user token that can read the repository on GitHub itself, so access
 * follows the organisation's own permissions. Answers are cached per token and
 * repository; only a digest of the token is kept.
 */
export class GitHubAuthorizer implements Authorizer {
  readonly #github: GitHubApp;
  readonly #now: () => number;
  readonly #cache = new Map<string, { access: Promise<Access>; until: number }>();

  constructor(github: GitHubApp, now: () => number = Date.now) {
    this.#github = github;
    this.#now = now;
  }

  async authorize(authorization: string | undefined, repo: string): Promise<void> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    if (!token) throw new ORPCError("UNAUTHORIZED", { message: "sign in with `highground login`" });
    const access = await this.#access(token, repo);
    if (access === "invalid") {
      throw new ORPCError("UNAUTHORIZED", { message: "GitHub does not accept this token" });
    }
    if (access === "denied") {
      throw new ORPCError("FORBIDDEN", { message: `no read access to ${repo} on GitHub` });
    }
  }

  #access(token: string, repo: string): Promise<Access> {
    const key = `${createHash("sha256").update(token).digest("base64url")}\0${repo}`;
    const now = this.#now();
    const cached = this.#cache.get(key);
    if (cached && cached.until > now) return cached.access;

    const access = this.#github.access(token, repo).catch((error: unknown) => {
      // GitHub could not answer: nothing is cached, and the caller fails open on its side.
      if (this.#cache.get(key)?.access === access) this.#cache.delete(key);
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: "GitHub could not confirm access",
        cause: error,
      });
    });
    // Concurrent requests share one lookup; the TTL is set once the answer is known.
    this.#cache.delete(key);
    this.#cache.set(key, { access, until: Number.POSITIVE_INFINITY });
    if (this.#cache.size > MAX_CACHED) this.#cache.delete(this.#cache.keys().next().value!);
    void access.then(
      (answer) => {
        const entry = this.#cache.get(key);
        if (entry?.access === access) {
          entry.until = this.#now() + (answer === "read" ? READ_TTL_MS : REFUSED_TTL_MS);
        }
      },
      () => {},
    );
    return access;
  }
}
