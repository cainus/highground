import type { History } from "@highground/core";
import type postgres from "postgres";

const DAY_MS = 86_400_000;
const TOP = 20;

/**
 * How a side is named in history: its author, and the agent or branch when the actor is
 * not the daemon reporting a person's own edits.
 */
const label = (side: "a" | "b") => `
  CASE WHEN ${side}_actor->>'type' = 'cli' AND ${side}_kind = 'live'
       THEN ${side}_author
       ELSE ${side}_author || ' · ' || (${side}_actor->>'id') END`;

/**
 * Collision history for one repository over the last `days` days (PRD §10), by the day
 * each episode started (UTC): episodes per day by severity, the hottest files, the
 * most-colliding actor pairs, and how often agents warned at HIGH changed course.
 */
export async function history(sql: postgres.Sql, repo: string, days: number): Promise<History> {
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const since = new Date(today - (days - 1) * DAY_MS);
  // An ISO string, not a Date: Drizzle replaces the shared client's date serializer.
  const window = sql`repo = ${repo} AND started_at >= ${since.toISOString()}::timestamptz`;

  const [perDay, files, pairs, agents] = await Promise.all([
    sql<{ day: string; severity: "HIGH" | "MEDIUM" | "LOW"; n: number }[]>`
      SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, severity,
             count(*)::int AS n
      FROM collision_events WHERE ${window}
      GROUP BY 1, 2`,
    sql<{ path: string; collisions: number; worst: "HIGH" | "MEDIUM" | "LOW" }[]>`
      SELECT path, count(*)::int AS collisions,
             (array['LOW', 'MEDIUM', 'HIGH'])[max(CASE severity WHEN 'HIGH' THEN 3
                                                                WHEN 'MEDIUM' THEN 2 ELSE 1 END)]
               AS worst
      FROM collision_events WHERE ${window}
      GROUP BY path ORDER BY collisions DESC, path LIMIT ${TOP}`,
    sql<{ a: string; b: string; collisions: number }[]>`
      SELECT least(a, b) AS a, greatest(a, b) AS b, count(*)::int AS collisions
      FROM (SELECT ${sql.unsafe(label("a"))} AS a, ${sql.unsafe(label("b"))} AS b
            FROM collision_events WHERE ${window}) named
      GROUP BY 1, 2 ORDER BY collisions DESC, 1, 2 LIMIT ${TOP}`,
    sql<{ warned: number; changed_course: number }[]>`
      SELECT count(*)::int AS warned, count(*) FILTER (WHERE changed_course)::int AS changed_course
      FROM collision_events
      WHERE ${window} AND severity = 'HIGH'
        AND (a_actor->>'type' = 'agent' OR b_actor->>'type' = 'agent')`,
  ]);

  const counts = new Map<string, History["days"][number]>();
  for (let i = 0; i < days; i++) {
    const day = new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    counts.set(day, { day, HIGH: 0, MEDIUM: 0, LOW: 0 });
  }
  for (const row of perDay) {
    const day = counts.get(row.day);
    if (day) day[row.severity] = row.n;
  }
  return {
    days: [...counts.values()],
    files: [...files],
    pairs: [...pairs],
    agents: agents[0] ?? { warned: 0, changed_course: 0 },
  };
}
