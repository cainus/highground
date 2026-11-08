import { closeSync, fstatSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
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

/** Where pino writes: anything with a synchronous `write`. */
export interface LineSink {
  write(line: string): unknown;
}

/**
 * The day's log file, held open and written with one synchronous `write` per line, so
 * nothing is lost when the process exits. It moves to the next file at UTC midnight,
 * and starts the file again if it was deleted or replaced while open.
 */
function dailyFile(dir: string, now: () => number): LineSink {
  mkdirSync(dir, { recursive: true });
  let open: { name: string; fd: number; ino: number } | undefined;
  const reopen = (name: string) => {
    if (open) closeSync(open.fd);
    const fd = openSync(join(dir, name), "a");
    open = { name, fd, ino: fstatSync(fd).ino };
    return open;
  };
  return {
    write(line: string) {
      const name = fileFor(now());
      let file = open?.name === name ? open : reopen(name);
      if (statSync(join(dir, name), { throwIfNoEntry: false })?.ino !== file.ino) {
        file = reopen(name);
      }
      writeSync(file.fd, line);
    },
  };
}

function logger(service: Service, now: () => number, sink: LineSink): Log {
  return pino(
    {
      base: { service },
      timestamp: () => `,"time":"${new Date(now()).toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
    },
    sink,
  );
}

/**
 * A pino logger writing one JSON object per line — `time`, `level`, `service`, `msg`
 * and the logged fields — to `highground-YYYY-MM-DD.jsonl` in `dir`, by UTC day. Nothing
 * ever goes to stdout, which an MCP server reserves for protocol messages.
 */
export function createLog({ service, dir, now = Date.now }: LogOptions): Log {
  return logger(service, now, dailyFile(dir, now));
}

export interface ServerLogOptions {
  /** The directory for the daily files; none when unset. */
  dir?: string;
  /** Also write every line here: `process.stdout` in a container. */
  echo?: LineSink;
  now?: () => number;
}

/** The server's two loggers, `backend` and `frontend`, sharing one daily file (PRD §9). */
export function createLogs({ dir, echo, now = Date.now }: ServerLogOptions): {
  backend: Log;
  frontend: Log;
} {
  const sinks = [...(dir === undefined ? [] : [dailyFile(dir, now)]), ...(echo ? [echo] : [])];
  if (sinks.length === 0) throw new Error("createLogs needs a directory or somewhere to echo");
  const sink: LineSink =
    sinks.length === 1
      ? sinks[0]!
      : {
          write(line: string) {
            for (const each of sinks) each.write(line);
          },
        };
  return { backend: logger("backend", now, sink), frontend: logger("frontend", now, sink) };
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
