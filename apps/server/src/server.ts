import { randomUUID } from "node:crypto";
import { contract } from "@highground/core";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fastify";
import Fastify from "fastify";
import postgres from "postgres";
import { GitHubAuthorizer, type Authorizer } from "./auth.ts";
import { HeartbeatLog } from "./db/heartbeat-log.ts";
import { migrate } from "./db/migrate.ts";
import { maintainPartitions } from "./db/partitions.ts";
import { GitHubApp, type GitHubAppConfig } from "./github.ts";
import { Hub } from "./hub.ts";
import { Mirror, type Remote } from "./mirror.ts";
import { MirrorService } from "./mirror-service.ts";
import { PushedWork } from "./pushed-work.ts";

export interface ServerOptions {
  databaseUrl: string;
  port?: number;
  host?: string;
  graceMs?: number;
  sweepMs?: number;
  /** Called when a heartbeat log write fails; it is retried regardless. */
  onLogError?: (error: unknown) => void;
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
  /** Called when mirroring a repository fails; it is retried on the next round. */
  onMirrorError?: (repo: string, error: unknown) => void;
}

export interface RunningServer {
  url: string;
  hub: Hub;
  /** Present when the server mirrors repositories. */
  mirror?: MirrorService;
  close(): Promise<void>;
}

const HOUR = 3_600_000;

interface Context {
  /** The request's `Authorization` header. */
  authorization?: string | undefined;
}

/** Builds the oRPC router over a hub: one implementation serves REST, SSE and RPC. */
function routerFor(
  hub: Hub,
  auth: Authorizer,
  github: GitHubApp | undefined,
  mirror: MirrorService | undefined,
) {
  const os = implement(contract).$context<Context>();
  return os.router({
    heartbeat: os.heartbeat.handler(async ({ input, context }) => {
      // Pushed work is what the mirror sees on the remote; no client may claim it.
      if (input.kind === "pushed") {
        throw new ORPCError("FORBIDDEN", { message: "only the server publishes pushed work" });
      }
      await auth.authorize(context.authorization, input.repo);
      mirror?.track(input.repo);
      return hub.heartbeat(input);
    }),
    warnings: os.warnings.handler(async ({ input, context }) => {
      await auth.authorize(context.authorization, input.repo);
      return hub.query(input);
    }),
    subscribe: os.subscribe.handler(async ({ input, context, signal }) => {
      await auth.authorize(context.authorization, input.repo);
      return hub.subscribe(input.repo, input.working_copy_id, signal);
    }),
    authConfig: os.authConfig.handler(() => {
      if (!github) throw new ORPCError("NOT_FOUND", { message: "this instance has no GitHub App" });
      return { client_id: github.config.clientId, web_url: github.config.webUrl };
    }),
    refresh: os.refresh.handler(async ({ input }) => {
      if (!github) throw new ORPCError("NOT_FOUND", { message: "this instance has no GitHub App" });
      try {
        return await github.refresh(input.refresh_token);
      } catch (error) {
        throw new ORPCError("UNAUTHORIZED", { message: String(error), cause: error });
      }
    }),
  });
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const github = options.github ? new GitHubApp(options.github) : undefined;
  const auth = options.auth ?? (github && new GitHubAuthorizer(github));
  if (!auth) throw new Error("configure a GitHub App, or pass `auth` (allowAll to run open)");
  await migrate(options.databaseUrl);
  const sql = postgres(options.databaseUrl, { onnotice: () => {} });
  await maintainPartitions(sql, new Date());
  const partitionTimer = setInterval(() => void maintainPartitions(sql, new Date()), HOUR);

  const log = new HeartbeatLog(sql, randomUUID(), {
    onError:
      options.onLogError ??
      ((error) =>
        console.error(
          JSON.stringify({
            level: "error",
            service: "backend",
            msg: "heartbeat log write failed",
            error: String(error),
          }),
        )),
  });
  const logMirrorError =
    options.onMirrorError ??
    ((repo: string, error: unknown) =>
      console.error(
        JSON.stringify({
          level: "warn",
          service: "backend",
          msg: "mirror failed",
          repo,
          error: String(error),
        }),
      ));
  const remote: Remote | undefined =
    options.mirror?.remote ??
    (github && { url: (repo) => github.remoteUrl(repo), config: (repo) => github.gitConfig(repo) });
  if (options.mirror && !remote) throw new Error("a mirror needs a remote or a GitHub App");
  const mirror =
    options.mirror && remote
      ? new Mirror({ dir: options.mirror.dir, remote, onError: logMirrorError })
      : undefined;

  const hub = new Hub(log, {
    graceMs: options.graceMs ?? 10_000,
    sweepMs: options.sweepMs ?? 5_000,
    ...(mirror ? { oracle: mirror } : {}),
  });
  if (mirror) mirror.onLearned = (paths) => hub.refresh(paths);
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

  const router = routerFor(hub, auth, github, mirrorService);
  const openapi = new OpenAPIHandler(router);
  const rpc = new RPCHandler(router);
  // Open SSE streams would otherwise hold `close()` until every client disconnects.
  const app = Fastify({ forceCloseConnections: true });
  app.all("/api/v1/*", async (request, reply) => {
    const { matched } = await openapi.handle(request, reply, {
      prefix: "/api/v1",
      context: { authorization: request.headers.authorization },
    });
    if (!matched) await reply.code(404).send({ error: "not found" });
  });
  app.all("/rpc/*", async (request, reply) => {
    const { matched } = await rpc.handle(request, reply, {
      prefix: "/rpc",
      context: { authorization: request.headers.authorization },
    });
    if (!matched) await reply.code(404).send({ error: "not found" });
  });

  const address = await app.listen({ port: options.port ?? 0, host: options.host ?? "127.0.0.1" });
  return {
    url: address,
    hub,
    ...(mirrorService ? { mirror: mirrorService } : {}),
    close: async () => {
      clearInterval(partitionTimer);
      await mirrorService?.stop();
      await hub.stop();
      await app.close();
      await sql.end();
    },
  };
}
