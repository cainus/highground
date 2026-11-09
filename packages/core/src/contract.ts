import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { isRange, type Range } from "./ranges.ts";

/** `[start, end]` in base coordinates; `end = start - 1` is an insertion point (PRD §3.1). */
export const RangeSchema = z
  .tuple([z.number().int(), z.number().int()])
  .refine((range) => isRange(range), "invalid range") as unknown as z.ZodType<Range>;

export const ChangeSchema = z.object({
  range: RangeSchema,
  /** SHA-256 hex of the replacing lines; null when unknown, e.g. an announced intent. */
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

/** A POSIX path relative to the repository root that cannot escape it. */
export const RepoPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    "must be relative to the repository root",
  );

export const FileHeartbeatSchema = z.object({
  path: RepoPathSchema,
  whole_file: z.boolean().default(false),
  changes: z.array(ChangeSchema).max(50),
  intent: z.string().max(280).nullable().default(null),
});

/** `host/owner/name`, e.g. `github.com/acme/api`. */
export const RepoSchema = z.string().regex(/^[a-z0-9.-]+\/[\w.-]+\/[\w.-]+$/i);
export const CommitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const ActorSchema = z.object({
  type: z.enum(["human", "agent", "cli"]),
  id: z.string().min(1).max(200),
});

/** Work in a working copy, on a local branch not checked out, or on the shared remote. */
export const KindSchema = z.enum(["live", "parked", "pushed"]);
export const SeveritySchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export const CollisionTypeSchema = z.enum([
  "DIRECT_OVERLAP",
  "DUPLICATE_CHANGE",
  "PROXIMITY_ALERT",
]);

/** A daemon's speculative merge of its work with a pushed branch's head (ADR 0003). */
export const MergeResultSchema = z.object({
  branch: z.string().min(1).max(255),
  head_sha: CommitShaSchema,
  /** Paths the merge conflicts on; empty when it merges cleanly. */
  conflicts: z.array(RepoPathSchema).max(200),
});

export const HeartbeatSchema = z.object({
  repo: RepoSchema,
  working_copy_id: z.uuid(),
  actor: ActorSchema,
  author: z.string().min(1).max(320),
  branch: z.string().min(1).max(255),
  base_sha: CommitShaSchema,
  /** `complete`: the actor's entire state, unlisted files are cleared. `partial`: listed files only. */
  scope: z.enum(["complete", "partial"]),
  files: z.array(FileHeartbeatSchema).max(200),
  ttl_seconds: z.number().int().min(5).max(300).default(60),
  /** Clients send `live` or `parked`; only the server publishes `pushed`. */
  kind: KindSchema.default("live"),
  /** The branch's head commit, for parked and pushed work. */
  head_sha: CommitShaSchema.nullable().default(null),
  /** When the head was committed; dormancy is measured from it. */
  last_commit_at: z.iso.datetime({ offset: true }).nullable().default(null),
  pr_url: z.url().nullable().default(null),
  /** Speculative merges of this work with pushed branches, re-sent with each heartbeat. */
  merges: z.array(MergeResultSchema).max(100).default([]),
});

export const WarningSchema = z.object({
  severity: SeveritySchema,
  type: CollisionTypeSchema,
  path: z.string(),
  /** Null when the change is to the whole file. */
  your_lines: RangeSchema.nullable(),
  peer: z.object({
    working_copy_id: z.string(),
    actor: ActorSchema,
    author: z.string(),
    kind: KindSchema,
    branch: z.string(),
    /** The peer's head commit when it is parked or pushed, for a speculative merge. */
    head_sha: z.string().nullable(),
    pr_url: z.string().nullable(),
    lines: RangeSchema.nullable(),
    intent: z.string().nullable(),
    last_heartbeat_seconds_ago: z.number().int(),
  }),
  approximate: z.boolean(),
  /** Set once a speculative merge has run; null until then. */
  confirmed: z.boolean().nullable(),
});

export const WarningsResponseSchema = z.object({
  has_collisions: z.boolean(),
  warnings: z.array(WarningSchema),
});

export const WarningsQuerySchema = z
  .object({
    repo: RepoSchema,
    path: RepoPathSchema,
    start: z.coerce.number().int(),
    end: z.coerce.number().int(),
    working_copy_id: z.uuid(),
    base_sha: CommitShaSchema,
    /** The asker's branch: its own pushed copy is not a peer. */
    branch: z.string().min(1).max(255).optional(),
  })
  .refine((query) => isRange([query.start, query.end]), "invalid range");

export const SubscribeInputSchema = z.object({
  repo: RepoSchema,
  working_copy_id: z.uuid(),
});

export const CollisionEventSchema = z.object({
  event: z.enum(["collision_started", "collision_ended"]),
  warning: WarningSchema,
});

export const AuthConfigSchema = z.object({
  /** The instance's GitHub App, for the device flow. */
  client_id: z.string(),
  /** Where the device flow runs: `https://github.com`, or a GitHub Enterprise Server. */
  web_url: z.url(),
});

export const RefreshInputSchema = z.object({ refresh_token: z.string().min(1).max(1024) });

/** GitHub's own token response, passed through. */
export const UserTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().int().optional(),
  refresh_token_expires_in: z.number().int().optional(),
});

