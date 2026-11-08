import { randomUUID } from "node:crypto";
import { contract } from "@highground/core";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { implement, onError, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fastify";
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { GitHubAuthorizer, type Authorizer } from "./auth.ts";
import { HeartbeatLog } from "./db/heartbeat-log.ts";
import { migrate } from "./db/migrate.ts";
import { maintainPartitions } from "./db/partitions.ts";
import { GitHubApp, NotInstalledError, type GitHubAppConfig } from "./github.ts";
import { createLogs, type Log } from "@highground/log";
import { createHash } from "node:crypto";
import { and, gt, inArray, isNotNull } from "drizzle-orm";
import { Hub } from "./hub.ts";
import { Mirror, type Remote } from "./mirror.ts";
import { MirrorService } from "./mirror-service.ts";
import { PushedWork } from "./pushed-work.ts";
import { clientStatus, repos } from "./db/schema.ts";
import { history } from "./history.ts";
import { Push, type VapidConfig } from "./push.ts";
import { Recorder } from "./recorder.ts";
import { Sessions, type Session } from "./sessions.ts";
import { parseCookies, registerWebAuth, SESSION_COOKIE } from "./web-auth.ts";
import { registerWebStatic } from "./web-static.ts";

export interface ServerOptions {
  databaseUrl: string;
  port?: number;
  host?: string;
  graceMs?: number;
  /** The least time between two radar updates on a stream; 250 ms by default. */
  radarMs?: number;
  /** The server's and the dashboard's loggers (PRD §9); JSON lines on stderr when unset. */
  log?: { backend: Log; frontend: Log };
  /** Requests slower than this are logged at `warn`; 1 s by default. */
  slowMs?: number;
  /** Web Push for HIGH collisions; needs web sign-in. */
  push?: VapidConfig;
  /** How often the history recorder checks its lease; 5 s by default. */
  recorderMs?: number;
  sweepMs?: number;
  /** The instance's GitHub App: mirror credentials, PR links, and sign-in. */
  github?: GitHubAppConfig;
  /** Mirror repositories for pushed work, translation and speculative merges. */
  mirror?: {
    dir: string;
    /** How often every repository is fetched; 45 s by default. */
    fetchMs?: number;
    /** Where and how to fetch; the GitHub App's installation by default. */
    remote?: Remote;
  };
  /**
   * Who may report and read. Required without a GitHub App, so that running open is a
   * stated choice (`allowAll`); with one, GitHub's own read access decides.
   */
  auth?: Authorizer;
  /** 32 bytes encrypting dashboard sessions' GitHub tokens; web sign-in needs it and a GitHub App. */
  sessionKey?: Buffer;
  /** The built dashboard (`apps/web/dist`) to serve beside the API; none when unset. */
  webDir?: string;
  /** The dashboard's public origin, for OAuth redirects; the request's own when unset. */
  publicUrl?: string;
}

export interface RunningServer {
  url: string;
  hub: Hub;
  /** Present when the server mirrors repositories. */
  mirror?: MirrorService;
  recorder: Recorder;
  close(): Promise<void>;
}

const HOUR = 3_600_000;

interface Context {
  /** The request's `Authorization` header. */
  authorization?: string | undefined;
  /** The request's `Cookie` header. */
  cookie?: string | undefined;
  /** The request's id, on every line it logs. */
  requestId?: string;
}

/** A client's `x-request-id` is kept when it is a short token; anything else gets a new one. */
const REQUEST_ID = /^[\w.:-]{1,128}$/;

/** An error as one log field: its stack when it has one. */
const stackOf = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

interface Deps {
  hub: Hub;
  auth: Authorizer;
  github: GitHubApp | undefined;
  sessions: Sessions | undefined;
  mirror: MirrorService | undefined;
  /** Every tracked repository. */
  trackedRepos: () => Promise<string[]>;
  /** Records a repository the first time a client names it. */
  track: (repo: string) => void;
  sql: postgres.Sql;
  push: Push | undefined;
  frontendLog: Pick<Log, "debug" | "info" | "warn" | "error">;
}

/** Frontend log lines each session may send per minute (PRD §9). */
const LOG_LINES_PER_MINUTE = 100;
/** The largest frontend log batch, in bytes. */
export const LOG_BATCH_BYTES = 64 * 1024;

/** Counts each session's log lines per minute, keeping only a digest of its cookie. */
class LogLimiter {
  readonly #windows = new Map<string, { start: number; lines: number }>();

  /** How many of `wanted` lines this session may still send this minute. */
  take(session: string, wanted: number, now = Date.now()): number {
    const key = createHash("sha256").update(session).digest("base64url");
    let window = this.#windows.get(key);
    if (!window || now - window.start >= 60_000) {
      window = { start: now, lines: 0 };
      this.#windows.set(key, window);
      if (this.#windows.size > 10_000) {
        for (const [k, w] of this.#windows) if (now - w.start >= 60_000) this.#windows.delete(k);
      }
    }
    const granted = Math.max(0, Math.min(wanted, LOG_LINES_PER_MINUTE - window.lines));
    window.lines += granted;
    return granted;
  }
}

const noGitHub = () => new ORPCError("NOT_FOUND", { message: "this instance has no GitHub App" });

/** Builds the oRPC router: one implementation serves REST, SSE and RPC. */
function routerFor(deps: Deps) {
  const { hub, auth, github, sessions, mirror, trackedRepos, sql, push, track } = deps;
  const db = drizzle(sql);
  const limiter = new LogLimiter();
  /** Who is calling: a bearer token (CLI), else a dashboard session. */
  async function caller(context: Context): Promise<{ token?: string; session?: Session }> {
    const bearer = /^Bearer\s+(\S+)$/i.exec(context.authorization ?? "")?.[1];
    if (bearer) return { token: bearer };
    const value = parseCookies(context.cookie).get(SESSION_COOKIE);
    const session = value ? await sessions?.resolve(value) : undefined;
    return session ? { token: session.token, session } : {};
  }
  const authorize = async (context: Context, repo: string) =>
    auth.authorize((await caller(context)).token, repo);

  /** The tracked repositories a token can read; no token at all is refused outright. */
  async function readableRepos(token: string | undefined): Promise<string[]> {
    const all = await trackedRepos();
    const readable = await Promise.all(
      all.map((repo) =>
        auth.authorize(token, repo).then(
          () => true,
          (error: unknown) => {
            if (error instanceof ORPCError && error.code === "UNAUTHORIZED") throw error;
            return false;
          },
        ),
      ),
    );
    return all.filter((_, i) => readable[i]);
  }

  async function installation(repo: string): Promise<"ok" | "missing" | "error" | null> {
    if (!github) return null;
    try {
      await github.installationToken(repo);
      return "ok";
    } catch (error) {
      return error instanceof NotInstalledError ? "missing" : "error";
    }
  }

  const os = implement(contract).$context<Context>();
  return os.router({
    heartbeat: os.heartbeat.handler(async ({ input, context }) => {
      // Pushed work is what the mirror sees on the remote; no client may claim it.
      if (input.kind === "pushed") {
        throw new ORPCError("FORBIDDEN", { message: "only the server publishes pushed work" });
      }
      await authorize(context, input.repo);
      track(input.repo);
      mirror?.track(input.repo);
      return hub.heartbeat(input);
    }),
    warnings: os.warnings.handler(async ({ input, context }) => {
      await authorize(context, input.repo);
      return hub.query(input);
    }),
    subscribe: os.subscribe.handler(async ({ input, context, signal }) => {
      await authorize(context, input.repo);
      return hub.subscribe(input.repo, input.working_copy_id, signal);
    }),
    radar: os.radar.handler(async ({ input, context }) => {
      await authorize(context, input.repo);
      return hub.radar(input.repo);
    }),
    watchRadar: os.watchRadar.handler(async ({ input, context, signal }) => {
      await authorize(context, input.repo);
      return hub.watchRadar(input.repo, signal);
    }),
    history: os.history.handler(async ({ input, context }) => {
      await authorize(context, input.repo);
      return history(sql, input.repo, input.days);
    }),
    pushKey: os.pushKey.handler(() => {
      if (!push) throw new ORPCError("NOT_FOUND", { message: "this instance has no Web Push" });
      return { public_key: push.publicKey };
    }),
    subscribePush: os.subscribePush.handler(async ({ input, context }) => {
      if (!push) throw new ORPCError("NOT_FOUND", { message: "this instance has no Web Push" });
      const { session } = await caller(context);
      if (!session) throw new ORPCError("UNAUTHORIZED", { message: "sign in" });
      await push.subscribe(session.githubId, input);
      return {};
    }),
    unsubscribePush: os.unsubscribePush.handler(async ({ input, context }) => {
      if (!push) throw new ORPCError("NOT_FOUND", { message: "this instance has no Web Push" });
      const { session } = await caller(context);
      if (!session) throw new ORPCError("UNAUTHORIZED", { message: "sign in" });
      await push.unsubscribe(session.githubId, input.endpoint);
      return {};
    }),
    me: os.me.handler(async ({ context }) => {
      if (!sessions) throw new ORPCError("NOT_FOUND", { message: "this instance has no sign-in" });
      const { session } = await caller(context);
      if (!session) throw new ORPCError("UNAUTHORIZED", { message: "sign in" });
      return { login: session.login, avatar_url: session.avatarUrl, emails: session.emails };
    }),
    repos: os.repos.handler(async ({ context }) => ({
      repos: await readableRepos((await caller(context)).token),
    })),
    admin: os.admin.handler(async ({ context }) => {
      const readable = await readableRepos((await caller(context)).token);
      if (readable.length === 0)
        return { github: { configured: !!github }, repos: [], clients: [] };
      const [rows, clients] = await Promise.all([
        db.select().from(repos).where(inArray(repos.repo, readable)).orderBy(repos.repo),
        db
          .select()
          .from(clientStatus)
          .where(
            and(
              inArray(clientStatus.repo, readable),
              isNotNull(clientStatus.degraded),
              gt(clientStatus.reportedAt, new Date(Date.now() - 3_600_000)),
            ),
          )
          .orderBy(clientStatus.reportedAt),
      ]);
      return {
        github: { configured: !!github },
        repos: await Promise.all(
          rows.map(async (row) => ({
            repo: row.repo,
            added_at: row.addedAt.toISOString(),
            last_fetch_at: row.lastFetchAt?.toISOString() ?? null,
            last_error: row.lastError,
            installation: await installation(row.repo),
          })),
        ),
        clients: clients.map((c) => ({
          repo: c.repo,
          working_copy_id: c.workingCopyId,
          client: c.client as "daemon" | "mcp",
          version: c.version,
          route: c.route as "daemon" | "git" | null,
          degraded: c.degraded,
          reported_at: c.reportedAt.toISOString(),
        })),
      };
    }),
    clientStatus: os.clientStatus.handler(async ({ input, context }) => {
      await authorize(context, input.repo);
      track(input.repo);
      const values = {
        workingCopyId: input.working_copy_id,
        client: input.client,
        repo: input.repo,
        version: input.version,
        route: input.route,
        degraded: input.degraded,
        reportedAt: new Date(),
      };
      await db
        .insert(clientStatus)
        .values(values)
        .onConflictDoUpdate({
          target: [clientStatus.workingCopyId, clientStatus.client],
          set: values,
        });
      return {};
    }),
    logs: os.logs.handler(async ({ input, context }) => {
      const { session } = await caller(context);
      const cookie = parseCookies(context.cookie).get(SESSION_COOKIE);
      if (!session || !cookie) throw new ORPCError("UNAUTHORIZED", { message: "sign in" });
      const accepted = limiter.take(cookie, input.lines.length);
      for (const { level, msg, ...fields } of input.lines.slice(0, accepted)) {
        deps.frontendLog[level]({ ...fields, login: session.login }, msg);
      }
      return { accepted };
    }),
    authConfig: os.authConfig.handler(() => {
      if (!github) throw noGitHub();
      return { client_id: github.config.clientId, web_url: github.config.webUrl };
    }),
    refresh: os.refresh.handler(async ({ input }) => {
      if (!github) throw noGitHub();
      try {
        return await github.refresh(input.refresh_token);
      } catch (error) {
        throw new ORPCError("UNAUTHORIZED", { message: String(error), cause: error });
      }
    }),
  });
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const logs = options.log ?? createLogs({ echo: process.stderr });
  const log = logs.backend;
  const github = options.github ? new GitHubApp(options.github) : undefined;
  const auth = options.auth ?? (github && new GitHubAuthorizer(github));
  if (!auth) throw new Error("configure a GitHub App, or pass `auth` (allowAll to run open)");
  await migrate(options.databaseUrl);
  const sql = postgres(options.databaseUrl, { onnotice: () => {} });
  await maintainPartitions(sql, new Date());
  const partitionTimer = setInterval(() => {
    void maintainPartitions(sql, new Date());
    void sessions?.prune().catch(() => {});
  }, HOUR);

  const heartbeats = new HeartbeatLog(sql, randomUUID(), {
    onError: (error) => log.error({ error: stackOf(error) }, "heartbeat log write failed"),
  });
  const logMirrorError = (repo: string, error: unknown) =>
    log.warn({ repo, error: stackOf(error) }, "mirror failed");
  const remote: Remote | undefined =
    options.mirror?.remote ??
    (github && { url: (repo) => github.remoteUrl(repo), config: (repo) => github.gitConfig(repo) });
  if (options.mirror && !remote) throw new Error("a mirror needs a remote or a GitHub App");
  const mirror =
    options.mirror && remote
      ? new Mirror({ dir: options.mirror.dir, remote, onError: logMirrorError })
      : undefined;

  const hub = new Hub(heartbeats, {
    graceMs: options.graceMs ?? 10_000,
    sweepMs: options.sweepMs ?? 5_000,
    ...(options.radarMs ? { radarMs: options.radarMs } : {}),
    ...(mirror ? { oracle: mirror } : {}),
  });
  if (mirror) {
    mirror.onLearned = (paths) => hub.refresh(paths);
    mirror.onHeadChanged = (repo) => hub.refreshRepo(repo);
  }
  await hub.start();

  const mirrorService =
    mirror &&
    new MirrorService({
      sql,
      mirror,
      fetchMs: options.mirror?.fetchMs ?? 45_000,
      onError: logMirrorError,
      publisher: new PushedWork({
        mirror,
        hub,
        onError: logMirrorError,
        ...(github ? { pulls: (repo: string) => github.openPullRequests(repo) } : {}),
      }),
    });
  await mirrorService?.start();

  const sessions =
    github && options.sessionKey
      ? new Sessions({ sql, key: options.sessionKey, github })
      : undefined;
  if (options.push && !sessions)
    throw new Error("Web Push needs web sign-in: a GitHub App and a session key");
  const push =
    options.push && sessions
      ? new Push({
          sql,
          vapid: options.push,
          sessions,
          auth,
          onError: (error) => log.warn({ error: stackOf(error) }, "push failed"),
        })
      : undefined;
  const recorder = new Recorder({
    sql,
    hub,
    ...(push ? { onHigh: (episode) => push.notify(episode) } : {}),
    tickMs: options.recorderMs ?? 5_000,
    onError: (error) => log.error({ error: stackOf(error) }, "collision history write failed"),
  });
  recorder.start();

  const db = drizzle(sql);
  /** Repositories this instance has recorded; a failed insert is retried on the next mention. */
  const known = new Set<string>();
  const router = routerFor({
    hub,
    auth,
    github,
    sessions,
    mirror: mirrorService,
    sql,
    push,
    frontendLog: logs.frontend,
    track: (repo) => {
      if (known.has(repo)) return;
      known.add(repo);
      db.insert(repos)
        .values({ repo })
        .onConflictDoNothing()
        .catch(() => known.delete(repo));
    },
    trackedRepos: async () =>
      (await db.select({ repo: repos.repo }).from(repos).orderBy(repos.repo)).map((r) => r.repo),
  });
  // Failures the caller is meant to see are ORPCErrors under 500; anything else is a bug.
  const logFailure = (error: unknown, { context }: { context: Context }) => {
    if (error instanceof ORPCError && error.status < 500) return;
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    log.error({ requestId: context.requestId, error: stackOf(cause) }, "request failed");
  };
  const openapi = new OpenAPIHandler(router, { interceptors: [onError(logFailure)] });
  const rpc = new RPCHandler(router, { interceptors: [onError(logFailure)] });
  const app = Fastify({
    // Open SSE streams would otherwise hold `close()` until every client disconnects.
    forceCloseConnections: true,
    requestIdHeader: false,
    genReqId: (request) => {
      const given = request.headers["x-request-id"];
      return typeof given === "string" && REQUEST_ID.test(given) ? given : randomUUID();
    },
  });
  const slowMs = options.slowMs ?? 1_000;
  app.addHook("onRequest", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });
  // One line per slow request, none per ordinary one: logging stays off the heartbeat path.
  app.addHook("onResponse", async (request, reply) => {
    const ms = reply.elapsedTime;
    if (ms < slowMs) return;
    if (String(reply.getHeader("content-type") ?? "").startsWith("text/event-stream")) return;
    log.warn(
      {
        requestId: request.id,
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: Math.round(ms),
      },
      "slow request",
    );
  });
  const contextOf = (request: {
    headers: Record<string, string | string[] | undefined>;
    id: string;
  }) => ({
    authorization: request.headers.authorization as string | undefined,
    cookie: request.headers.cookie as string | undefined,
    requestId: request.id,
  });
  if (github && sessions) registerWebAuth(app, { github, sessions, publicUrl: options.publicUrl });
  // The log endpoint's own body limit (PRD §9); a larger batch never reaches the handler.
  for (const [path, handler, prefix] of [
    ["/api/v1/logs", openapi, "/api/v1"],
    ["/rpc/logs", rpc, "/rpc"],
  ] as const) {
    app.post(path, { bodyLimit: LOG_BATCH_BYTES }, async (request, reply) => {
      await handler.handle(request, reply, {
        prefix,
        context: contextOf(request),
      });
    });
  }
  app.all("/api/v1/*", async (request, reply) => {
    const { matched } = await openapi.handle(request, reply, {
      prefix: "/api/v1",
      context: contextOf(request),
    });
    if (!matched) await reply.code(404).send({ error: "not found" });
  });
  app.all("/rpc/*", async (request, reply) => {
    const { matched } = await rpc.handle(request, reply, {
      prefix: "/rpc",
      context: contextOf(request),
    });
    if (!matched) await reply.code(404).send({ error: "not found" });
  });

  // For orchestrators: up means able to serve, which needs Postgres.
  app.get("/healthz", async (_request, reply) => {
    try {
      await Promise.race([
        sql`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timed out after 2 s")), 2_000).unref(),
        ),
      ]);
      return { status: "ok" };
    } catch (error) {
      return reply.code(503).send({ status: "unavailable", reason: String(error) });
    }
  });

  if (options.webDir) {
    await registerWebStatic(app, {
      dir: options.webDir,
      githubWebUrl: options.github?.webUrl ?? "https://github.com",
    });
  }

  const address = await app.listen({ port: options.port ?? 0, host: options.host ?? "127.0.0.1" });
  log.info({ url: address }, "listening");
  return {
    url: address,
    hub,
    ...(mirrorService ? { mirror: mirrorService } : {}),
    recorder,
    close: async () => {
      clearInterval(partitionTimer);
      await recorder.stop();
      await mirrorService?.stop();
      await hub.stop();
      await app.close();
      await sql.end();
    },
  };
}
