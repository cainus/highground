import { setTimeout as sleep } from "node:timers/promises";
import {
  capChanges,
  type FileHeartbeat,
  type FileReport,
  type HeartbeatInput,
  type MergeResult,
  type Warning,
} from "@highground/core";
import {
  derivedId,
  diffCommits,
  diffRanges,
  ensureIdentity,
  ensureRepositoryIdentity,
  fetchCommit,
  hasCommit,
  mergeTree,
  parkedBranches,
  RepoStateError,
  repoState,
  snapshot,
  type ParkedBranch,
  type RepoState,
} from "@highground/git";
import type { Log } from "@highground/log";
import { readSummary } from "./discovery.ts";
import type { LocalMerges, MergeSide } from "./local-merges.ts";
import { VERSION } from "./version.ts";
import { describeError, type ServerClient } from "./server-client.ts";
import { WorkingCopyWatcher } from "./watcher.ts";

export interface ReporterOptions {
  /** Any directory inside the working copy. */
  root: string;
  server: ServerClient;
  log: Log;
  /** Quiet time after a filesystem event before recomputing (PRD §6: 500 ms). */
  debounceMs?: number;
  /** Recompute and resend the complete snapshot this often, events or not (PRD §6: 20 s). */
  keepaliveMs?: number;
  ttlSeconds?: number;
  /** Watch the filesystem; off, the keepalive alone finds changes. */
  watch?: boolean;
  /** Called whenever the working copy's state has been read. */
  onState?: (state: RepoState, id: string) => void;
  /**
   * Whether this reporter sends its repository's parked work. Parked branches belong to
   * the repository, which all its worktrees share, so a daemon watching several has one
   * of them send it. Yes by default.
   */
  reportsParked?: (state: RepoState) => boolean;
  /** Merges with the other live worktrees the same daemon reports. */
  localMerges?: Pick<LocalMerges, "for" | "schedule">;
}

const ACTOR = { type: "cli", id: "daemon" } as const;
const MAX_FILES = 200;
const MAX_CHANGES = 50;

type ParkedState = Omit<HeartbeatInput, "files" | "scope">;

const toFiles = (reports: FileReport[]): FileHeartbeat[] =>
  reports.map((report) => ({
    path: report.path,
    whole_file: report.wholeFile,
    changes: capChanges(report.changes, MAX_CHANGES),
    intent: null,
  }));

const collisionKey = (w: Warning) =>
  [w.path, w.peer.working_copy_id, w.peer.actor.type, w.peer.actor.id].join("\0");

/**
 * Reports one working copy's live work: recomputes its ranges after filesystem changes
 * and on a keepalive, sends them as complete heartbeats, and follows the collisions the
 * server announces for it. Every failure degrades and is retried; none is thrown.
 */
export class Reporter implements MergeSide {
  /** The working copy's id, once its repository could be read. */
  id: string | undefined;
  state: RepoState | undefined;
  /** Heartbeats the server accepted. */
  sent = 0;
  /** Why the last report did not reach the server; null when it did. */
  degraded: string | null = null;
  /** Whether the working copy could be read the last time it was tried. */
  readable = false;

  readonly #options: Required<Omit<ReporterOptions, "localMerges">> &
    Pick<ReporterOptions, "localMerges">;
  readonly #watcher = new WorkingCopyWatcher(() => this.#schedule());
  readonly #abort = new AbortController();
  readonly #collisions = new Map<string, Warning>();
  #debounce: NodeJS.Timeout | undefined;
  #keepalive: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #subscription: Promise<void> | undefined;
  #stopped = false;
  /** The live files the merge results were computed for. */
  #signature = "";
  /** `branch\0head` → this working tree merged with that pushed head. */
  readonly #merges = new Map<string, MergeResult>();
  #merging: Promise<void> | undefined;
  /** Parked branches last reported, by their derived working copy id. */
  #parked = new Map<string, ParkedState>();
  /** Parked head → the collisions its last heartbeat returned. */
  #parkedCollisions = new Map<string, Warning[]>();
  /** Parked head → `branch\0head` → that commit merged with a pushed head. */
  #parkedMerges = new Map<string, Map<string, MergeResult>>();

