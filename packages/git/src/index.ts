import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  parseDiff,
  repoFromRemote,
  reportsFromDiff,
  type FileReport,
  type Hunk,
} from "@highground/core";

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

export type RepoStateReason =
  | "not-a-repository"
  | "no-remote"
  | "unrecognised-remote"
  | "no-default-branch";

/** Why a directory's repository state could not be read; `reason` is stable for callers. */
export class RepoStateError extends Error {
  readonly reason: RepoStateReason;
  constructor(reason: RepoStateReason, message: string) {
    super(message);
    this.name = "RepoStateError";
    this.reason = reason;
  }
}

export interface RepoState {
  /** The working copy's top-level directory. */
  root: string;
  /** `host/owner/name`, from `origin`. */
  repo: string;
  /** The remote-tracking ref of the default branch, e.g. `origin/main`. */
  defaultRef: string;
  /** The base commit (ADR 0001). */
  base: string;
  /** The checked-out branch, or `HEAD` when detached. */
  branch: string;
  author: string;
}

async function optional(dir: string, args: string[]): Promise<string | null> {
  const result = await git(dir, args, { okCodes: [1, 128] });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The default branch's remote-tracking ref: `origin/HEAD`'s target, else `origin/main` or `origin/master`. */
async function defaultRefOf(dir: string): Promise<string | null> {
  const head = await optional(dir, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^refs\/remotes\//, "");
  for (const ref of ["origin/main", "origin/master"]) {
    if (await optional(dir, ["rev-parse", "-q", "--verify", `refs/remotes/${ref}`])) return ref;
  }
  return null;
}

/** Everything a heartbeat needs to say about where a working copy stands. */
export async function repoState(dir: string): Promise<RepoState> {
  const root = await git(dir, ["rev-parse", "--show-toplevel"]).then(
    (r) => r.stdout.trim(),
    (error: unknown) => {
      throw new RepoStateError(
        "not-a-repository",
        `${dir} is not in a git working copy: ${String(error)}`,
      );
    },
  );
  const url = await optional(root, ["config", "--get", "remote.origin.url"]);
  if (!url) throw new RepoStateError("no-remote", `${root} has no origin remote`);
  const repo = repoFromRemote(url);
  if (!repo)
    throw new RepoStateError("unrecognised-remote", `cannot name a repository from ${url}`);
  const defaultRef = await defaultRefOf(root);
  if (!defaultRef) {
    throw new RepoStateError(
      "no-default-branch",
      `${root} has no origin/HEAD, origin/main or origin/master`,
    );
  }
  const [base, branch, author] = await Promise.all([
    mergeBase(root, defaultRef),
    optional(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    optional(root, ["config", "user.email"]),
  ]);
  return { root, repo, defaultRef, base, branch: branch || "HEAD", author: author || "unknown" };
}

/**
 * One file's hunks from the base to the working tree, uncommitted edits included, for
 * translating between working-copy and base coordinates. Null when the file is not in
 * the base or is binary: its changes are the whole file.
 */
export async function fileHunks(dir: string, base: string, path: string): Promise<Hunk[] | null> {
  if ((await optional(dir, ["cat-file", "-e", `${base}:${path}`])) === null) return null;
  const diff = await git(dir, [
    "diff",
    "-U0",
    "--histogram",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    base,
    "--",
    path,
  ]);
  const [file] = parseDiff(diff.stdout);
  if (!file) return [];
  return file.binary ? null : file.hunks;
}

const IDENTITY_DIR = ".highground";
const EXCLUDE_LINE = "/.highground/";

/**
 * The working copy's id (ADR 0005), creating `.highground/id` when missing and keeping
 * `.highground/` out of git through the repository's shared `info/exclude`. Safe when
 * several processes create it at once: the first write wins and the rest read it.
 */
export async function ensureIdentity(root: string): Promise<string> {
  await mkdir(join(root, IDENTITY_DIR), { recursive: true });
  const file = join(root, IDENTITY_DIR, "id");
  try {
    await writeFile(file, `${randomUUID()}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const exclude = resolve(
    root,
    (await git(root, ["rev-parse", "--git-path", "info/exclude"])).stdout.trim(),
  );
  await mkdir(dirname(exclude), { recursive: true });
  const current = await readFile(exclude, "utf8").catch(() => "");
  if (!current.split("\n").includes(EXCLUDE_LINE)) {
    await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`);
  }
  return await readId(file);
}

/** Reads an id file, waiting out a concurrent creator that has opened it but not yet written. */
async function readId(file: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const id = (await readFile(file, "utf8")).trim();
    if (id || attempt >= 50) return id;
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * The working copy containing `start` and its id, found by walking up to `.highground/id`
 * without running git, so it works where git cannot, such as a container whose `.git`
 * file points at a host path.
 */
export async function findIdentity(start: string): Promise<{ root: string; id: string } | null> {
  let dir = resolve(start);
  for (;;) {
    const id = await readFile(join(dir, IDENTITY_DIR, "id"), "utf8").then(
      (text) => text.trim(),
      () => "",
    );
    if (id) return { root: dir, id };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The directories to watch for changes to a working copy: every directory holding a
 * tracked or untracked, non-ignored file, so `node_modules` and build output cost no
 * watches, plus the git directory, where HEAD and the index change on commit and checkout.
 */
export async function watchTargets(root: string): Promise<string[]> {
  const [files, gitDir] = await Promise.all([
    git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    git(root, ["rev-parse", "--absolute-git-dir"]),
  ]);
  const dirs = new Set([root, gitDir.stdout.trim()]);
  for (const path of files.stdout.split("\0").filter(Boolean)) {
    for (let d = dirname(path); d !== "."; d = dirname(d)) {
      if (dirs.has(join(root, d))) break;
      dirs.add(join(root, d));
    }
  }
  return [...dirs];
}
