import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const created: string[] = [];

/** A throwaway repository on `main` with one commit holding `files`. */
export function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "highground-test-"));
  created.push(dir);
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.email", "test@example.com");
  run(dir, "config", "user.name", "Test");
  run(dir, "config", "commit.gpgsign", "false");
  write(dir, files);
  commitAll(dir, "base");
  return dir;
}

export function run(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** Writes files, creating the directories they are in. */
export function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

export function commitAll(dir: string, message: string): string {
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "--allow-empty", "-m", message);
  return run(dir, "rev-parse", "HEAD");
}

export function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}\n`).join("");
}

export function cleanupRepos(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
