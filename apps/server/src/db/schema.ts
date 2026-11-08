import type { Heartbeat } from "@highground/core";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The append-only heartbeat log (ADR 0002). Partitioned by day on `received_at` — the
 * partitioning is added by hand to the generated migration, since Drizzle cannot
 * declare it; the primary key includes `received_at` because Postgres requires the
 * partition key in every unique constraint.
 */
export const heartbeats = pgTable(
  "heartbeats",
  {
    id: bigint({ mode: "number" }).generatedAlwaysAsIdentity(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    repo: text().notNull(),
    workingCopyId: uuid("working_copy_id").notNull(),
    /** The server instance that accepted it, so instances can skip their own notifications. */
    origin: text().notNull(),
    body: jsonb().$type<Heartbeat>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.receivedAt] }),
    index("heartbeats_received_at").on(t.receivedAt),
  ],
);

/** Repositories the server mirrors, with the outcome of the last fetch. */
export const repos = pgTable("repos", {
  repo: text().primaryKey(),
  addedAt: timestamp("added_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastFetchAt: timestamp("last_fetch_at", { withTimezone: true, mode: "date" }),
  lastError: text("last_error"),
});
