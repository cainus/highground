import type { Heartbeat } from "@highground/core";
import { and, asc, eq, gt, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { heartbeats } from "./schema.ts";

const CHANNEL = "highground_heartbeat";
/** NOTIFY payloads are capped at 8000 bytes; bodies under this ride along, larger ones are fetched. */
const INLINE_BODY_BYTES = 7_000;

export interface LoggedHeartbeat {
  heartbeat: Heartbeat;
  /** When the heartbeat was applied, in ms; every instance applies it with this time. */
  receivedAt: number;
}

export interface HeartbeatLogOptions {
  /** How long a heartbeat may wait for others to share its insert. */
  flushMs?: number;
  /** The most heartbeats one insert carries. */
  maxBatch?: number;
  /** First retry delay after a failed insert; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Above this many unwritten heartbeats the oldest are dropped, so an outage cannot exhaust memory. */
  maxPending?: number;
  onError?: (error: unknown) => void;
}

interface Pending {
  heartbeat: Heartbeat;
  receivedAt: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The append-only log behind live state (ADR 0002). Heartbeats are acknowledged once
 * applied in memory; this writes them behind, group-committing whatever arrives within
 * `flushMs` into one insert, and retrying a failed insert until it lands. Each written
 * heartbeat is announced to other instances with NOTIFY, carrying the heartbeat itself
 * when it fits.
 */
export class HeartbeatLog {
  /** Inserts committed so far. */
  flushes = 0;
  /** Heartbeats fetched because they were too large to ride in a notification. */
  fetches = 0;

  readonly #db;
  readonly #sql: postgres.Sql;
  readonly #origin: string;
  readonly #options: Required<Omit<HeartbeatLogOptions, "onError">> &
    Pick<HeartbeatLogOptions, "onError">;
  #queue: Pending[] = [];
  #timer: NodeJS.Timeout | undefined;
  #draining: Promise<void> | undefined;

  constructor(sql: postgres.Sql, origin: string, options: HeartbeatLogOptions = {}) {
    this.#sql = sql;
    this.#origin = origin;
    this.#db = drizzle(sql);
    this.#options = {
      flushMs: 5,
      maxBatch: 100,
      retryMs: 100,
      maxRetryMs: 5_000,
      maxPending: 10_000,
      ...options,
    };
  }

  /** Queues a heartbeat applied at `receivedAt`; resolves once it is committed. */
  append(heartbeat: Heartbeat, receivedAt: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#queue.push({ heartbeat, receivedAt, resolve, reject });
      this.#shed();
      if (this.#queue.length >= this.#options.maxBatch) this.#kick();
      else this.#timer ??= setTimeout(() => this.#kick(), this.#options.flushMs);
    });
  }

  /** Writes everything still queued. */
  async stop(): Promise<void> {
    this.#kick();
    await this.#draining;
  }

  #kick(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = undefined;
    });
  }

  async #drain(): Promise<void> {
    let delay = this.#options.retryMs;
    while (this.#queue.length > 0) {
      const batch = this.#queue.slice(0, this.#options.maxBatch);
      try {
        await this.#write(batch);
      } catch (error) {
        this.#options.onError?.(error);
        await sleep(delay);
        delay = Math.min(delay * 2, this.#options.maxRetryMs);
        continue;
      }
      delay = this.#options.retryMs;
      this.flushes++;
      // The queue may have shed entries meanwhile; remove exactly the ones written.
      const written = new Set(batch);
      this.#queue = this.#queue.filter((p) => !written.has(p));
      for (const pending of batch) pending.resolve();
    }
  }

  #shed(): void {
    const excess = this.#queue.length - this.#options.maxPending;
    if (excess <= 0) return;
    const dropped = this.#queue.splice(0, excess);
    const error = new Error(
      `heartbeat log backlog over ${this.#options.maxPending}; dropped ${excess}`,
    );
    this.#options.onError?.(error);
    for (const pending of dropped) pending.reject(error);
  }

  /** One insert and one notification per row, in append order, as a single statement. */
  async #write(batch: Pending[]): Promise<void> {
    const ms = batch.map((p) => p.receivedAt);
    const repos = batch.map((p) => p.heartbeat.repo);
    const copies = batch.map((p) => p.heartbeat.working_copy_id);
    const bodies = batch.map((p) => JSON.stringify(p.heartbeat));
    await this.#sql`
      WITH inserted AS (
        INSERT INTO heartbeats (received_at, repo, working_copy_id, origin, body)
        SELECT to_timestamp(u.ms / 1000.0), u.repo, u.wc::uuid, ${this.#origin}, u.body::jsonb
        FROM unnest(${ms}::float8[], ${repos}::text[], ${copies}::text[], ${bodies}::text[])
          WITH ORDINALITY AS u(ms, repo, wc, body, ord)
        ORDER BY u.ord
        RETURNING id, received_at, body
      )
      SELECT count(pg_notify(${CHANNEL}, json_build_array(
        ${this.#origin}::text,
        id,
        round(extract(epoch FROM received_at) * 1000),
        CASE WHEN octet_length(body::text) <= ${INLINE_BODY_BYTES} THEN body END
      )::text))
      FROM (SELECT * FROM inserted ORDER BY id) AS ordered`;
  }

  /** Every heartbeat received after `cutoff`, in the order they were appended. */
  async since(cutoff: Date): Promise<LoggedHeartbeat[]> {
    const rows = await this.#db
      .select({ body: heartbeats.body, receivedAt: heartbeats.receivedAt })
      .from(heartbeats)
      .where(gt(heartbeats.receivedAt, cutoff))
      .orderBy(asc(heartbeats.id));
    return rows.map((r) => ({ heartbeat: r.body, receivedAt: r.receivedAt.getTime() }));
  }

  /** Calls `onRemote` for each heartbeat another instance writes; returns an unsubscribe. */
  async listen(
    onRemote: (heartbeat: Heartbeat, receivedAt: number) => void,
  ): Promise<() => Promise<void>> {
    const { unlisten } = await this.#sql.listen(CHANNEL, async (payload) => {
      const [origin, id, receivedAt, inline] = JSON.parse(payload) as [
        string,
        number,
        number,
        Heartbeat | null,
      ];
      if (origin === this.#origin) return;
      if (inline) {
        onRemote(inline, receivedAt);
        return;
      }
      this.fetches++;
      // `received_at` as a window prunes to one partition; `id` picks the row.
      const [row] = await this.#db
        .select({ body: heartbeats.body })
        .from(heartbeats)
        .where(
          and(
            eq(heartbeats.id, id),
            gt(heartbeats.receivedAt, new Date(receivedAt - 1_000)),
            lt(heartbeats.receivedAt, new Date(receivedAt + 1_000)),
          ),
        );
      if (row) onRemote(row.body, receivedAt);
    });
    return unlisten;
  }
}
