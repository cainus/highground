import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { inject } from "vitest";
import { migrate } from "../src/db/migrate.ts";

/** A fresh, migrated database; the returned `close` drops it. */
export async function freshDatabase(): Promise<{ url: string; close: () => Promise<void> }> {
  const adminUrl = inject("databaseUrl");
  const name = `hg_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await migrate(url.toString());
  return {
    url: url.toString(),
    close: async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
