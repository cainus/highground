import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseDiff, reportsFromDiff, type FileReport } from "@highground/core";

/** SHA-256 of a change's new content. Hashed here so code never leaves the machine. */
function digestLines(lines: string[]): string {
  return createHash("sha256")
    .update(lines.map((line) => `${line}\n`).join(""))
    .digest("hex");
}

const execFileAsync = promisify(execFile);

/** Identity for snapshot commits, so they work where the user has none configured. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "highground",
  GIT_AUTHOR_EMAIL: "snapshot@highground.invalid",
  GIT_COMMITTER_NAME: "highground",
  GIT_COMMITTER_EMAIL: "snapshot@highground.invalid",
};

interface GitResult {
  stdout: string;
  code: number;
}

/**
 * Runs git in `dir`. `GIT_OPTIONAL_LOCKS=0` stops background reads from taking
 * `index.lock`, so the daemon never makes a person's own git command fail.
 */
async function git(
  dir: string,
  args: string[],
  options: { env?: Record<string, string>; okCodes?: number[] } = {},
): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...options.env },
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string };
    if (typeof failure.code === "number" && options.okCodes?.includes(failure.code)) {
      return { stdout: failure.stdout ?? "", code: failure.code };
    }
    throw error;
  }
}

/** The base commit: where the checked-out branch left `defaultRef`. */
export async function mergeBase(dir: string, defaultRef: string): Promise<string> {
  return (await git(dir, ["merge-base", "HEAD", defaultRef])).stdout.trim();
}

/**
 * All unmerged work in a working copy — committed, uncommitted, and untracked — as
 * per-path reports in base coordinates. Uses the histogram algorithm, as merge-ort does.
 */
export async function diffRanges(dir: string, baseSha: string): Promise<FileReport[]> {
  const [diff, untracked] = await Promise.all([
    git(dir, [
      "-c",
      "core.quotePath=false",
      "diff",
      "-U0",
      "-M",
      "--histogram",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      baseSha,
    ]),
    git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const reports = reportsFromDiff(parseDiff(diff.stdout), digestLines);
  for (const path of untracked.stdout.split("\0").filter(Boolean)) {
    reports.push({ path, wholeFile: true, changes: [] });
  }
  return reports;
}

/**
 * A commit holding the working tree exactly as it is, untracked files included, with
 * HEAD as parent. Built through a copy of the index, so neither the real index nor the
 * stash list is touched.
 */
export async function snapshot(dir: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "highground-index-"));
  const index = join(scratch, "index");
  try {
    const realIndex = (await git(dir, ["rev-parse", "--git-path", "index"])).stdout.trim();
    await copyFile(resolve(dir, realIndex), index);
    const env = { GIT_INDEX_FILE: index, ...SNAPSHOT_IDENTITY };
    await git(dir, ["add", "-A"], { env });
    const tree = (await git(dir, ["write-tree"], { env })).stdout.trim();
    const commit = await git(
      dir,
      ["commit-tree", tree, "-p", "HEAD", "-m", "highground snapshot"],
      {
        env,
      },
    );
    return commit.stdout.trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface MergeResult {
  clean: boolean;
  conflicts: string[];
}

/** A speculative merge of two commits with git's own merge, without a checkout. */
export async function mergeTree(dir: string, ours: string, theirs: string): Promise<MergeResult> {
  const result = await git(
    dir,
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs],
    { okCodes: [1] },
  );
  const [, ...paths] = result.stdout.split("\0").filter(Boolean);
  return { clean: result.code === 0, conflicts: [...new Set(paths)] };
}
