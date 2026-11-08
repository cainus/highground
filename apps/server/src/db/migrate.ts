import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Applies every pending migration to the database at `url`. */
export async function migrate(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // One connection, so this session lock covers the migrator: instances that start
    // together take turns instead of racing through the same migrations.
    await sql`SELECT pg_advisory_lock(hashtext('highground.migrate'))`;
    await runMigrations(drizzle(sql), { migrationsFolder: MIGRATIONS });
  } finally {
    await sql.end();
  }
}
