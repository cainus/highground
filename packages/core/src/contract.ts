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
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
  type: z.enum(["DIRECT_OVERLAP", "DUPLICATE_CHANGE", "PROXIMITY_ALERT"]),
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
