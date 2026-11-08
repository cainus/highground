/**
 * Latency at the PRD's scale (§12): 100 working copies × 3 actors heartbeating every 2 s
 * (150/s) while clients ask 100 warning queries/s. Fails if either p99 reaches 10 ms.
 * Uses DATABASE_URL, or starts a throwaway Postgres.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import autocannon from "autocannon";

const WORKING_COPIES = 100;
const ACTORS_PER_COPY = 3;
const PATHS = 40;
const SECONDS = Number(process.env.BENCH_SECONDS ?? 15);
const P99_LIMIT_MS = 10;
const REPO = "github.com/acme/api";
const SHA = "a".repeat(40);

const container = process.env.DATABASE_URL
  ? undefined
  : await new PostgreSqlContainer("postgres:18-alpine").start();
// The server runs in its own process, so the load generator does not share its event loop.
const child = spawn(process.execPath, [new URL("./serve.ts", import.meta.url).pathname], {
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? container!.getConnectionUri() },
  stdio: ["ignore", "pipe", "inherit"],
});
const [firstLine] = (await once(child.stdout!, "data")) as [Buffer];
const server = { url: firstLine.toString().trim() };

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

// Seed every actor once so queries run against a full index.
for (let i = 0; i < actors.length; i++) {
  await fetch(`${server.url}/api/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: heartbeatBody(),
  });
}

child.kill("SIGUSR2");
const run = (opts: autocannon.Options) =>
  autocannon({ url: server.url, duration: SECONDS, connections: 20, ...opts });
const [heartbeats, queries] = await Promise.all([
  run({
    overallRate: (WORKING_COPIES * ACTORS_PER_COPY) / 2,
    requests: [
      {
        method: "POST",
        path: "/api/v1/heartbeat",
        headers: { "content-type": "application/json" },
        setupRequest: (r) => ({ ...r, body: heartbeatBody() }),
      },
    ],
  }),
  run({
    overallRate: 100,
    requests: [{ method: "GET", setupRequest: (r) => ({ ...r, path: queryPath() }) }],
  }),
]);

let failed = false;
for (const [name, r] of [
  ["heartbeat", heartbeats],
  ["warnings", queries],
] as const) {
  const errors = r.errors + r.non2xx;
  console.log(
    `${name.padEnd(9)} ${r.requests.total} requests  p50 ${r.latency.p50} ms  p99 ${r.latency.p99} ms  max ${r.latency.max} ms  errors ${errors}`,
  );
  if (r.latency.p99 >= P99_LIMIT_MS || errors > 0) failed = true;
}
child.kill("SIGTERM");
await once(child, "exit");
await container?.stop();
process.exit(failed ? 1 : 0);
