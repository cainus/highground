/**
 * Latency at the PRD's scale (§12): 100 working copies × 3 actors heartbeating every 2 s
 * (150/s) while clients ask 100 warning queries/s, arriving evenly. Fails if either p99,
 * as the client sees it, reaches 10 ms.
 *
 * Prints three views so a miss can be placed: a do-nothing server under the same load
 * (what the machine and Node's HTTP stack cost), the client's view of the real server,
 * and the server's own timing of each request from arrival to response.
 * Uses DATABASE_URL, or starts a throwaway Postgres.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { load, ms, type Stream } from "./load.ts";

const WORKING_COPIES = 100;
const ACTORS_PER_COPY = 3;
const PATHS = 40;
const SECONDS = Number(process.env.BENCH_SECONDS ?? 15);
const P99_LIMIT_MS = 10;
const REPO = "github.com/acme/api";
const SHA = "a".repeat(40);

const copies = Array.from({ length: WORKING_COPIES }, () => randomUUID());
const actors = copies.flatMap((wc) =>
  Array.from({ length: ACTORS_PER_COPY }, (_, i) => ({
    wc,
    actor: { type: i === 0 ? "cli" : "agent", id: `actor-${i}` },
  })),
);
let tick = 0;
const heartbeatBody = () => {
  const { wc, actor } = actors[tick++ % actors.length]!;
  const files = Array.from({ length: 5 }, (_, i) => {
    const start = 1 + ((tick * 7 + i * 37) % 400);
    return {
      path: `src/f${(tick + i * 3) % PATHS}.ts`,
      changes: [{ range: [start, start + 10], digest: null }],
    };
  });
  return JSON.stringify({
    repo: REPO,
    working_copy_id: wc,
    actor,
    author: "dev@acme.com",
    branch: "b",
    base_sha: SHA,
    scope: "complete",
    files,
  });
};
let q = 0;
const queryPath = () => {
  q++;
  const start = 1 + ((q * 13) % 400);
  return `/api/v1/warnings?repo=${encodeURIComponent(REPO)}&path=src/f${q % PATHS}.ts&start=${start}&end=${start + 20}&working_copy_id=${copies[q % copies.length]}&base_sha=${SHA}`;
};
const streams: Stream[] = [
  {
    name: "heartbeat",
    perSecond: (WORKING_COPIES * ACTORS_PER_COPY) / 2,
    next: () => ({ method: "POST", path: "/api/v1/heartbeat", body: heartbeatBody() }),
  },
  { name: "warnings", perSecond: 100, next: () => ({ method: "GET", path: queryPath() }) },
];

/** Starts a bench server script in its own process, so it does not share the load's event loop. */
async function spawnServer(script: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  const url = (await lines.next()).value as string;
  return { child, url, lines };
}

const line = (name: string, h: Parameters<typeof ms>[0], extra = "") =>
  `  ${name.padEnd(9)}  p50 ${ms(h, 50).padStart(5)} ms  p99 ${ms(h, 99).padStart(5)} ms  max ${ms(h).padStart(5)} ms${extra}`;

console.log(`do-nothing server, same load (${SECONDS} s)`);
const noop = await spawnServer("./noop.ts");
for (const r of await load(noop.url, streams, SECONDS)) console.log(line(r.name, r.latency));
noop.child.kill("SIGTERM");
await once(noop.child, "exit");

const container = process.env.DATABASE_URL
  ? undefined
  : await new PostgreSqlContainer("postgres:18-alpine").start();
const server = await spawnServer("./serve.ts", {
  DATABASE_URL: process.env.DATABASE_URL ?? container!.getConnectionUri(),
});

// Seed every actor once so queries run against a full index.
for (let i = 0; i < actors.length; i++) {
  await fetch(`${server.url}/api/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: heartbeatBody(),
  });
}

server.child.kill("SIGUSR2");
const results = await load(server.url, streams, SECONDS);
server.child.kill("SIGTERM");
const measured = JSON.parse((await server.lines.next()).value as string);
await once(server.child, "exit");
await container?.stop();

let failed = false;
console.log(`highground, as the client sees it`);
for (const r of results) {
  const count = r.latency.count + r.errors;
  console.log(line(r.name, r.latency, `  ${count} requests  errors ${r.errors}`));
  if (r.latency.percentile(99) / 1e6 >= P99_LIMIT_MS || r.errors > 0) failed = true;
}
console.log(`highground, as the server times it (arrival to response)`);
const asHistogram = (s: { p50: number; p99: number; max: number }) => ({
  percentile: (p: number) => (p === 50 ? s.p50 : s.p99) * 1e6,
  max: s.max * 1e6,
});
console.log(line("heartbeat", asHistogram(measured.heartbeat)));
console.log(line("warnings", asHistogram(measured.warnings)));
console.log(line("loop lag", asHistogram(measured.loop)));
console.log(`  server cpu  ${Math.round(measured.cpuMs)} ms over ${SECONDS} s`);
process.exit(failed ? 1 : 0);
