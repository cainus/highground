import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLog, pruneLogs } from "../src/index.ts";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "highground-log-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const read = (dir: string, file: string) =>
  readFileSync(join(dir, file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("createLog", () => {
  it("writes one JSON object per line with time, level, service and msg", () => {
    const dir = scratch();
    const log = createLog({
      service: "daemon",
      dir,
      now: () => Date.parse("2026-11-08T10:00:00Z"),
    });
    log.info({ path: "a.ts" }, "heartbeat sent");

    expect(read(dir, "highground-2026-11-08.jsonl")).toEqual([
      {
        time: "2026-11-08T10:00:00.000Z",
        level: "info",
        service: "daemon",
        msg: "heartbeat sent",
        path: "a.ts",
      },
    ]);
  });

  it("moves to the next day's file at UTC midnight", () => {
    const dir = scratch();
    let now = Date.parse("2026-11-08T23:59:59Z");
    const log = createLog({ service: "mcp", dir, now: () => now });
    log.info("before");
    now += 2_000;
    log.info("after");

    expect(readdirSync(dir).sort()).toEqual([
      "highground-2026-11-08.jsonl",
      "highground-2026-11-09.jsonl",
    ]);
  });

  it("creates its directory", () => {
    const dir = join(scratch(), "nested/logs");
    const log = createLog({ service: "mcp", dir, now: () => 0 });
    log.warn("x");
    expect(readdirSync(dir)).toEqual(["highground-1970-01-01.jsonl"]);
  });
});

describe("pruneLogs", () => {
  it("deletes the files whose last possible line is more than 72 h old, and nothing else", async () => {
    const dir = scratch();
    for (const name of [
      "highground-2026-11-04.jsonl",
      "highground-2026-11-05.jsonl",
      "highground-2026-11-06.jsonl",
      "highground-2026-11-08.jsonl",
      "notes.txt",
    ]) {
      writeFileSync(join(dir, name), "");
    }
    // 72 h before this is 2026-11-05T12:00Z, inside the 5th, so the 5th is kept.
    const deleted = await pruneLogs(dir, Date.parse("2026-11-08T12:00:00Z"));

    expect(deleted).toEqual(["highground-2026-11-04.jsonl"]);
    expect(readdirSync(dir).sort()).toEqual([
      "highground-2026-11-05.jsonl",
      "highground-2026-11-06.jsonl",
      "highground-2026-11-08.jsonl",
      "notes.txt",
    ]);
  });

  it("is a no-op for a missing directory", async () => {
    expect(await pruneLogs(join(scratch(), "missing"), Date.now())).toEqual([]);
  });
});
