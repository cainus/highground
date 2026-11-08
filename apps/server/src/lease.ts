import type postgres from "postgres";

/**
 * Leadership among instances for one job, as a Postgres advisory lock held on a reserved
 * connection: the lock lasts exactly as long as that connection, so a crashed instance
 * loses it at once. Each check confirms the connection is still alive, and steps down if
 * it is not, since the lock went with it.
 */
export class Lease {
  readonly #sql: postgres.Sql;
  readonly #name: string;
  #held: postgres.ReservedSql | undefined;
  #closed = false;

  constructor(sql: postgres.Sql, name: string) {
    this.#sql = sql;
    this.#name = name;
  }

  /** Whether this instance leads, taking the lease when it is free. */
  async held(): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#held) {
      try {
        await this.#held`SELECT 1`;
        return true;
      } catch {
        this.#held.release();
        this.#held = undefined;
      }
    }
    const reserved = await this.#sql.reserve();
    try {
      const [row] = await reserved<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${this.#name})) AS locked`;
      if (row?.locked && !this.#closed) {
        this.#held = reserved;
        return true;
      }
      if (row?.locked) await reserved`SELECT pg_advisory_unlock(hashtext(${this.#name}))`;
    } catch {
      // The database is away; nobody can lead through it now.
    }
    reserved.release();
    return false;
  }

  /** Gives the lease up for good. */
  async close(): Promise<void> {
    this.#closed = true;
    const held = this.#held;
    this.#held = undefined;
    if (!held) return;
    await held`SELECT pg_advisory_unlock(hashtext(${this.#name}))`.catch(() => {});
    held.release();
  }
}
