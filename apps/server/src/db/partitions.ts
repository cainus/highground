import type postgres from "postgres";

const DAY = 86_400_000;
const PREFIX = "heartbeats_";

const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
const nameOf = (start: number) =>
  PREFIX + new Date(start).toISOString().slice(0, 10).replaceAll("-", "");
const startOf = (name: string) => {
  const d = name.slice(PREFIX.length);
  return Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`);
};

/**
 * Keeps the heartbeat log's day partitions (UTC) in shape: creates today and `ahead`
 * days beyond, and drops every partition whose whole day ended more than `keepDays`
 * before `now`. Dropping a partition is instant and leaves nothing for vacuum (ADR
 * 0002). Serialised by an advisory lock, so instances starting together don't race.
 */
export async function maintainPartitions(
  sql: postgres.Sql,
  now: Date,
  { ahead = 3, keepDays = 3 } = {},
): Promise<{ created: string[]; dropped: string[] }> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('highground.partitions'))`;
    const existing = new Set(
      (
        await tx<{ name: string }[]>`
          SELECT c.relname AS name FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname = 'heartbeats'`
      ).map((r) => r.name),
    );

    const created: string[] = [];
    const today = dayStart(now.getTime());
    for (let i = 0; i <= ahead; i++) {
      const start = today + i * DAY;
      const name = nameOf(start);
      if (existing.has(name)) continue;
      const from = new Date(start).toISOString();
      const to = new Date(start + DAY).toISOString();
      await tx.unsafe(
        `CREATE TABLE "${name}" PARTITION OF heartbeats FOR VALUES FROM ('${from}') TO ('${to}')`,
      );
      created.push(name);
    }

    const cutoff = now.getTime() - keepDays * DAY;
    const dropped = [...existing].filter((name) => startOf(name) + DAY <= cutoff).sort();
    for (const name of dropped) await tx.unsafe(`DROP TABLE "${name}"`);
    return { created, dropped };
  });
}