/** One actor's work on one file, as the radar shows it. */
export const RadarWorkSchema = z.object({
  /** Stable while the actor works on the file: names it in `collisions`. */
  id: z.string(),
  working_copy_id: z.uuid(),
  actor: ActorSchema,
  author: z.string(),
  kind: KindSchema,
  branch: z.string(),
  head_sha: CommitShaSchema.nullable(),
  pr_url: z.url().nullable(),
  /** The base the work was reported against. */
  base_sha: CommitShaSchema,
  whole_file: z.boolean(),
  /** In the file's display base; untranslated, and `approximate`, when that is not yet known. */
  lines: z.array(RangeSchema),
  approximate: z.boolean(),
  intent: z.string().nullable(),
  last_heartbeat_seconds_ago: z.number().int(),
});

/** A colliding pair of work on one file, judged from whichever side sees it worse. */
export const RadarCollisionSchema = z.object({
  a: z.string(),
  b: z.string(),
  type: CollisionTypeSchema,
  severity: SeveritySchema,
  confirmed: z.boolean().nullable(),
  approximate: z.boolean(),
});

export const RadarFileSchema = z.object({
  path: RepoPathSchema,
  /** The commit every `lines` on this file is shown in. */
  base_sha: CommitShaSchema,
  work: z.array(RadarWorkSchema),
  collisions: z.array(RadarCollisionSchema),
});

/** Whether anyone is reporting a repository, so an empty radar can say why it is empty. */
export const ReportingSchema = z.object({
  /** Working copies with a live heartbeat inside its ttl, idle ones included. */
  working_copies: z.number().int().nonnegative(),
  /** The latest heartbeat of any kind this server has seen since it started; null if none. */
  last_heartbeat_at: z.iso.datetime().nullable(),
});

export const RadarSchema = z.object({
  repo: RepoSchema,
  /** Worst collisions first. */
  files: z.array(RadarFileSchema),
  reporting: ReportingSchema,
});

export const RepoInputSchema = z.object({ repo: RepoSchema });

export const HistoryInputSchema = z.object({
  repo: RepoSchema,
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const HistorySchema = z.object({
  /** One row per day in the window, oldest first, by the day episodes started (UTC). */
  days: z.array(
    z.object({
      day: z.iso.date(),
      HIGH: z.number().int(),
      MEDIUM: z.number().int(),
      LOW: z.number().int(),
    }),
  ),
  files: z.array(
    z.object({ path: RepoPathSchema, collisions: z.number().int(), worst: SeveritySchema }),
  ),
  /** Actor pairs by name, each pair once in a fixed order. */
  pairs: z.array(z.object({ a: z.string(), b: z.string(), collisions: z.number().int() })),
  /** Episodes at HIGH with an agent on one side, and how many the agent ended itself. */
  agents: z.object({ warned: z.number().int(), changed_course: z.number().int() }),
});

export const PushSubscriptionSchema = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({ p256dh: z.string().max(256), auth: z.string().max(64) }),
});

export const ClientStatusSchema = z.object({
  repo: RepoSchema,
  working_copy_id: z.uuid(),
  client: z.enum(["daemon", "mcp"]),
  version: z.string().max(64),
  /** How the client reached the server: through the daemon, or running git itself. */
  route: z.enum(["daemon", "git"]).nullable(),
  /** Why the client is, or just was, not working as it should; null when it is. */
  degraded: z.string().max(500).nullable(),
});

export const AdminSchema = z.object({
  github: z.object({ configured: z.boolean() }),
  repos: z.array(
    z.object({
      repo: RepoSchema,
      added_at: z.iso.datetime({ offset: true }),
      last_fetch_at: z.iso.datetime({ offset: true }).nullable(),
      last_error: z.string().nullable(),
      /** Whether the App can mint a token for the mirror; null without an App. */
      installation: z.enum(["ok", "missing", "error"]).nullable(),
    }),
  ),
  /** Clients that reported trouble in the last hour. */
  clients: z.array(ClientStatusSchema.extend({ reported_at: z.iso.datetime({ offset: true }) })),
});

