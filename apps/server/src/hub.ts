import {
  HeartbeatSchema,
  type CollisionEvent,
  type Radar,
  type Heartbeat,
  type Warning,
  type WarningsQuery,
  type WarningsResponse,
} from "@highground/core";
import { CollisionTracker } from "./collision-tracker.ts";
import type { HeartbeatLog } from "./db/heartbeat-log.ts";
import { LiveIndex, type JudgedPath, type Oracle, type PathRef } from "./live-index.ts";

/** What the hub needs of the heartbeat log: `HeartbeatLog` in production. */
export type HeartbeatStore = Pick<HeartbeatLog, "append" | "since" | "listen" | "stop">;

/** The longest TTL a heartbeat may have; rebuilding replays this much of the log. */
const MAX_TTL_MS = 300_000;

export interface HubOptions {
  /** How long a closed stream may stay away before its working copy is cleared. */
  graceMs: number;
  /** How often expired entries are swept, so their collisions end. */
  sweepMs: number;
  now?: () => number;
  /** The mirror's knowledge, for translation and speculative merges. */
  oracle?: Oracle;
  /** The least time between two radar updates on one repository's stream. */
  radarMs?: number;
}

/** One repository's radar watchers, and the update they are waiting for. */
interface RadarFeed {
  watchers: Set<(radar: Radar) => void>;
  timer: NodeJS.Timeout | undefined;
  /** When the last update went out. */
  sentAt: number;
}

type Listener = (event: CollisionEvent) => void;

/** The heartbeat behind a change; null for expiry and the mirror learning something. */
export interface ChangeCause {
  workingCopyId: string;
  actor: Heartbeat["actor"];
  scope: Heartbeat["scope"];
}

/** Told of every change to the index, after collisions have been recomputed. */
/** Follows index changes; each path comes with its pairs, judged once for everyone. */
export type ChangeListener = (paths: JudgedPath[], cause: ChangeCause | null, now: number) => void;

const causeOf = (heartbeat: Heartbeat): ChangeCause => ({
  workingCopyId: heartbeat.working_copy_id,
  actor: heartbeat.actor,
  scope: heartbeat.scope,
});

const respond = (warnings: Warning[]): WarningsResponse => ({
  has_collisions: warnings.length > 0,
  warnings,
});

/**
 * Ties the heartbeat log, the live index and the collision tracker together, and owns
 * subscriptions and presence. Every state change goes through the log first.
 */
export class Hub {
  readonly index: LiveIndex;
  readonly #tracker: CollisionTracker;
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #openStreams = new Map<string, number>();
  readonly #graceTimers = new Map<string, NodeJS.Timeout>();
  readonly #radarFeeds = new Map<string, RadarFeed>();
  readonly #changeListeners = new Set<ChangeListener>();
  readonly #now: () => number;
  #sweep: NodeJS.Timeout | undefined;
  #stopped = false;
  #unlisten: (() => Promise<void>) | undefined;

  readonly #log: HeartbeatStore;
  readonly #options: HubOptions;