  constructor(options: ReporterOptions) {
    this.#options = {
      debounceMs: 500,
      keepaliveMs: 20_000,
      ttlSeconds: 60,
      watch: true,
      onState: () => {},
      reportsParked: () => true,
      ...options,
    };
  }

  /** The working copy this reports, as it was given. */
  get root(): string {
    return this.#options.root;
  }

  /** Its working tree's changes as last reported. */
  get signature(): string {
    return this.#signature;
  }

  /** The shared git directory of its repository, once read. */
  get commonDir(): string | undefined {
    return this.state?.commonDir;
  }

  #snapshot: { signature: string; commit: Promise<string> } | undefined;

  /** A commit holding the working tree, made once per reported state. */
  snapshotCommit(): Promise<string> {
    if (this.#snapshot?.signature !== this.#signature) {
      const commit = snapshot(this.#options.root);
      commit.catch(() => {
        if (this.#snapshot?.commit === commit) this.#snapshot = undefined;
      });
      this.#snapshot = { signature: this.#signature, commit };
    }
    return this.#snapshot.commit;
  }

  /** Reports once, then keeps reporting until stopped. */
  async start(): Promise<void> {
    await this.refresh();
    this.#keepalive = setInterval(() => void this.refresh(), this.#options.keepaliveMs);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#debounce);
    clearInterval(this.#keepalive);
    this.#watcher.close();
    this.#abort.abort();
    await Promise.allSettled([this.#running, this.#subscription, this.#merging]);
  }

  /** The collisions the server currently reports against this working copy. */
  collisions(): Warning[] {
    return [...this.#collisions.values()];
  }

  /** Recomputes and sends now; a call during a report runs one more report after it. */
  refresh(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        await this.#report();
      } while (this.#again && !this.#stopped);
    })().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #report(): Promise<void> {
    if (this.#stopped) return;
    let files: FileHeartbeat[];
    /** The repository's parked work, or null when another reporter sends it. */
    let parked: {
      repositoryId: string;
      branches: { branch: ParkedBranch; files: FileHeartbeat[] }[];
    } | null;
    let state: RepoState;
    try {
      state = await repoState(this.#options.root);
      this.state = state;
      this.readable = true;
      this.id ??= await ensureIdentity(state.root);
      this.#options.onState(state, this.id);
      if (this.#options.watch) await this.#watcher.sync(state.root);
      files = toFiles(await diffRanges(state.root, state.base));
      parked = null;
      if (this.#options.reportsParked(state)) {
        parked = { repositoryId: await ensureRepositoryIdentity(state.root), branches: [] };
        for (const branch of await parkedBranches(state.root, state.defaultRef)) {
          parked.branches.push({
            branch,
            files: toFiles(await diffCommits(state.root, branch.base, branch.head)),
          });
        }
      }
    } catch (error) {
      this.readable = false;
      const reason = error instanceof RepoStateError ? error.message : describeError(error);
      this.#degrade("working copy unreadable", reason);
      return;
    }
    // Merge results hold only while the working tree they were computed from does.
    const signature = JSON.stringify(files);
    if (signature !== this.#signature) {
      this.#signature = signature;
      this.#merges.clear();
    }

    try {
      const common = { repo: state.repo, actor: ACTOR, ttl_seconds: this.#options.ttlSeconds };
      await this.#send(files, {
        ...common,
        working_copy_id: this.id,
        author: state.author,
        branch: state.branch,
        base_sha: state.base,
        merges: [...this.#merges.values()],
        local_merges: this.#options.localMerges?.for(this) ?? [],
        summary: await readSummary(state.root),
      });
      const sentParked = new Map<string, ParkedState>();
      const parkedCollisions = new Map<string, Warning[]>();
      for (const { branch, files: branchFiles } of parked?.branches ?? []) {
        const parkedState = {
          ...common,
          working_copy_id: derivedId("parked", parked!.repositoryId, branch.name),
          author: branch.author || state.author,
          branch: branch.name,
          base_sha: branch.base,
          kind: "parked" as const,
          head_sha: branch.head,
          last_commit_at: branch.committedAt,
        };
        const merges = this.#parkedMerges.get(branch.head);
        parkedCollisions.set(
          branch.head,
          await this.#send(branchFiles, {
            ...parkedState,
            merges: merges ? [...merges.values()] : [],
          }),
        );
        sentParked.set(parkedState.working_copy_id, parkedState);
      }
      // Merge results hold only for the commit they were computed from.
      this.#parkedCollisions = parkedCollisions;
      for (const head of this.#parkedMerges.keys()) {
        if (!parkedCollisions.has(head)) this.#parkedMerges.delete(head);
      }
      // A branch that was parked and no longer is — pushed, merged, deleted or checked
      // out — is cleared. Work another reporter now sends is left to it: same ids.
      if (parked) {
        for (const [id, gone] of this.#parked) {
          if (!sentParked.has(id)) await this.#send([], gone);
        }
      }
      this.#parked = sentParked;
    } catch (error) {
      this.#degrade("heartbeat failed", describeError(error));
      return;
    }
    if (this.degraded !== null) {
      this.#options.log.info({ root: state.root }, "reporting recovered");
      // The server could not be told while it was away; it hears now, for the admin page.
      this.#options.server
        .clientStatus({
          repo: state.repo,
          working_copy_id: this.id,
          client: "daemon",
          version: VERSION,
          route: null,
          degraded: `recovered after: ${this.degraded}`.slice(0, 500),
        })
        .catch((error: unknown) =>
          this.#options.log.warn({ reason: describeError(error) }, "status report failed"),
        );
      this.degraded = null;
    }
    this.#subscribe(state.repo, this.id);
    this.#scheduleMerges();
    this.#options.localMerges?.schedule(this);
  }

  /**
   * Sends one actor's files: a complete heartbeat, then partials past the per-heartbeat
   * limit. Returns the collisions the server answered with.
   */
  async #send(
    files: FileHeartbeat[],
    heartbeat: Omit<HeartbeatInput, "files" | "scope">,
  ): Promise<Warning[]> {
    const warnings: Warning[] = [];
    for (let i = 0; i === 0 || i < files.length; i += MAX_FILES) {
      const answer = await this.#options.server.heartbeat({
        ...heartbeat,
        scope: i === 0 ? "complete" : "partial",
        files: files.slice(i, i + MAX_FILES),
      });
      warnings.push(...answer.warnings);
      this.sent++;
    }
    return warnings;
  }

  /**
   * Runs the speculative merges the current collisions call for (ADR 0003): for each
   * collision with pushed work, nearby lines included, the pushed head — fetched by id if
   * missing — merged with a snapshot of the working tree (live work) or with the parked
   * branch's head. One batch at a time; new results go out with the next heartbeat, at once.
   */
  #scheduleMerges(): void {
    if (this.#merging || this.#stopped || !this.state) return;
    const root = this.state.root;
    interface Job {
      /** A parked head, or null for the working tree. */
      ours: string | null;
      branch: string;
      head: string;
      into: Map<string, MergeResult>;
    }
    const jobs = new Map<string, Job>();
    const want = (
      ours: string | null,
      into: Map<string, MergeResult>,
      warnings: Iterable<Warning>,
    ) => {
      for (const w of warnings) {
        if (w.peer.kind !== "pushed" || !w.peer.head_sha) continue;
        const key = `${w.peer.branch}\0${w.peer.head_sha}`;
        if (into.has(key)) continue;
        jobs.set(`${ours ?? ""}\0${key}`, {
          ours,
          branch: w.peer.branch,
          head: w.peer.head_sha,
          into,
        });
      }
    };
    want(null, this.#merges, this.#collisions.values());
    for (const [head, warnings] of this.#parkedCollisions) {
      let into = this.#parkedMerges.get(head);
      if (!into) this.#parkedMerges.set(head, (into = new Map()));
      want(head, into, warnings);
    }
    if (jobs.size === 0) return;
    const signature = this.#signature;
    this.#merging = (async () => {
      let learned = false;
      for (const { ours, branch, head, into } of jobs.values()) {
        if (this.#stopped) return;
        try {
          if (!(await hasCommit(root, head))) await fetchCommit(root, head);
          const result = await mergeTree(root, ours ?? (await snapshot(root)), head);
          // A working-tree result is stale once the tree changed; a commit's never is.
          if (ours === null && signature !== this.#signature) continue;
          into.set(`${branch}\0${head}`, {
            branch,
            head_sha: head,
            conflicts: result.clean ? [] : result.conflicts,
          });
          learned = true;
        } catch (error) {
          this.#options.log.warn(
            { root, ours: ours ?? "working tree", branch, head, reason: describeError(error) },
            "speculative merge failed",
          );
        }
      }
      if (learned) void this.refresh();
    })().finally(() => {
      this.#merging = undefined;
    });
  }

  /** Records why reporting failed, logging only when the reason changes. */
  #degrade(msg: string, reason: string): void {
    if (this.degraded !== reason) this.#options.log.warn({ root: this.#options.root, reason }, msg);
    this.degraded = reason;
  }

  #schedule(): void {
    clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => void this.refresh(), this.#options.debounceMs);
  }

  /** Holds the collision stream open, reconnecting with backoff; it also marks presence. */
  #subscribe(repo: string, workingCopyId: string): void {
    if (this.#subscription) return;
    const { server, log } = this.#options;
    const signal = this.#abort.signal;
    // Resolves to `done` on stop. The client's iterator does not always end when its
    // signal aborts while it waits for an event, so each read races this, and the
    // iterator is then returned, which closes the stream and lets presence clear us.
    const stopped = new Promise<IteratorReturnResult<undefined>>((resolve) =>
      signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), {
        once: true,
      }),
    );
    this.#subscription = (async () => {
      let delay = 100;
      while (!this.#stopped) {
        try {
          const events = await server.subscribe(
            { repo, working_copy_id: workingCopyId },
            { signal },
          );
          this.#collisions.clear();
          delay = 100;
          for (;;) {
            const next = await Promise.race([events.next(), stopped]);
            if (next.done) {
              if (this.#stopped) void events.return?.().catch(() => {});
              break;
            }
            const { event, warning } = next.value;
            if (event === "collision_started") {
              this.#collisions.set(collisionKey(warning), warning);
              log.info({ warning }, "collision started");
              if (warning.peer.kind === "pushed") this.#scheduleMerges();
              if (warning.peer.kind === "live") this.#options.localMerges?.schedule(this);
            } else {
              this.#collisions.delete(collisionKey(warning));
              log.info({ warning }, "collision ended");
            }
          }
        } catch (error) {
          if (this.#stopped) return;
          log.debug({ reason: describeError(error) }, "subscription dropped");
        }
        await sleep(delay, undefined, { signal }).catch(() => {});
        delay = Math.min(delay * 2, 5_000);
      }
    })();
  }
}
