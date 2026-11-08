import { watch, type FSWatcher } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { capChanges, type FileHeartbeat, type Warning } from "@highground/core";
import {
  diffRanges,
  ensureIdentity,
  RepoStateError,
  repoState,
  watchTargets,
  type RepoState,
} from "@highground/git";
import type { Log } from "@highground/log";
import { describeError, type ServerClient } from "./server-client.ts";

export interface ReporterOptions {
  /** Any directory inside the working copy. */
  root: string;
  server: ServerClient;
  log: Log;
  /** Quiet time after a filesystem event before recomputing (PRD §6: 500 ms). */
  debounceMs?: number;
  /** Recompute and resend the complete snapshot this often, events or not (PRD §6: 20 s). */
  keepaliveMs?: number;
  ttlSeconds?: number;
  /** Watch the filesystem; off, the keepalive alone finds changes. */
  watch?: boolean;
  /** Called whenever the working copy's state has been read. */
  onState?: (state: RepoState, id: string) => void;
}

const ACTOR = { type: "cli", id: "daemon" } as const;
const MAX_FILES = 200;
const MAX_CHANGES = 50;

const collisionKey = (w: Warning) =>
  [w.path, w.peer.working_copy_id, w.peer.actor.type, w.peer.actor.id].join("\0");

/**
 * Reports one working copy's live work: recomputes its ranges after filesystem changes
 * and on a keepalive, sends them as complete heartbeats, and follows the collisions the
 * server announces for it. Every failure degrades and is retried; none is thrown.
 */
export class Reporter {
  /** The working copy's id, once its repository could be read. */
  id: string | undefined;
  state: RepoState | undefined;
  /** Heartbeats the server accepted. */
  sent = 0;
  /** Why the last report did not reach the server; null when it did. */
  degraded: string | null = null;

  readonly #options: Required<ReporterOptions>;
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #abort = new AbortController();
  readonly #collisions = new Map<string, Warning>();
  #debounce: NodeJS.Timeout | undefined;
  #keepalive: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #subscription: Promise<void> | undefined;
  #stopped = false;

  constructor(options: ReporterOptions) {
    this.#options = {
      debounceMs: 500,
      keepaliveMs: 20_000,
      ttlSeconds: 60,
      watch: true,
      onState: () => {},
      ...options,
    };
  }

  /** Reports once, then keeps reporting until stopped. */
  async start(): Promise<void> {
    await this.refresh();
    this.#keepalive = setInterval(() => void this.refresh(), this.#options.keepaliveMs);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#debounce);
    clearInterval(this.#keepalive);
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    this.#abort.abort();
    await Promise.allSettled([this.#running, this.#subscription]);
  }

  /** The collisions the server currently reports against this working copy. */
  collisions(): Warning[] {
    return [...this.#collisions.values()];
  }

  /** Recomputes and sends now; a call during a report runs one more report after it. */
  refresh(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        await this.#report();
      } while (this.#again && !this.#stopped);
    })().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #report(): Promise<void> {
    if (this.#stopped) return;
    let files: FileHeartbeat[];
    let state: RepoState;
    try {
      state = await repoState(this.#options.root);
      this.state = state;
      this.id ??= await ensureIdentity(state.root);
      this.#options.onState(state, this.id);
      if (this.#options.watch) await this.#syncWatches(state.root);
      files = (await diffRanges(state.root, state.base)).map((report) => ({
        path: report.path,
        whole_file: report.wholeFile,
        changes: capChanges(report.changes, MAX_CHANGES),
        intent: null,
      }));
    } catch (error) {
      const reason = error instanceof RepoStateError ? error.message : describeError(error);
      this.#degrade("working copy unreadable", reason);
      return;
    }

    try {
      // One complete heartbeat replaces everything; more files follow it as partials.
      for (let i = 0; i === 0 || i < files.length; i += MAX_FILES) {
        await this.#options.server.heartbeat({
          repo: state.repo,
          working_copy_id: this.id,
          actor: ACTOR,
          author: state.author,
          branch: state.branch,
          base_sha: state.base,
          scope: i === 0 ? "complete" : "partial",
          files: files.slice(i, i + MAX_FILES),
          ttl_seconds: this.#options.ttlSeconds,
        });
        this.sent++;
      }
    } catch (error) {
      this.#degrade("heartbeat failed", describeError(error));
      return;
    }
    if (this.degraded !== null) {
      this.#options.log.info({ root: state.root }, "reporting recovered");
      this.degraded = null;
    }
    this.#subscribe(state.repo, this.id);
  }

  /** Records why reporting failed, logging only when the reason changes. */
  #degrade(msg: string, reason: string): void {
    if (this.degraded !== reason) this.#options.log.warn({ root: this.#options.root, reason }, msg);
    this.degraded = reason;
  }

  async #syncWatches(root: string): Promise<void> {
    const targets = new Set(await watchTargets(root));
    for (const [dir, watcher] of this.#watchers) {
      if (!targets.has(dir)) {
        watcher.close();
        this.#watchers.delete(dir);
      }
    }
    for (const dir of targets) {
      if (this.#watchers.has(dir) || this.#stopped) continue;
      try {
        const watcher = watch(dir, (_event, name) => {
          if (dir === root && name === ".highground") return;
          this.#schedule();
        });
        watcher.on("error", () => {
          watcher.close();
          this.#watchers.delete(dir);
        });
        this.#watchers.set(dir, watcher);
      } catch {
        // The directory vanished between listing and watching; the next sync catches up.
      }
    }
  }

  #schedule(): void {
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => void this.refresh(), this.#options.debounceMs);
  }

  /** Holds the collision stream open, reconnecting with backoff; it also marks presence. */
  #subscribe(repo: string, workingCopyId: string): void {
    if (this.#subscription) return;
    const { server, log } = this.#options;
    const signal = this.#abort.signal;
    // Resolves to `done` on stop. The client's iterator does not always end when its
    // signal aborts while it waits for an event, so each read races this, and the
    // iterator is then returned, which closes the stream and lets presence clear us.
    const stopped = new Promise<IteratorReturnResult<undefined>>((resolve) =>
      signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
        once: true,
      }),
    );
    this.#subscription = (async () => {
      let delay = 100;
      while (!this.#stopped) {
        try {
          const events = await server.subscribe(
            { repo, working_copy_id: workingCopyId },
            { signal },
          );
          this.#collisions.clear();
          delay = 100;
          for (;;) {
            const next = await Promise.race([events.next(), stopped]);
            if (next.done) {
              if (this.#stopped) void events.return?.().catch(() => {});
              break;
            }
            const { event, warning } = next.value;
            if (event === "collision_started") {
              this.#collisions.set(collisionKey(warning), warning);
              log.info({ warning }, "collision started");
            } else {
              this.#collisions.delete(collisionKey(warning));
              log.info({ warning }, "collision ended");
            }
          }
        } catch (error) {
          if (this.#stopped) return;
          log.debug({ reason: describeError(error) }, "subscription dropped");
        }
        await sleep(delay, undefined, { signal }).catch(() => {});
        delay = Math.min(delay * 2, 5_000);
      }
    })();
  }
}
