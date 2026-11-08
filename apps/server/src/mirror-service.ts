import { eq, sql as raw } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { repos } from "./db/schema.ts";
import { Lease } from "./lease.ts";
import type { Mirror } from "./mirror.ts";
import type { PushedWork } from "./pushed-work.ts";

export interface MirrorServiceOptions {
  sql: postgres.Sql;
  mirror: Mirror;
  publisher: PushedWork;
  /** How often every repository is fetched (PRD: 30–60 s). */
  fetchMs: number;
  onError?: (repo: string, error: unknown) => void;
}

/**
 * Keeps every known repository's mirror fresh, and — on the one instance holding the
 * publisher lock — publishes pushed work after each fetch. Each instance fetches into
 * its own mirror, so translations and merges never leave the instance.
 */
export class MirrorService {
  readonly #options: MirrorServiceOptions;
  readonly #db;
  readonly #known = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #round: Promise<void> | undefined;
  readonly #lease: Lease;
  #stopped = false;

  constructor(options: MirrorServiceOptions) {
    this.#options = options;
    this.#db = drizzle(options.sql);
    this.#lease = new Lease(options.sql, "highground.pushed-work");
  }

  async start(): Promise<void> {
    for (const row of await this.#db.select({ repo: repos.repo }).from(repos)) {
      this.#known.add(row.repo);
    }
    this.#timer = setInterval(() => void this.round(), this.#options.fetchMs);
    void this.round();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    await this.#round?.catch(() => {});
    await this.#lease.close();
  }

  /** Starts mirroring a repository the first time it is named, and fetches it at once. */
  track(repo: string): void {
    if (this.#known.has(repo) || this.#stopped) return;
    this.#known.add(repo);
    void this.#db
      .insert(repos)
      .values({ repo })
      .onConflictDoNothing()
      .then(() => this.#refresh(repo, this.#isLeader()))
      .catch((error: unknown) => this.#options.onError?.(repo, error));
  }

  /** Fetches every repository, and publishes their pushed work when this instance leads. */
  round(): Promise<void> {
    this.#round ??= (async () => {
      const leading = await this.#isLeader();
      for (const repo of this.#known) {
        if (this.#stopped) return;
        await this.#refresh(repo, Promise.resolve(leading));
      }
    })().finally(() => {
      this.#round = undefined;
    });
    return this.#round;
  }

  async #refresh(repo: string, leading: Promise<boolean>): Promise<void> {
    let error: string | null = null;
    try {
      await this.#options.mirror.sync(repo);
      if (await leading) await this.#options.publisher.publish(repo);
    } catch (failure) {
      error = String(failure);
      this.#options.onError?.(repo, failure);
    }
    await this.#db
      .update(repos)
      .set({ lastFetchAt: raw`now()`, lastError: error })
      .where(eq(repos.repo, repo))
      .catch(() => {});
  }

  /** Whether this instance publishes pushed work, taking the lease when it is free. */
  #isLeader(): Promise<boolean> {
    return this.#stopped ? Promise.resolve(false) : this.#lease.held();
  }
}
