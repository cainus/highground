/**
 * Runs a server in its own process for the benchmark. Prints its URL on stdout, and on
 * SIGTERM prints one JSON line of what it measured itself since SIGUSR2: CPU, event-loop
 * delay, and each request's time from arrival to the end of its response.
 */
import { subscribe } from "node:diagnostics_channel";
import type { IncomingMessage } from "node:http";
import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { allowAll } from "../src/auth.ts";
import { startServer } from "../src/server.ts";

const loop = monitorEventLoopDelay({ resolution: 1 });
const handled = { heartbeat: createHistogram(), warnings: createHistogram() };
const arrived = new WeakMap<IncomingMessage, bigint>();
const kind = (url = "") =>
  url.startsWith("/api/v1/heartbeat")
    ? "heartbeat"
    : url.startsWith("/api/v1/warnings")
      ? "warnings"
      : undefined;

subscribe("http.server.request.start", (message) => {
  arrived.set((message as { request: IncomingMessage }).request, process.hrtime.bigint());
});
subscribe("http.server.response.finish", (message) => {
  const { request } = message as { request: IncomingMessage };
  const at = arrived.get(request);
  const k = kind(request.url);
  if (at !== undefined && k) handled[k].record(process.hrtime.bigint() - at);
});

let cpuStart: NodeJS.CpuUsage | undefined;
process.on("SIGUSR2", () => {
  cpuStart = process.cpuUsage();
  loop.reset();
  handled.heartbeat.reset();
  handled.warnings.reset();
});
loop.enable();

const server = await startServer({
  databaseUrl: process.env.DATABASE_URL!,
  port: 0,
  auth: allowAll,
});
console.log(server.url);

const summary = (h: { percentile(p: number): number; max: number }) => ({
  p50: h.percentile(50) / 1e6,
  p99: h.percentile(99) / 1e6,
  max: h.max / 1e6,
});
process.on("SIGTERM", () => {
  const cpu = process.cpuUsage(cpuStart);
  console.log(
    JSON.stringify({
      cpuMs: (cpu.user + cpu.system) / 1000,
      loop: summary(loop),
      heartbeat: summary(handled.heartbeat),
      warnings: summary(handled.warnings),
    }),
  );
  void server.close().then(() => process.exit(0));
});
