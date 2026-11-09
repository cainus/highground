import { watch, type FSWatcher } from "node:fs";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { absoluteGitDir, ignoredPaths, watchTargets } from "@highground/git";

/** In a working copy's git directory, the files whose change can change its report. */
const GIT_FILES = new Set(["HEAD", "index", "packed-refs", "FETCH_HEAD", "refs"]);

interface Watched {
  watcher: FSWatcher;
  /** The watched directory relative to the working copy, or null for its git directory. */
  rel: string | null;
}

/**
 * Calls back when anything that could change a working copy's report changes: its files,
 * its HEAD, index or refs. Git's object store, `.highground/` and the ignored paths known
 * at the last sync are not reported. A path ignored since then is reported until the
 * next sync, which the report it causes runs.
 *
 * On macOS and Windows it holds one recursive watch on the working copy. libuv keeps all
 * of a process's macOS watches in one FSEvents stream and re-registers every path when
 * one is added or closed, so a watch per directory costs time quadratic in the
 * directories, minutes for a daemon watching dozens of large worktrees. Elsewhere it
 * holds a watch per directory that holds a file git sees, which is what inotify is.
 */
export class WorkingCopyWatcher {
  readonly #onChange: () => void;
  readonly #recursive: boolean;
  readonly #watched = new Map<string, Watched>();
  #ignored: string[] = [];
  #closed = false;

  constructor(onChange: () => void, options: { recursive?: boolean } = {}) {
    this.#onChange = onChange;
    this.#recursive =
      options.recursive ?? (process.platform === "darwin" || process.platform === "win32");
  }

  /** How many watches it holds, for tests. */
  get handles(): number {
    return this.#watched.size;
  }

  /** Brings the watches and the ignore list up to date with the working copy. */
  async sync(root: string): Promise<void> {
    const [gitDir, ignored, real] = await Promise.all([
      absoluteGitDir(root),
      ignoredPaths(root),
      realpath(root),
    ]);
    this.#ignored = ignored;
    const wanted = new Map<string, string | null>();
    if (this.#recursive) {
      wanted.set(root, "");
      // A linked worktree's git directory, with its HEAD and index, is outside it.
      if (!gitDir.startsWith(real + sep)) wanted.set(gitDir, null);
    } else {
      for (const dir of await watchTargets(root)) {
        wanted.set(dir, dir === gitDir ? null : relative(root, dir));
      }
    }
    for (const [dir, { watcher }] of this.#watched) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.#watched.delete(dir);
      }
    }
    for (const [dir, rel] of wanted) {
      if (this.#watched.has(dir) || this.#closed) continue;
      try {
        const watcher = watch(dir, { recursive: this.#recursive && rel === "" }, (_e, name) => {
          if (this.#relevant(rel, name)) this.#onChange();
        });
        watcher.on("error", () => {
          watcher.close();
          this.#watched.delete(dir);
        });
        this.#watched.set(dir, { watcher, rel });
      } catch {
        // The directory vanished between listing and watching; the next sync catches up.
      }
    }
  }

  close(): void {
    this.#closed = true;
    for (const { watcher } of this.#watched.values()) watcher.close();
    this.#watched.clear();
  }

  #relevant(rel: string | null, name: string | Buffer | null): boolean {
    if (name === null) return true;
    const file = String(name).split(sep).join("/");
    if (rel === null) return GIT_FILES.has(file.split("/")[0]!);
    const path = rel ? `${rel.split(sep).join("/")}/${file}` : file;
    if (path === ".highground" || path.startsWith(".highground/")) return false;
    // The main working copy's git directory is inside it: only what moves HEAD or the index.
    if (path === ".git" || path.startsWith(".git/")) {
      return GIT_FILES.has(path.split("/")[1] ?? "");
    }
    for (const ignored of this.#ignored) {
      if (ignored.endsWith("/") ? `${path}/`.startsWith(ignored) : path === ignored) return false;
    }
    return true;
  }
}
