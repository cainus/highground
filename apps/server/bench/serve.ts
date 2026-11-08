/** Runs a server in its own process for the benchmark; prints its URL on stdout. */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { startServer } from "../src/server.ts";
const loop = monitorEventLoopDelay({ resolution: 1 });
let cpuStart: NodeJS.CpuUsage | undefined;
process.on("SIGUSR2", () => {
  cpuStart = process.cpuUsage();
});
loop.enable();

const server = await startServer({ databaseUrl: process.env.DATABASE_URL!, port: 0 });
console.log(server.url);
process.on("SIGTERM", () => {
  const cpu = process.cpuUsage(cpuStart);
  console.error(`server cpu during load: ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms`);
  console.error(
    `event loop delay: p50=${(loop.percentile(50) / 1e6).toFixed(2)} p99=${(loop.percentile(99) / 1e6).toFixed(2)} max=${(loop.max / 1e6).toFixed(2)} ms`,
  );
  void server.close().then(() => process.exit(0));
});
