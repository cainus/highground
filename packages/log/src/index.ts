import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";

const DAY = 86_400_000;
const KEEP_MS = 72 * 3_600_000;
const FILE = /^highground-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type Service = "backend" | "frontend" | "daemon" | "mcp";

export interface LogOptions {
  service: Service;
  dir: string;
  now?: () => number;
}

export type Log = pino.Logger;

/** The CLI's log directory: `HIGHGROUND_LOG_DIR`, else `~/.local/state/highground/logs`. */
export function cliLogDir(): string {
  return process.env.HIGHGROUND_LOG_DIR ?? join(homedir(), ".local/state/highground/logs");
}

const fileFor = (time: number) => `highground-${new Date(time).toISOString().slice(0, 10)}.jsonl`;

/**
 * A pino logger writing one JSON object per line — `time`, `level`, `service`, `msg`
 * and the logged fields — to `highground-YYYY-MM-DD.jsonl` in `dir`, by UTC day. Writes
 * are synchronous appends, so nothing is lost when a process exits, and nothing ever
 * goes to stdout, which an MCP server reserves for protocol messages.
 */
export function createLog({ service, dir, now = Date.now }: LogOptions): Log {
  mkdirSync(dir, { recursive: true });
  const destination = {
    write(line: string) {
      appendFileSync(join(dir, fileFor(now())), line);
    },
  };
  return pino(
    {
      base: { service },
      timestamp: () => `,"time":"${new Date(now()).toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}

/** Deletes log files whose day ended more than 72 h before `now`; returns their names. */
export async function pruneLogs(dir: string, now: number): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const stale = names.filter((name) => {
    const day = FILE.exec(name)?.[1];
    return day !== undefined && Date.parse(`${day}T00:00:00Z`) + DAY < now - KEEP_MS;
  });
  await Promise.all(stale.map((name) => rm(join(dir, name), { force: true })));
  return stale;
}

/** Prunes now and hourly; the timer never keeps the process alive. Returns a stop function. */
export function prunePeriodically(dir: string, now: () => number = Date.now): () => void {
  void pruneLogs(dir, now());
  const timer = setInterval(() => void pruneLogs(dir, now()), 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
