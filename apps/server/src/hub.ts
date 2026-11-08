import type {
  CollisionEvent,
  Heartbeat,
  Warning,
  WarningsQuery,
  WarningsResponse,
} from "@highground/core";
import { CollisionTracker } from "./collision-tracker.ts";
import type { HeartbeatLog } from "./db/heartbeat-log.ts";
import { LiveIndex } from "./live-index.ts";

/** The longest TTL a heartbeat may have; rebuilding replays this much of the log. */
const MAX_TTL_MS = 300_000;

export interface HubOptions {
  /** How long a closed stream may stay away before its working copy is cleared. */
  graceMs: number;
  /** How often expired entries are swept, so their collisions end. */
  sweepMs: number;
  now?: () => number;
}

type Listener = (event: CollisionEvent) => void;

const respond = (warnings: Warning[]): WarningsResponse => ({
  has_collisions: warnings.length > 0,
  warnings,
});

/**
 * Ties the heartbeat log, the live index and the collision tracker together, and owns
 * subscriptions and presence. Every state change goes through the log first.
 */
export class Hub {
  readonly index = new LiveIndex();
  readonly #tracker: CollisionTracker;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #openStreams = new Map<string, number>();
  readonly #graceTimers = new Map<string, NodeJS.Timeout>();
  readonly #now: () => number;
  #sweep: NodeJS.Timeout | undefined;
  #stopped = false;
  #unlisten: (() => Promise<void>) | undefined;

  readonly #log: HeartbeatLog;
  readonly #options: HubOptions;

  constructor(log: HeartbeatLog, options: HubOptions) {
    this.#log = log;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#tracker = new CollisionTracker(this.index, (repo, workingCopyId, event) => {
      for (const listener of this.#listeners.get(`${repo}\0${workingCopyId}`) ?? [])
        listener(event);
    });
  }

  /** Rebuilds the index from the log, then follows other instances and sweeps expiry. */
  async start(): Promise<void> {
    const now = this.#now();
    for (const { heartbeat, receivedAt } of await this.#log.since(new Date(now - MAX_TTL_MS))) {
      this.#tracker.refresh(this.index.apply(heartbeat, receivedAt), now);
    }
    this.#tracker.refresh(this.index.expire(now), now);
    this.#unlisten = await this.#log.listen((heartbeat, receivedAt) => {
      if (this.#stopped) return;
      this.#tracker.refresh(this.index.apply(heartbeat, receivedAt), this.#now());
    });
    this.#sweep = setInterval(() => {
      const at = this.#now();
      this.#tracker.refresh(this.index.expire(at), at);
    }, this.#options.sweepMs);
  }

  /**
   * Stops background work. Streams that close after this are the server going away,
   * not their clients, so they do not clear anyone's live state.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#sweep);
    for (const timer of this.#graceTimers.values()) clearTimeout(timer);
    await this.#unlisten?.();
    await this.#log.stop();
  }

  /**
   * Applies a heartbeat and answers with the collisions of the files it named. The log
   * write follows within a flush (ADR 0002); the log reports its own failures.
   */
  heartbeat(heartbeat: Heartbeat): WarningsResponse {
    const now = this.#now();
    this.#log.append(heartbeat, now).catch(() => {});
    this.#tracker.refresh(this.index.apply(heartbeat, now), now);
    return respond(
      heartbeat.files.flatMap((file) =>
        this.index.warnings(
          {
            repo: heartbeat.repo,
            path: file.path,
            workingCopyId: heartbeat.working_copy_id,
            baseSha: heartbeat.base_sha,
            changes: file.changes,
            wholeFile: file.whole_file,
          },
          now,
        ),
      ),
    );
  }

  query(query: WarningsQuery): WarningsResponse {
    return respond(
      this.index.warnings(
        {
          repo: query.repo,
          path: query.path,
          workingCopyId: query.working_copy_id,
          baseSha: query.base_sha,
          changes: [{ range: [query.start, query.end], digest: null }],
        },
        this.#now(),
      ),
    );
  }

  /**
   * A working copy's collision events: first its current collisions, then each change.
   * While any stream is open the working copy counts as present (PRD §5.4).
   */
  async *subscribe(
    repo: string,
    workingCopyId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<CollisionEvent> {
    const key = `${repo}\0${workingCopyId}`;
    const queue: CollisionEvent[] = [];
    let wake: (() => void) | undefined;
    const listener: Listener = (event) => {
      queue.push(event);
      wake?.();
    };
    let listeners = this.#listeners.get(key);
    if (!listeners) this.#listeners.set(key, (listeners = new Set()));
    listeners.add(listener);
    this.#streamOpened(key);
    try {
      for (const warning of this.#tracker.current(repo, workingCopyId)) {
        yield { event: "collision_started", warning };
      }
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = undefined;
      }
    } finally {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(key);
      this.#streamClosed(key, repo, workingCopyId);
    }
  }

  #streamOpened(key: string): void {
    this.#openStreams.set(key, (this.#openStreams.get(key) ?? 0) + 1);
    clearTimeout(this.#graceTimers.get(key));
    this.#graceTimers.delete(key);
  }

  #streamClosed(key: string, repo: string, workingCopyId: string): void {
    const open = (this.#openStreams.get(key) ?? 1) - 1;
    if (open > 0) {
      this.#openStreams.set(key, open);
      return;
    }
    this.#openStreams.delete(key);
    if (this.#stopped) return;
    const timer = setTimeout(() => {
      this.#graceTimers.delete(key);
      this.#clear(repo, workingCopyId);
    }, this.#options.graceMs);
    this.#graceTimers.set(key, timer);
  }

  /** Clears every actor of a vanished working copy through the log, so it is durable. */
  #clear(repo: string, workingCopyId: string): void {
    for (const state of this.index.actorsOf(repo, workingCopyId)) {
      this.heartbeat({
        repo,
        working_copy_id: workingCopyId,
        actor: state.actor,
        author: state.author,
        branch: state.branch,
        base_sha: state.baseSha,
        scope: "complete",
        files: [],
        ttl_seconds: 60,
      });
    }
  }
}
