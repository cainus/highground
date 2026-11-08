import { createHash } from "node:crypto";
import type { Actor, RadarCollision } from "@highground/core";
import { isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { collisionEvents } from "./db/schema.ts";
import type { ChangeCause, Hub } from "./hub.ts";
import { Lease } from "./lease.ts";
import { radarId, type Entry, type JudgedPath, type PathRef } from "./live-index.ts";

const SEVERITY_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 } as const;
const TYPE_RANK = { DIRECT_OVERLAP: 3, DUPLICATE_CHANGE: 2, PROXIMITY_ALERT: 1 } as const;
const YEAR_MS = 365 * 86_400_000;
const PRUNE_EVERY_MS = 60 * 60_000;
/** After a failed flush, wait this long before trying again. */
const RETRY_MS = 1_000;

/** One side of an episode, as recorded. */
export interface EpisodeSide {
  id: string;
  workingCopyId: string;
  actor: Actor;
  author: string;
  kind: Entry["kind"];
}

/** A collision episode that just reached HIGH, for Web Push. */
export interface HighEpisode {
  id: number;
  repo: string;
  path: string;
  a: EpisodeSide;
  b: EpisodeSide;
  type: RadarCollision["type"];
  confirmed: boolean | null;
}

interface Open {
  /** The row's id, once a flush has written it. */
  id: number | undefined;
  /** SHA-256 of repo, path and both sides: the open-pair index's key. */
  pairKey: string;
  repo: string;
  path: string;
  a: EpisodeSide;
  b: EpisodeSide;
  startedAt: number;
  verdict: Omit<RadarCollision, "a" | "b">;
  /** The verdict changed since the row was last written. */
  escalated: boolean;
  ended: { at: number; by: "a" | "b" | "expired"; changedCourse: boolean } | undefined;
  /** The pass of `#changed` that last saw the pair colliding. */
  seen: number;
  /** HIGH was reached: claim the episode's one notification on the next flush. */
  notify: boolean;
  notified: boolean;
}

export interface RecorderOptions {
  sql: postgres.Sql;
  hub: Hub;
  /** How often leadership is checked. */
  tickMs: number;
  /** How long changes gather before one flush writes them all; 100 ms by default. */
  flushMs?: number;
  /** Called once per episode, when it first reaches HIGH, on the recording instance. */
  onHigh?: (episode: HighEpisode) => Promise<void>;
  onError?: (error: unknown) => void;
}

const sideOf = (entry: Entry): EpisodeSide => ({
  id: radarId(entry),
  workingCopyId: entry.workingCopyId,
  actor: entry.actor,
  author: entry.author,
  kind: entry.kind,
});

const worse = (x: Open["verdict"], y: Open["verdict"]) =>
  SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity] || TYPE_RANK[y.type] - TYPE_RANK[x.type];

const isCause = (side: EpisodeSide, cause: ChangeCause | null) =>
  cause !== null &&
  cause.workingCopyId === side.workingCopyId &&
  cause.actor.type === side.actor.type &&
  cause.actor.id === side.actor.id;

/**
 * Records collision history (plan 05): one `collision_events` row per episode, written
 * by the one instance holding the recorder lease. Every instance projects every
 * heartbeat, so the leader's index is complete; a new leader reconciles the open rows
 * with what it sees, so a failover neither loses nor duplicates an episode.
 */
export class Recorder {
  leading = false;
  readonly #options: RecorderOptions;
  readonly #db;
  readonly #lease: Lease;
  /** `repo\0path` → `aId\0bId` → the open episode. */
  readonly #byPath = new Map<string, Map<string, Open>>();
  #pass = 0;
  /** Episodes changed since the last flush, in the order they changed. */
  readonly #dirty = new Set<Open>();
  #flushTimer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #ticking: Promise<void> | undefined;
  #prunedAt = 0;
  #stopped = false;

  constructor(options: RecorderOptions) {
    this.#options = options;
    this.#db = drizzle(options.sql);
    this.#lease = new Lease(options.sql, "highground.recorder");
  }

  start(): void {
    this.#unsubscribe = this.#options.hub.onChange((paths, cause, now) =>
      this.#changed(paths, cause, now),
    );
    this.#timer = setInterval(() => void this.tick(), this.#options.tickMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    clearTimeout(this.#flushTimer);
    this.#unsubscribe?.();
    await this.#ticking;
    // Whatever is still pending is written once more, while the lease is still held.
    await this.#flushing;
    if (this.leading) await this.flush().catch((error: unknown) => this.#options.onError?.(error));
    this.leading = false;
    await this.#lease.close();
  }