  constructor(log: HeartbeatStore, options: HubOptions) {
    this.#log = log;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.index = new LiveIndex(options.oracle);
    this.#tracker = new CollisionTracker(this.index, (repo, workingCopyId, event) => {
      for (const listener of this.#listeners.get(`${repo}\0${workingCopyId}`) ?? [])
        listener(event);
    });
  }

  /** Rebuilds the index from the log, then follows other instances and sweeps expiry. */
  async start(): Promise<void> {
    const now = this.#now();
    for (const { heartbeat, receivedAt } of await this.#log.since(new Date(now - MAX_TTL_MS))) {
      this.#changed(this.index.apply(heartbeat, receivedAt), now, causeOf(heartbeat));
    }
    this.#changed(this.index.expire(now), now);
    this.#unlisten = await this.#log.listen((heartbeat, receivedAt) => {
      if (this.#stopped) return;
      this.#changed(this.index.apply(heartbeat, receivedAt), this.#now(), causeOf(heartbeat));
    });
    this.#sweep = setInterval(() => {
      const at = this.#now();
      this.#changed(this.index.expire(at), at);
    }, this.#options.sweepMs);
  }

  /**
   * Stops background work. Streams that close after this are the server going away,
   * not their clients, so they do not clear anyone's live state.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#sweep);
    for (const feed of this.#radarFeeds.values()) clearTimeout(feed.timer);
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
    this.#changed(this.index.apply(heartbeat, now), now, causeOf(heartbeat));
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
            branch: heartbeat.branch,
            kind: heartbeat.kind,
            headSha: heartbeat.head_sha,
            lastCommitAt: heartbeat.last_commit_at ? Date.parse(heartbeat.last_commit_at) : null,
            merges: heartbeat.merges,
          },
          now,
        ),
      ),
    );
  }

  /** Every change to the index goes through here: collisions, radar watchers, listeners. */
  #changed(paths: PathRef[], now: number, cause: ChangeCause | null = null): void {
    const judged = this.index.judge(paths, now);
    this.#tracker.refresh(judged, now);
    for (const repo of new Set(paths.map((p) => p.repo))) this.#radarChanged(repo);
    for (const listener of this.#changeListeners) listener(judged, cause, now);
  }

  /** Follows every change to the index; returns the unsubscribe. */
  onChange(listener: ChangeListener): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** The hub's clock. */
  now(): number {
    return this.#now();
  }

  /** Schedules one radar update for a repository's watchers, at most every `radarMs`. */
  #radarChanged(repo: string): void {
    const feed = this.#radarFeeds.get(repo);
    if (!feed || feed.timer || this.#stopped) return;
    const wait = Math.max(0, feed.sentAt + (this.#options.radarMs ?? 250) - Date.now());
    feed.timer = setTimeout(() => {
      feed.timer = undefined;
      feed.sentAt = Date.now();
      const radar = this.radar(repo);
      for (const watcher of feed.watchers) watcher(radar);
    }, wait);
  }

  /** Sends a repository's radar watchers a fresh radar, as when its display base moved. */
  refreshRepo(repo: string): void {
    this.#radarChanged(repo);
  }

  radar(repo: string): Radar {
    return { repo, files: this.index.radar(repo, this.#now()) };
  }

  /**
   * A repository's radar now, then a fresh one after each burst of changes. Every update
   * is a whole snapshot, so a watcher that misses one loses nothing; one snapshot is
   * computed per update however many watch.
   */
  async *watchRadar(repo: string, signal?: AbortSignal): AsyncGenerator<Radar> {
    let feed = this.#radarFeeds.get(repo);
    if (!feed)
      this.#radarFeeds.set(repo, (feed = { watchers: new Set(), timer: undefined, sentAt: 0 }));
    let latest: Radar | undefined;
    let wake: (() => void) | undefined;
    const watcher = (radar: Radar) => {
      latest = radar;
      wake?.();
    };
    feed.watchers.add(watcher);
    try {
      yield this.radar(repo);
      while (!signal?.aborted && !this.#stopped) {
        if (latest) {
          const next = latest;
          latest = undefined;
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
      feed.watchers.delete(watcher);
      if (feed.watchers.size === 0) {
        clearTimeout(feed.timer);
        this.#radarFeeds.delete(repo);
      }
    }
  }

  /** Recomputes collisions on paths whose answers changed, such as when the mirror learns a translation. */
  refresh(paths: PathRef[]): void {
    if (!this.#stopped) this.#changed(paths, this.#now());
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
          ...(query.branch ? { branch: query.branch } : {}),
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
      this.heartbeat(
        HeartbeatSchema.parse({
          repo,
          working_copy_id: workingCopyId,
          actor: state.actor,
          author: state.author,
          branch: state.branch,
          base_sha: state.baseSha,
          scope: "complete",
          files: [],
        }),
      );
    }
  }
}
