import { randomUUID } from "node:crypto";
import type { HeartbeatInput, WarningsResponse } from "@highground/core";
import { startServer, type RunningServer } from "../../server/src/server.ts";
import { freshDatabase } from "../../server/test/database.ts";
import { makeRepo, run } from "../../../packages/git/test/helpers.ts";

export { cleanupRepos, commitAll, lines, run, write } from "../../../packages/git/test/helpers.ts";

/** Another working copy on the same repo, as seen by the server. */
export const PEER = randomUUID();

export interface WorkingCopy {
  dir: string;
  base: string;
  repo: string;
}

let repos = 0;

/**
 * A working copy of its own repository, `github.com/acme/api-<n>`, so tests never see
 * each other's work, with `origin/main` at its first commit.
 */
export function makeWorkingCopy(files: Record<string, string>): WorkingCopy {
  const dir = makeRepo(files);
  const name = `api-${process.pid}-${++repos}`;
  run(dir, "remote", "add", "origin", `git@github.com:acme/${name}.git`);
  run(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  run(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { dir, base: run(dir, "rev-parse", "HEAD"), repo: `github.com/acme/${name}` };
}

export interface TestServer {
  server: RunningServer;
  url: string;
  close(): Promise<void>;
}

/** A real Highground server on a fresh database. */
export async function testServer(port = 0): Promise<TestServer> {
  const db = await freshDatabase();
  const server = await startServer({ databaseUrl: db.url, port, graceMs: 200, sweepMs: 100 });
  return {
    server,
    url: server.url,
    close: async () => {
      await server.close();
      await db.close();
    },
  };
}

/** What the server tells the peer about `path` lines `start`–`end`. */
export async function peerQuery(
  url: string,
  { repo, base }: WorkingCopy,
  path: string,
  start: number,
  end: number,
): Promise<WarningsResponse> {
  const params = new URLSearchParams({
    repo,
    path,
    start: String(start),
    end: String(end),
    working_copy_id: PEER,
    base_sha: base,
  });
  const res = await fetch(`${url}/api/v1/warnings?${params}`);
  return (await res.json()) as WarningsResponse;
}

/** The peer announces it is changing `path` lines `start`–`end`. */
export async function peerHeartbeat(
  url: string,
  { repo, base }: WorkingCopy,
  path: string,
  ranges: [number, number][],
): Promise<void> {
  const body: HeartbeatInput = {
    repo,
    working_copy_id: PEER,
    actor: { type: "agent", id: "peer-agent" },
    author: "peer@acme.com",
    branch: "peer",
    base_sha: base,
    scope: "partial",
    files: [
      { path, changes: ranges.map((range) => ({ range, digest: null })), intent: "peer work" },
    ],
  };
  const res = await fetch(`${url}/api/v1/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`peer heartbeat failed: ${res.status} ${await res.text()}`);
}

/** Retries `check` until it stops throwing, or rethrows after `timeoutMs`. */
export async function eventually<T>(check: () => Promise<T> | T, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
