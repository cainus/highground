import { join } from "node:path";
import type { Hunk } from "@highground/core";
import { diffPaths, fetchMirror, hasCommit, initMirror, mergeTree } from "@highground/git";
import type { Oracle, PathRef } from "./live-index.ts";

/** Where a repository is fetched from, and the git config (credentials) to fetch with. */
export interface Remote {
  url(repo: string): string;
  config(repo: string): Promise<Record<string, string>>;
}

export interface MirrorOptions {
  dir: string;
  remote: Remote;
  /** Called when the mirror learns something that changes answers on these paths. */
  onLearned?: (paths: PathRef[]) => void;
  onError?: (repo: string, error: unknown) => void;
}

/** Lookups that failed are retried after this long; until then the answer stays "unknown". */
const RETRY_MS = 60_000;
/** Cached translations and merges kept, oldest dropped first. */
const MAX_CACHED = 20_000;

/** A Map that drops its oldest entries past a size. */
class Bounded<K, V> extends Map<K, V> {
  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > MAX_CACHED) this.delete(this.keys().next().value as K);
    return this;
  }
}

/**
 * One bare clone per repository (PRD §2), and the oracle the live index asks for
 * translations between bases and for speculative merges of pushed heads. Lookups answer
 * from the cache at once; a miss queues the git work, batched per commit pair, and the
 * paths that asked are refreshed when it lands.
 */
export class Mirror implements Oracle {
  onLearned: (paths: PathRef[]) => void;
  readonly #options: MirrorOptions;
  /** `repo\0from\0to` → path → hunks (null: binary, untranslatable). */
  readonly #hunks = new Bounded<string, Map<string, Hunk[] | null>>();
  /** `repo\0a\0b` (sorted heads) → conflicting paths. */
  readonly #merges = new Bounded<string, string[]>();
  /** Lookup keys that failed, → when to try again. */
  readonly #failed = new Map<string, number>();
  /** Queued lookups: key → the paths waiting on it. */
  readonly #pendingHunks = new Map<string, Set<string>>();
  readonly #pendingMerges = new Map<string, Set<string>>();
  readonly #syncs = new Map<string, Promise<void>>();
  #flushing = false;

  constructor(options: MirrorOptions) {
    this.#options = options;
    this.onLearned = options.onLearned ?? (() => {});
  }

  dirOf(repo: string): string {
    return join(this.#options.dir, `${repo}.git`);
  }

  /** Fetches a repository, cloning it first if needed; concurrent calls share one fetch. */
  sync(repo: string): Promise<void> {
    let running = this.#syncs.get(repo);
    if (!running) {
      running = (async () => {
        const dir = this.dirOf(repo);
        await initMirror(dir, this.#options.remote.url(repo));
        await fetchMirror(dir, await this.#options.remote.config(repo));
      })().finally(() => this.#syncs.delete(repo));
      this.#syncs.set(repo, running);
    }
    return running;
  }

  hunks(repo: string, from: string, to: string, path: string): Hunk[] | undefined {
    const key = `${repo}\0${from}\0${to}`;
    const known = this.#hunks.get(key);
    if (known?.has(path)) return known.get(path) ?? undefined;
    this.#queue(this.#pendingHunks, key, path);
    return undefined;
  }

  conflicts(repo: string, headA: string, headB: string, path: string): string[] | undefined {
    const [a, b] = [headA, headB].sort() as [string, string];
    const key = `${repo}\0${a}\0${b}`;
    const known = this.#merges.get(key);
    if (known) return known;
    this.#queue(this.#pendingMerges, key, path);
    return undefined;
  }

  #queue(pending: Map<string, Set<string>>, key: string, path: string): void {
    if ((this.#failed.get(key) ?? 0) > Date.now()) return;
    let paths = pending.get(key);
    if (!paths) pending.set(key, (paths = new Set()));
    paths.add(path);
    if (!this.#flushing) {
      this.#flushing = true;
      setImmediate(() => void this.#flush());
    }
  }

  /** Runs every queued lookup, then names the paths whose answers changed. */
  async #flush(): Promise<void> {
    try {
      while (this.#pendingHunks.size > 0 || this.#pendingMerges.size > 0) {
        const hunkJobs = [...this.#pendingHunks];
        const mergeJobs = [...this.#pendingMerges];
        this.#pendingHunks.clear();
        this.#pendingMerges.clear();
        const learned: PathRef[] = [];
        for (const [key, paths] of hunkJobs) {
          const [repo, from, to] = key.split("\0") as [string, string, string];
          const result = await this.#attempt(key, repo, [from, to], (dir) =>
            diffPaths(dir, from, to, [...paths]),
          );
          if (!result) continue;
          const cached = this.#hunks.get(key) ?? new Map<string, Hunk[] | null>();
          for (const path of paths) cached.set(path, result.get(path) ?? null);
          this.#hunks.set(key, cached);
          learned.push(...[...paths].map((path) => ({ repo, path })));
        }
        for (const [key, paths] of mergeJobs) {
          const [repo, a, b] = key.split("\0") as [string, string, string];
          const result = await this.#attempt(key, repo, [a, b], (dir) => mergeTree(dir, a, b));
          if (!result) continue;
          this.#merges.set(key, result.clean ? [] : result.conflicts);
          learned.push(...[...paths].map((path) => ({ repo, path })));
        }
        if (learned.length > 0) this.onLearned(learned);
      }
    } finally {
      this.#flushing = false;
    }
  }

  /**
   * Runs a lookup that needs `commits` in the mirror, fetching once if any is missing
   * (a client's base may be newer than the last fetch). A failure is retried later.
   */
  async #attempt<T>(
    key: string,
    repo: string,
    commits: string[],
    run: (dir: string) => Promise<T>,
  ): Promise<T | undefined> {
    const dir = this.dirOf(repo);
    try {
      const present = async () =>
        (await Promise.all(commits.map((c) => hasCommit(dir, c).catch(() => false)))).every(
          Boolean,
        );
      if (!(await present())) {
        await this.sync(repo);
        if (!(await present())) throw new Error(`commits not on the remote: ${commits.join(" ")}`);
      }
      return await run(dir);
    } catch (error) {
      this.#failed.set(key, Date.now() + RETRY_MS);
      this.#options.onError?.(repo, error);
      return undefined;
    }
  }
}
