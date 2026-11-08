import type { Actor, Heartbeat } from "@highground/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/**
 * Dashboard sessions. The cookie's value is never stored, only its SHA-256; GitHub's
 * tokens are AES-256-GCM ciphertext bound to that hash.
 */
export const sessions = pgTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).notNull(),
  login: text().notNull(),
  avatarUrl: text("avatar_url").notNull(),
  /** The user's verified emails: whose work is "mine". */
  emails: jsonb().$type<string[]>().notNull(),
  token: bytea().notNull(),
  refreshToken: bytea("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true, mode: "date" }),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true, mode: "date" }),
  /** While set and in the future, one request is refreshing the token; others keep the old one. */
  refreshingUntil: timestamp("refreshing_until", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

/**
 * One row per collision episode (plan 05): a pair of actors' work colliding on one path,
 * from the first moment to the last, with the strongest verdict it reached. One open
 * episode per pair. Kept a year after it ends.
 */
export const collisionEvents = pgTable(
  "collision_events",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** The repository, path and the two sides' radar ids, hashed. */
    pairKey: text("pair_key").notNull(),
    repo: text().notNull(),
    path: text().notNull(),
    aId: text("a_id").notNull(),
    aWorkingCopyId: uuid("a_working_copy_id").notNull(),
    aActor: jsonb("a_actor").$type<Actor>().notNull(),
    aAuthor: text("a_author").notNull(),
    aKind: text("a_kind").notNull(),
    bId: text("b_id").notNull(),
    bWorkingCopyId: uuid("b_working_copy_id").notNull(),
    bActor: jsonb("b_actor").$type<Actor>().notNull(),
    bAuthor: text("b_author").notNull(),
    bKind: text("b_kind").notNull(),
    type: text().notNull(),
    severity: text().notNull(),
    confirmed: boolean(),
    approximate: boolean().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "date" }),
    /** `a` or `b`: that side's own heartbeat ended it; `expired`: neither did. */
    endedBy: text("ended_by"),
    /** An agent side ended it with its own heartbeat: it changed course after the warning. */
    changedCourse: boolean("changed_course").notNull().default(false),
    /** When the episode's HIGH warning was pushed; set once. */
    notifiedAt: timestamp("notified_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("collision_events_open_pair")
      .on(t.pairKey)
      .where(sql`${t.endedAt} IS NULL`),
    index("collision_events_repo_started").on(t.repo, t.startedAt),
    index("collision_events_ended").on(t.endedAt),
  ],
);

/** Browsers that asked for Web Push, per GitHub user. */
export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text().primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).notNull(),
  p256dh: text().notNull(),
  auth: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** What each client last said about its own health (plan 05), for the admin page. */
export const clientStatus = pgTable(
  "client_status",
  {
    workingCopyId: uuid("working_copy_id").notNull(),
    client: text().notNull(),
    repo: text().notNull(),
    version: text().notNull(),
    route: text(),
    degraded: text(),
    reportedAt: timestamp("reported_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workingCopyId, t.client] }),
    index("client_status_reported").on(t.reportedAt),
  ],
);
