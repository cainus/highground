/**
 * The Highground server as a program: configured from the environment (plan 06),
 * logging to daily files and optionally stdout, and stopping cleanly on SIGTERM.
 */
import { createLogs, prunePeriodically } from "@highground/log";
import { configFromEnv, type Config } from "./config.ts";
import { startServer, type RunningServer } from "./server.ts";

let config: Config;
try {
  config = configFromEnv(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const logs = createLogs({
  dir: config.log.dir,
  ...(config.log.stdout ? { echo: process.stdout } : {}),
});
const log = logs.backend;
prunePeriodically(config.log.dir);

const stackOf = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);
const die = (msg: string) => (error: unknown) => {
  log.fatal({ error: stackOf(error) }, msg);
  process.exit(1);
};
process.on("uncaughtException", die("uncaught exception"));
process.on("unhandledRejection", die("unhandled rejection"));

let server: RunningServer;
try {
  server = await startServer({ ...config.server, log: logs });
} catch (error) {
  die("could not start")(error);
  throw error;
}

let closing = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  log.info({ signal }, "shutting down");
  // close() writes what is still pending: heartbeats, collision history.
  server.close().then(() => {
    log.info("stopped");
    process.exit(0);
  }, die("could not stop cleanly"));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
