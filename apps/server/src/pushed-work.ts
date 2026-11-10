import {
  capChanges,
  HeartbeatSchema,
  reportHeartbeats,
  type FileHeartbeat,
  type FileReport,
} from "@highground/core";
import type { PullRequest } from "./github.ts";
import { branches, defaultBranch, derivedId, diffCommits, mergeBaseOf } from "@highground/git";
import type { Hub } from "./hub.ts";
import type { Mirror } from "./mirror.ts";

const MAX_CHANGES = 50;
/** Longer than a fetch round, so pushed work never lapses between rounds. */
const TTL_SECONDS = 300;

export interface PushedWorkOptions {
  mirror: Mirror;
  hub: Hub;
  /** Open pull requests by branch; absent without a GitHub App. */
  pulls?: (repo: string) => Promise<Map<string, PullRequest>>;
  onError?: (repo: string, error: unknown) => void;
}

/**
 * Publishes each unmerged branch in a mirror as pushed work (PRD §3.3): its changes from
 * the merge-base with the default branch, as complete heartbeats through the hub, so
 * they reach the log and every instance like any other. Branches that vanish or merge
 * are cleared.
 */
export class PushedWork {
  readonly #options: PushedWorkOptions;
  /** `base..head` → reports; a branch that has not moved is not diffed again. */
  readonly #diffs = new Map<string, FileReport[]>();

  constructor(options: PushedWorkOptions) {
    this.#options = options;
  }

  async publish(repo: string): Promise<void> {
    const { mirror, hub } = this.#options;
    const dir = mirror.dirOf(repo);
    const main = await defaultBranch(dir);
    const all = await branches(dir);
    const mainHead = all.find((b) => b.name === main)?.head;
    if (!mainHead) return;
    const pulls = await (
      this.#options.pulls?.(repo) ?? Promise.resolve(new Map<string, PullRequest>())
    ).catch((error: unknown) => {
      this.#options.onError?.(repo, error);
      return new Map<string, PullRequest>();
    });

    const published = new Set<string>();
    const diffs = new Map<string, FileReport[]>();
    for (const branch of all) {
      if (branch.name === main) continue;
      const base = await mergeBaseOf(dir, mainHead, branch.head).catch(() => null);
      if (base === null || base === branch.head) continue;
      const key = `${base}..${branch.head}`;
      const reports = this.#diffs.get(key) ?? (await diffCommits(dir, base, branch.head));
      diffs.set(key, reports);

      const workingCopyId = derivedId("pushed", repo, branch.name);
      published.add(workingCopyId);
      const files: FileHeartbeat[] = reports.map((r) => ({
        path: r.path,
        whole_file: r.wholeFile,
        changes: capChanges(r.changes, MAX_CHANGES),
        intent: null,
      }));
      for (const part of reportHeartbeats(files)) {
        hub.heartbeat(
          HeartbeatSchema.parse({
            repo,
            working_copy_id: workingCopyId,
            actor: { type: "cli", id: branch.name },
            author: branch.author || "unknown",
            branch: branch.name,
            base_sha: base,
            ...part,
            ttl_seconds: TTL_SECONDS,
            kind: "pushed",
            head_sha: branch.head,
            last_commit_at: branch.committedAt,
            pr_url: pulls.get(branch.name)?.url ?? null,
            // No agent works on pushed work; what its pull request says it is for stands in.
            summary: pulls.get(branch.name)?.title.slice(0, 1000) ?? null,
          }),
        );
      }
    }
    // Only the diffs still in use are kept.
    this.#diffs.clear();
    for (const [key, reports] of diffs) this.#diffs.set(key, reports);

    for (const [workingCopyId, state] of hub.index.workingCopiesOfKind(repo, "pushed")) {
      if (published.has(workingCopyId)) continue;
      hub.heartbeat(
        HeartbeatSchema.parse({
          repo,
          working_copy_id: workingCopyId,
          actor: state.actor,
          author: state.author,
          branch: state.branch,
          base_sha: state.baseSha,
          scope: "complete",
          files: [],
          kind: "pushed",
        }),
      );
    }
  }
}
