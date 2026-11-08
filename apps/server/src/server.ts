import { randomUUID } from "node:crypto";
import { contract } from "@highground/core";
import { OpenAPIHandler } from "@orpc/openapi/fastify";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fastify";
import Fastify from "fastify";
import postgres from "postgres";
import { HeartbeatLog } from "./db/heartbeat-log.ts";
import { migrate } from "./db/migrate.ts";
import { maintainPartitions } from "./db/partitions.ts";
import { Hub } from "./hub.ts";

export interface ServerOptions {
  databaseUrl: string;
  port?: number;
  host?: string;
  graceMs?: number;
  sweepMs?: number;
  /** Called when a heartbeat log write fails; it is retried regardless. */
  onLogError?: (error: unknown) => void;
}

export interface RunningServer {
  url: string;
  hub: Hub;
  close(): Promise<void>;
}

const HOUR = 3_600_000;

/** Builds the oRPC router over a hub: one implementation serves REST, SSE and RPC. */
function routerFor(hub: Hub) {
  const os = implement(contract);
  return os.router({
    heartbeat: os.heartbeat.handler(({ input }) => hub.heartbeat(input)),
    warnings: os.warnings.handler(({ input }) => hub.query(input)),
    subscribe: os.subscribe.handler(({ input, signal }) =>
      hub.subscribe(input.repo, input.working_copy_id, signal),
    ),
  });
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
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
  const hub = new Hub(log, {
    graceMs: options.graceMs ?? 10_000,
    sweepMs: options.sweepMs ?? 5_000,
  });
  await hub.start();

  const router = routerFor(hub);
  const openapi = new OpenAPIHandler(router);
  const rpc = new RPCHandler(router);
  // Open SSE streams would otherwise hold `close()` until every client disconnects.
  const app = Fastify({ forceCloseConnections: true });
  app.all("/api/v1/*", async (request, reply) => {
    const { matched } = await openapi.handle(request, reply, { prefix: "/api/v1", context: {} });
    if (!matched) await reply.code(404).send({ error: "not found" });
  });
  app.all("/rpc/*", async (request, reply) => {
    const { matched } = await rpc.handle(request, reply, { prefix: "/rpc", context: {} });
    if (!matched) await reply.code(404).send({ error: "not found" });
  });

  const address = await app.listen({ port: options.port ?? 0, host: options.host ?? "127.0.0.1" });
  return {
    url: address,
    hub,
    close: async () => {
      clearInterval(partitionTimer);
      await hub.stop();
      await app.close();
      await sql.end();
    },
  };
}