export const LogLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        time: z.iso.datetime({ offset: true }),
        level: z.enum(["debug", "info", "warn", "error"]),
        msg: z.string().max(4000),
        request_id: z.string().max(64).optional(),
        url: z.string().max(2048).optional(),
        stack: z.string().max(16_000).optional(),
      }),
    )
    .max(100),
});

export const MeSchema = z.object({
  login: z.string(),
  avatar_url: z.url(),
  /** Verified emails: work whose author is one of these is the viewer's own. */
  emails: z.array(z.string()),
});

export const ReposSchema = z.object({ repos: z.array(RepoSchema) });

export const contract = {
  heartbeat: oc
    .route({ method: "POST", path: "/heartbeat" })
    .input(HeartbeatSchema)
    .output(WarningsResponseSchema),
  warnings: oc
    .route({ method: "GET", path: "/warnings" })
    .input(WarningsQuerySchema)
    .output(WarningsResponseSchema),
  subscribe: oc
    .route({ method: "GET", path: "/subscribe" })
    .input(SubscribeInputSchema)
    .output(eventIterator(CollisionEventSchema)),
  /** Every file in a repository with active work, and its collisions. */
  radar: oc.route({ method: "GET", path: "/radar" }).input(RepoInputSchema).output(RadarSchema),
  /** The radar now, then again whenever it changes, at most four times a second. */
  watchRadar: oc
    .route({ method: "GET", path: "/radar/stream" })
    .input(RepoInputSchema)
    .output(eventIterator(RadarSchema)),
  /** Collisions over time in one repository. */
  history: oc
    .route({ method: "GET", path: "/history" })
    .input(HistoryInputSchema)
    .output(HistorySchema),
  /** The VAPID public key a browser subscribes to Web Push with; 404 without push. */
  pushKey: oc
    .route({ method: "GET", path: "/push/key" })
    .output(z.object({ public_key: z.string() })),
  /** Sends the signed-in user's HIGH collisions to this browser. */
  subscribePush: oc
    .route({ method: "POST", path: "/push/subscribe" })
    .input(PushSubscriptionSchema)
    .output(z.object({})),
  unsubscribePush: oc
    .route({ method: "POST", path: "/push/unsubscribe" })
    .input(PushSubscriptionSchema.pick({ endpoint: true }))
    .output(z.object({})),
  /** Mirror, GitHub App and client health for the caller's repositories. */
  admin: oc.route({ method: "GET", path: "/admin" }).output(AdminSchema),
  /** A client reporting its own health. */
  clientStatus: oc
    .route({ method: "POST", path: "/client-status" })
    .input(ClientStatusSchema)
    .output(z.object({})),
  /** The dashboard's own log lines (PRD §9); at most 64 KB a batch, 100 lines a minute. */
  logs: oc
    .route({ method: "POST", path: "/logs" })
    .input(LogLinesSchema)
    .output(z.object({ accepted: z.number().int() })),
  /** The signed-in dashboard user. */
  me: oc.route({ method: "GET", path: "/me" }).output(MeSchema),
  /** The tracked repositories the caller can read. */
  repos: oc.route({ method: "GET", path: "/repos" }).output(ReposSchema),
  /** How a CLI signs in to this instance; 404 when it has no GitHub App. */
  authConfig: oc.route({ method: "GET", path: "/auth/github" }).output(AuthConfigSchema),
  /** Exchanges a refresh token; the App's client secret stays on the server. */
  refresh: oc
    .route({ method: "POST", path: "/auth/refresh" })
    .input(RefreshInputSchema)
    .output(UserTokensSchema),
};

export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type HeartbeatInput = z.input<typeof HeartbeatSchema>;
export type FileHeartbeat = z.infer<typeof FileHeartbeatSchema>;
export type Actor = z.infer<typeof ActorSchema>;
export type Warning = z.infer<typeof WarningSchema>;
export type WarningsResponse = z.infer<typeof WarningsResponseSchema>;
export type WarningsQuery = z.infer<typeof WarningsQuerySchema>;
export type CollisionEvent = z.infer<typeof CollisionEventSchema>;
export type Kind = z.infer<typeof KindSchema>;
export type MergeResult = z.infer<typeof MergeResultSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type UserTokens = z.infer<typeof UserTokensSchema>;
export type Me = z.infer<typeof MeSchema>;
export type Radar = z.infer<typeof RadarSchema>;
export type RadarFile = z.infer<typeof RadarFileSchema>;
export type Reporting = z.infer<typeof ReportingSchema>;
export type RadarWork = z.infer<typeof RadarWorkSchema>;
export type RadarCollision = z.infer<typeof RadarCollisionSchema>;
export type History = z.infer<typeof HistorySchema>;
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;
export type Admin = z.infer<typeof AdminSchema>;
export type ClientStatus = z.infer<typeof ClientStatusSchema>;
export type LogLines = z.infer<typeof LogLinesSchema>;
