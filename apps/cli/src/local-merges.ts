import type { LocalMerge, Warning } from "@highground/core";
import { mergeTree } from "@highground/git";
import type { Log } from "@highground/log";
import { describeError } from "./server-client.ts";

/** What a merge needs of a working copy the daemon reports. */
export interface MergeSide {
  readonly id: string | undefined;
  /** Its working tree as last reported; a merge holds only while this is unchanged. */
  readonly signature: string;
  readonly commonDir: string | undefined;
  readonly root: string;
  collisions(): Warning[];
  /** A commit holding its working tree, untracked files included. */
  snapshotCommit(): Promise<string>;
  refresh(): Promise<void>;
}

interface Result {
  a: string;
  b: string;
  signatureA: string;
  signatureB: string;
  conflicts: string[];
}

const pairKey = (x: string, y: string) => (x < y ? `${x}\0${y}` : `${y}\0${x}`);

/**
 * Merges pairs of live working copies one daemon reports, so their collisions are
 * confirmed or cleared by git rather than guessed from line numbers. Both are worktrees
 * of one repository on this machine, so each is a snapshot commit in the same object
 * store, and `git merge-tree` merges them exactly, uncommitted work included. A result
 * holds for the two working trees it merged: once either changes, it is dropped and the
 * merge redone. One merge runs at a time.
 */
export class LocalMerges {
  readonly #sides: () => Iterable<MergeSide>;
  readonly #log: Log;
  readonly #results = new Map<string, Result>();
  readonly #queue = new Map<string, [MergeSide, MergeSide]>();
  #running: Promise<void> | undefined;

  constructor(sides: () => Iterable<MergeSide>, log: Log) {
    this.#sides = sides;
    this.#log = log;
  }

  /**
   * The merges a side's heartbeat carries: those that still hold for both working trees.
   * A stale one is dropped, and its partner asked to report again, so neither side goes
   * on vouching for it.
   */
  for(side: MergeSide): LocalMerge[] {
    const merges: LocalMerge[] = [];
    if (!side.id) return merges;
    for (const [key, result] of this.#results) {
      if (result.a !== side.id && result.b !== side.id) continue;
      const otherId = result.a === side.id ? result.b : result.a;
      const other = this.#find(otherId);
      if (!other || !this.#holds(result)) {
        this.#results.delete(key);
        if (other) void other.refresh();
        continue;
      }
      merges.push({ working_copy_id: otherId, conflicts: result.conflicts });
    }
    return merges;
  }

  /** Queues a merge for each of a side's collisions with another live worktree of its repository. */
  schedule(side: MergeSide): void {
    if (!side.id || !side.commonDir) return;
    for (const warning of side.collisions()) {
      if (warning.peer.kind !== "live" || warning.peer.actor.type !== "cli") continue;
      const other = this.#find(warning.peer.working_copy_id);
      if (!other || other === side || other.commonDir !== side.commonDir) continue;
      const key = pairKey(side.id, warning.peer.working_copy_id);
      const known = this.#results.get(key);
      if (known && this.#holds(known)) continue;
      this.#queue.set(key, [side, other]);
    }
    this.#drain();
  }

  /** Waits for the merges in flight, for a clean stop. */
  async settle(): Promise<void> {
    this.#queue.clear();
    await this.#running;
  }

  #find(id: string): MergeSide | undefined {
    for (const side of this.#sides()) if (side.id === id) return side;
    return undefined;
  }

  #holds(result: Result): boolean {
    return (
      this.#find(result.a)?.signature === result.signatureA &&
      this.#find(result.b)?.signature === result.signatureB
    );
  }

  #drain(): void {
    if (this.#running) return;
    this.#running = (async () => {
      for (
        let next = this.#queue.entries().next();
        !next.done;
        next = this.#queue.entries().next()
      ) {
        const [key, [x, y]] = next.value;
        this.#queue.delete(key);
        const [a, b] = x.id! < y.id! ? [x, y] : [y, x];
        const signatureA = a.signature;
        const signatureB = b.signature;
        try {
          const ours = await a.snapshotCommit();
          const theirs = await b.snapshotCommit();
          // Either changed meanwhile: its next report asks again.
          if (a.signature !== signatureA || b.signature !== signatureB) continue;
          const merged = await mergeTree(a.root, ours, theirs);
          this.#results.set(key, {
            a: a.id!,
            b: b.id!,
            signatureA,
            signatureB,
            conflicts: merged.clean ? [] : merged.conflicts,
          });
          void a.refresh();
          void b.refresh();
        } catch (error) {
          this.#log.warn(
            { ours: a.root, theirs: b.root, reason: describeError(error) },
            "local merge failed",
          );
        }
      }
    })().finally(() => {
      this.#running = undefined;
    });
  }
}
