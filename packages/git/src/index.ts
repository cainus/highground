import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  | "missing"
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
  /** The git directory shared by every worktree of the repository, which holds its branches. */
  commonDir: string;
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
  if (
    !(await stat(dir).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  ) {
    throw new RepoStateError("missing", `${dir} no longer exists`);
  }
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
  const [base, branch, author, commonDir] = await Promise.all([
    mergeBase(root, defaultRef),
    optional(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    optional(root, ["config", "user.email"]),
    commonDirOf(root),
  ]);
  return {
    root,
    commonDir,
    repo,
    defaultRef,
    base,
    branch: branch || "HEAD",
    author: author || "unknown",
  };
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
  // Not recursive: a working copy deleted while it was being reported stays deleted.
  await mkdir(join(root, IDENTITY_DIR)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const file = join(root, IDENTITY_DIR, "id");
  await createId(file);
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

/**
 * The repository's id: one random UUID for all its worktrees, kept in the git directory
 * they share. Parked work belongs to the repository, since its branches are shared, so
 * it reports under this id however many worktrees there are (ADR 0005).
 */
export async function ensureRepositoryIdentity(root: string): Promise<string> {
  const file = join(await commonDirOf(root), "highground-id");
  await createId(file);
  return await readId(file);
}

/** The absolute, symlink-free git directory a repository's worktrees share. */
async function commonDirOf(root: string): Promise<string> {
  const dir = (await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout;
  return await realpath(dir.trim());
}

/** Writes a new id unless the file exists; the first of concurrent creators wins. */
async function createId(file: string): Promise<void> {
  try {
    await writeFile(file, `${randomUUID()}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
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

/** The working copy's own git directory, outside it for a linked worktree. */
export async function absoluteGitDir(root: string): Promise<string> {
  return (await git(root, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
}

/**
 * What git ignores in a working copy, relative to its root: ignored directories once
 * each, ending in `/`, and ignored files outside them.
 */
export async function ignoredPaths(root: string): Promise<string[]> {
  const out = await git(root, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  return out.stdout.split("\0").filter(Boolean);
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

/** Git configuration passed through the environment, so secrets never appear in argv. */
function configEnv(config: Record<string, string>): Record<string, string> {
  const entries = Object.entries(config);
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(entries.length),
    GIT_TERMINAL_PROMPT: "0",
  };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Creates a bare mirror of `url` at `dir` whose branches are the remote's, or repoints an existing one. */
export async function initMirror(dir: string, url: string): Promise<void> {
  const exists = await readFile(join(dir, "HEAD"), "utf8").then(
    () => true,
    () => false,
  );
  if (!exists) {
    await mkdir(dir, { recursive: true });
    await git(dir, ["init", "--bare", "-q"]);
    await git(dir, ["remote", "add", "origin", url]);
    await git(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
  } else {
    await git(dir, ["remote", "set-url", "origin", url]);
  }
}

/**
 * Fetches every branch, pruning deleted ones, and follows the remote's default branch.
 * `config` carries credentials, such as an `http.extraHeader`.
 */
export async function fetchMirror(dir: string, config: Record<string, string> = {}): Promise<void> {
  const env = configEnv(config);
  await git(dir, ["fetch", "--prune", "--quiet", "origin"], { env });
  const head = await git(dir, ["ls-remote", "--symref", "origin", "HEAD"], { env });
  const target = /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(head.stdout)?.[1];
  if (target) await git(dir, ["symbolic-ref", "HEAD", target]);
}

/** The mirror's default branch name. */
export async function defaultBranch(dir: string): Promise<string> {
  return (await git(dir, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
}

export interface Branch {
  name: string;
  head: string;
  /** The head commit's author email. */
  author: string;
  /** The head commit's committer date, ISO 8601. */
  committedAt: string;
}

/** Every branch in a mirror, by name. */
export async function branches(dir: string): Promise<Branch[]> {
  const out = await git(dir, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname:short)%00%(objectname)%00%(authoremail:trim)%00%(committerdate:iso-strict)",
    "refs/heads",
  ]);
  return out.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, head, author, committedAt] = line.split("\0") as [
        string,
        string,
        string,
        string,
      ];
      return { name, head, author, committedAt };
    });
}

/** Whether a commit is present. */
export async function hasCommit(dir: string, sha: string): Promise<boolean> {
  return (await optional(dir, ["cat-file", "-e", `${sha}^{commit}`])) !== null;
}

/** The changes from `base` to `head`, as per-path reports in `base` coordinates. */
export async function diffCommits(dir: string, base: string, head: string): Promise<FileReport[]> {
  const diff = await git(dir, [
    "-c",
    "core.quotePath=false",
    "diff",
    "-U0",
    "-M",
    "--histogram",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    base,
    head,
  ]);
  return reportsFromDiff(parseDiff(diff.stdout), digestLines);
}

/**
 * Each path's hunks between two commits, for translating ranges from one base to the
 * other. An unchanged path maps to no hunks; a binary one is left out, as untranslatable.
 */
export async function diffPaths(
  dir: string,
  from: string,
  to: string,
  paths: string[],
): Promise<Map<string, Hunk[]>> {
  const diff = await git(dir, [
    "-c",
    "core.quotePath=false",
    "diff",
    "-U0",
    "--histogram",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    from,
    to,
    "--",
    ...paths,
  ]);
  const result = new Map<string, Hunk[]>(paths.map((path) => [path, []]));
  for (const file of parseDiff(diff.stdout)) {
    const path = file.basePath ?? file.newPath;
    if (path === null) continue;
    if (file.binary) result.delete(path);
    else result.set(path, file.hunks);
  }
  return result;
}

/**
 * A stable UUID (version 8) naming something that has no identity file of its own, such
 * as a pushed branch or a working copy's parked branch.
 */
export function derivedId(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\0")).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The best common ancestor of two commits. */
export async function mergeBaseOf(dir: string, a: string, b: string): Promise<string> {
  return (await git(dir, ["merge-base", a, b])).stdout.trim();
}

export interface ParkedBranch extends Branch {
  /** Its merge-base with the default branch. */
  base: string;
}

/**
 * The repository's local branches that are checked out in no worktree and hold commits
 * on neither the default branch nor the branch's own upstream: work only this repository
 * has. A branch checked out in a worktree is live work there, not parked.
 */
export async function parkedBranches(dir: string, defaultRef: string): Promise<ParkedBranch[]> {
  const out = await git(dir, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname:short)%00%(objectname)%00%(upstream)%00%(authoremail:trim)%00%(committerdate:iso-strict)%00%(worktreepath)",
    "refs/heads",
  ]);
  const parked: ParkedBranch[] = [];
  for (const line of out.stdout.split("\n").filter(Boolean)) {
    const [name, head, upstream, author, committedAt, worktree] = line.split("\0") as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (worktree) continue;
    const base = await mergeBaseOf(dir, defaultRef, head).catch(() => null);
    if (base === null || base === head) continue;
    // Everything on its upstream is pushed work, which the server reports.
    if (
      upstream &&
      (await optional(dir, ["merge-base", "--is-ancestor", head, upstream])) !== null
    ) {
      continue;
    }
    parked.push({ name, head, author, committedAt, base });
  }
  return parked;
}

/** Fetches one commit from `origin` by id, writing no refs and no FETCH_HEAD. */
export async function fetchCommit(dir: string, sha: string): Promise<void> {
  await git(dir, ["fetch", "--quiet", "--no-write-fetch-head", "--no-tags", "origin", sha], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
}