  /** Checks leadership: takes over when the lease comes free, steps down when it is lost. */
  tick(): Promise<void> {
    this.#ticking ??= (async () => {
      const held = await this.#lease.held();
      if (this.#stopped) return;
      if (held && !this.leading) await this.#takeOver();
      else if (!held && this.leading) this.#stepDown();
      if (this.leading && Date.now() - this.#prunedAt > PRUNE_EVERY_MS) {
        this.#prunedAt = Date.now();
        await this.prune().catch((error: unknown) => this.#options.onError?.(error));
      }
    })()
      .catch((error: unknown) => this.#options.onError?.(error))
      .finally(() => {
        this.#ticking = undefined;
      });
    return this.#ticking;
  }

  /** Deletes episodes that ended more than a year ago. */
  async prune(): Promise<void> {
    await this.#db
      .delete(collisionEvents)
      .where(lt(collisionEvents.endedAt, new Date(Date.now() - YEAR_MS)));
  }

  /** Loads the open episodes, then reconciles them with the index across every path. */
  async #takeOver(): Promise<void> {
    const rows = await this.#db
      .select()
      .from(collisionEvents)
      .where(isNull(collisionEvents.endedAt));
    for (const row of rows) {
      this.#remember(`${row.aId}\0${row.bId}`, {
        id: row.id,
        seen: 0,
        repo: row.repo,
        path: row.path,
        a: {
          id: row.aId,
          workingCopyId: row.aWorkingCopyId,
          actor: row.aActor,
          author: row.aAuthor,
          kind: row.aKind as Entry["kind"],
        },
        b: {
          id: row.bId,
          workingCopyId: row.bWorkingCopyId,
          actor: row.bActor,
          author: row.bAuthor,
          kind: row.bKind as Entry["kind"],
        },
        startedAt: row.startedAt.getTime(),
        verdict: {
          type: row.type as Open["verdict"]["type"],
          severity: row.severity as Open["verdict"]["severity"],
          confirmed: row.confirmed,
          approximate: row.approximate,
        },
        pairKey: row.pairKey,
        escalated: false,
        ended: undefined,
        notify: false,
        notified: row.notifiedAt !== null,
      });
    }
    this.leading = true;
    const paths = new Map<string, PathRef>();
    for (const ref of [...this.#options.hub.index.paths(), ...rows]) {
      paths.set(`${ref.repo}\0${ref.path}`, { repo: ref.repo, path: ref.path });
    }
    const now = this.#options.hub.now();
    this.#changed(this.#options.hub.index.judge([...paths.values()], now), null, now);
  }

  /**
   * Another instance leads now; whatever this one had not written is dropped, since the
   * new leader reconciles every open episode with its own index on taking over.
   */
  #stepDown(): void {
    this.leading = false;
    this.#byPath.clear();
    this.#dirty.clear();
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
  }

  /**
   * Reconciles each changed path's open episodes with its colliding pairs: new pairs
   * begin, stronger verdicts escalate, and pairs this pass did not see end. Runs on the
   * heartbeat path, so per pair it does no more than two lookups. A focused pass (`only`)
   * judged just its actor's pairs, so only that actor's episodes can end.
   */
  #changed(paths: JudgedPath[], cause: ChangeCause | null, now: number): void {
    if (!this.leading) return;
    const index = this.#options.hub.index;
    for (const { repo, path, pairs, only } of paths) {
      const pass = ++this.#pass;
      let open = this.#byPath.get(`${repo}\0${path}`);
      for (const pair of index.collidingPairs(repo, path, now, pairs)) {
        let [a, b] = [pair.a, pair.b];
        let [aId, bId] = [radarId(a), radarId(b)];
        if (aId > bId) [a, b, aId, bId] = [b, a, bId, aId];
        const key = `${aId}\0${bId}`;
        const episode = open?.get(key);
        if (episode) {
          episode.seen = pass;
          if (worse(episode.verdict, pair.collision) > 0) this.#escalate(episode, pair.collision);
        } else {
          this.#begin(key, repo, path, sideOf(a), sideOf(b), pair.collision, now, pass);
          open = this.#byPath.get(`${repo}\0${path}`);
        }
      }
      if (!open) continue;
      for (const [key, episode] of open) {
        if (episode.seen === pass) continue;
        if (only !== undefined && !isCause(episode.a, cause) && !isCause(episode.b, cause)) {
          continue;
        }
        this.#end(key, episode, cause, now);
      }
      if (open.size === 0) this.#byPath.delete(`${repo}\0${path}`);
    }
  }

  #remember(key: string, open: Open): void {
    const at = `${open.repo}\0${open.path}`;
    let episodes = this.#byPath.get(at);
    if (!episodes) this.#byPath.set(at, (episodes = new Map()));
    episodes.set(key, open);
  }

  #begin(
    key: string,
    repo: string,
    path: string,
    a: EpisodeSide,
    b: EpisodeSide,
    verdict: Open["verdict"],
    now: number,
    pass: number,
  ): void {
    const open: Open = {
      id: undefined,
      seen: pass,
      pairKey: createHash("sha256").update(`${repo}\0${path}\0${key}`).digest("hex"),
      repo,
      path,
      a,
      b,
      startedAt: now,
      verdict,
      escalated: false,
      ended: undefined,
      notify: false,
      notified: false,
    };
    this.#remember(key, open);
    this.#touch(open);
    this.#notifyIfHigh(open);
  }

  #escalate(open: Open, verdict: Open["verdict"]): void {
    open.verdict = verdict;
    open.escalated = true;
    this.#touch(open);
    this.#notifyIfHigh(open);
  }

  #end(key: string, open: Open, cause: ChangeCause | null, now: number): void {
    this.#byPath.get(`${open.repo}\0${open.path}`)?.delete(key);
    const by = isCause(open.a, cause) ? "a" : isCause(open.b, cause) ? "b" : "expired";
    const side = by === "a" ? open.a : by === "b" ? open.b : null;
    // Agents only ever send partial heartbeats; a complete one with nothing in it is the
    // server clearing a working copy that went away, which is not a change of course.
    const changedCourse = side?.actor.type === "agent" && cause?.scope === "partial";
    open.ended = { at: now, by, changedCourse };
    this.#touch(open);
  }

  #notifyIfHigh(open: Open): void {
    if (open.notified || open.verdict.severity !== "HIGH" || !this.#options.onHigh) return;
    open.notified = true;
    open.notify = true;
  }

  /** Marks an episode for the next flush, which runs `flushMs` after the first change. */
  #touch(open: Open): void {
    this.#dirty.add(open);
    this.#schedule(this.#options.flushMs ?? 100);
  }

  #schedule(ms: number): void {
    if (this.#flushTimer || this.#stopped) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.flush().catch((error: unknown) => {
        this.#options.onError?.(error);
        this.#schedule(RETRY_MS);
      });
    }, ms);
  }

  /**
   * Writes every changed episode in at most four statements (open, escalate, end, claim
   * notifications), whatever the number of episodes, so a burst of collisions costs the
   * heartbeat path nothing and the database a few round trips. Each statement is
   * idempotent, so a failed flush puts its episodes back and the next one repeats it.
   */
  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing.then(() => this.flush());
    if (this.#dirty.size === 0) return Promise.resolve();
    const batch = [...this.#dirty];
    this.#dirty.clear();
    this.#flushing = this.#writeBatch(batch)
      .catch((error: unknown) => {
        if (this.leading) for (const open of batch) this.#dirty.add(open);
        throw error;
      })
      .finally(() => {
        this.#flushing = undefined;
      });
    return this.#flushing;
  }

  // Timestamps and JSON go as text arrays, cast in SQL: Drizzle replaces the shared
  // client's date and JSON serializers (arrays included) with ones that pass values through.
  async #writeBatch(batch: Open[]): Promise<void> {
    const { sql } = this.#options;
    const unsaved = batch.filter((o) => o.id === undefined);
    if (unsaved.length > 0) {
      const col = <T>(f: (o: Open) => T) => unsaved.map(f);
      const inserted = await sql<{ id: string; pair_key: string }[]>`
        INSERT INTO collision_events (pair_key, repo, path,
          a_id, a_working_copy_id, a_actor, a_author, a_kind,
          b_id, b_working_copy_id, b_actor, b_author, b_kind,
          type, severity, confirmed, approximate, started_at)
        SELECT * FROM unnest(
          ${col((o) => o.pairKey)}::text[], ${col((o) => o.repo)}::text[], ${col((o) => o.path)}::text[],
          ${col((o) => o.a.id)}::text[], ${col((o) => o.a.workingCopyId)}::uuid[],
          ${col((o) => JSON.stringify(o.a.actor))}::text[]::jsonb[], ${col((o) => o.a.author)}::text[],
          ${col((o) => o.a.kind)}::text[],
          ${col((o) => o.b.id)}::text[], ${col((o) => o.b.workingCopyId)}::uuid[],
          ${col((o) => JSON.stringify(o.b.actor))}::text[]::jsonb[], ${col((o) => o.b.author)}::text[],
          ${col((o) => o.b.kind)}::text[],
          ${col((o) => o.verdict.type)}::text[], ${col((o) => o.verdict.severity)}::text[],
          ${col((o) => o.verdict.confirmed)}::boolean[], ${col((o) => o.verdict.approximate)}::boolean[],
          ${col((o) => new Date(o.startedAt).toISOString())}::text[]::timestamptz[])
        ON CONFLICT (pair_key) WHERE ended_at IS NULL DO NOTHING
        RETURNING id, pair_key`;
      const ids = new Map(inserted.map((r) => [r.pair_key, Number(r.id)]));
      const fresh = new Set(ids.keys());
      // A previous leader may have opened some a moment before handing over.
      const missing = unsaved.filter((o) => !ids.has(o.pairKey)).map((o) => o.pairKey);
      if (missing.length > 0) {
        const found = await sql<{ id: string; pair_key: string }[]>`
          SELECT id, pair_key FROM collision_events
          WHERE pair_key = ANY(${missing}::text[]) AND ended_at IS NULL`;
        for (const r of found) ids.set(r.pair_key, Number(r.id));
      }
      for (const o of unsaved) {
        o.id = ids.get(o.pairKey);
        // A fresh row already holds the current verdict.
        if (fresh.has(o.pairKey)) o.escalated = false;
      }
    }
    const saved = batch.filter((o) => o.id !== undefined);

    const escalated = saved.filter((o) => o.escalated);
    if (escalated.length > 0) {
      const col = <T>(f: (o: Open) => T) => escalated.map(f);
      await sql`
        UPDATE collision_events c SET type = v.type, severity = v.severity,
          confirmed = v.confirmed, approximate = v.approximate
        FROM unnest(${col((o) => o.id!)}::bigint[], ${col((o) => o.verdict.type)}::text[],
          ${col((o) => o.verdict.severity)}::text[], ${col((o) => o.verdict.confirmed)}::boolean[],
          ${col((o) => o.verdict.approximate)}::boolean[])
          AS v(id, type, severity, confirmed, approximate)
        WHERE c.id = v.id`;
      for (const o of escalated) o.escalated = false;
    }

    const ended = saved.filter((o) => o.ended);
    if (ended.length > 0) {
      const col = <T>(f: (o: Open) => T) => ended.map(f);
      await sql`
        UPDATE collision_events c SET ended_at = v.ended_at, ended_by = v.ended_by,
          changed_course = v.changed_course
        FROM unnest(${col((o) => o.id!)}::bigint[],
          ${col((o) => new Date(o.ended!.at).toISOString())}::text[]::timestamptz[],
          ${col((o) => o.ended!.by)}::text[], ${col((o) => o.ended!.changedCourse)}::boolean[])
          AS v(id, ended_at, ended_by, changed_course)
        WHERE c.id = v.id`;
    }

    // Claimed in the database, so no failover repeats an episode's notification.
    const notify = saved.filter((o) => o.notify);
    if (notify.length > 0 && this.#options.onHigh) {
      const claimed = await sql<{ id: string }[]>`
        UPDATE collision_events SET notified_at = now()
        WHERE id = ANY(${notify.map((o) => o.id!)}::bigint[]) AND notified_at IS NULL
        RETURNING id`;
      const won = new Set(claimed.map((r) => Number(r.id)));
      const onHigh = this.#options.onHigh;
      for (const o of notify) {
        o.notify = false;
        if (!won.has(o.id!)) continue;
        // Delivery runs beside the flushes: a slow push service never delays history.
        void onHigh({
          id: o.id!,
          repo: o.repo,
          path: o.path,
          a: o.a,
          b: o.b,
          type: o.verdict.type,
          confirmed: o.verdict.confirmed,
        }).catch((error: unknown) => this.#options.onError?.(error));
      }
    }
  }
}
