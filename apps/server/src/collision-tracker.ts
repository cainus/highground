import type { CollisionEvent, Warning } from "@highground/core";
import type { LiveIndex, PathRef } from "./live-index.ts";

export type EmitCollision = (repo: string, workingCopyId: string, event: CollisionEvent) => void;

/**
 * Turns index changes into per-working-copy collision events. After any change to a
 * path it recomputes the collisions of every working copy on that path and emits the
 * difference: a new collision, or a change in its type, starts; a vanished one ends.
 * Lines moving within the same type of collision stay quiet.
 */
export class CollisionTracker {
  /** `repo\0path` → working copy → peer actor → last warning */
  readonly #state = new Map<string, Map<string, Map<string, Warning>>>();

  readonly #index: LiveIndex;
  readonly #emit: EmitCollision;

  constructor(index: LiveIndex, emit: EmitCollision) {
    this.#index = index;
    this.#emit = emit;
  }

  refresh(paths: PathRef[], now: number): void {
    for (const { repo, path } of paths) this.#refreshPath(repo, path, now);
  }

  #refreshPath(repo: string, path: string, now: number): void {
    const key = `${repo}\0${path}`;
    const previous = this.#state.get(key) ?? new Map<string, Map<string, Warning>>();
    const next = this.#index.collisionsAt(repo, path, now);
    for (const workingCopyId of new Set([...next.keys(), ...previous.keys()])) {
      const current = next.get(workingCopyId) ?? new Map<string, Warning>();
      const before = previous.get(workingCopyId) ?? new Map<string, Warning>();
      for (const [peer, warning] of current) {
        if (before.get(peer)?.type !== warning.type) {
          this.#emit(repo, workingCopyId, { event: "collision_started", warning });
        }
      }
      for (const [peer, warning] of before) {
        if (!current.has(peer))
          this.#emit(repo, workingCopyId, { event: "collision_ended", warning });
      }
    }
    if (next.size > 0) this.#state.set(key, next);
    else this.#state.delete(key);
  }

  /** The collisions a working copy currently has, for replay when it (re)subscribes. */
  current(repo: string, workingCopyId: string): Warning[] {
    const warnings: Warning[] = [];
    for (const [key, byWorkingCopy] of this.#state) {
      if (!key.startsWith(`${repo}\0`)) continue;
      warnings.push(...(byWorkingCopy.get(workingCopyId)?.values() ?? []));
    }
    return warnings;
  }
}
