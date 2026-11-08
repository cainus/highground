import type { CollisionEvent, Warning } from "@highground/core";
import type { JudgedPair, LiveIndex, PathRef } from "./live-index.ts";

/** What about a collision is worth announcing again when it changes. */
const verdictOf = (w: Warning) => `${w.type}/${w.severity}/${w.confirmed}/${w.approximate}`;

export type EmitCollision = (repo: string, workingCopyId: string, event: CollisionEvent) => void;

/**
 * Turns index changes into per-working-copy collision events. After any change to a
 * path it recomputes the collisions of every working copy on that path and emits the
 * difference: a new collision, or a change in its verdict — type, severity, confirmation
 * or approximation — starts; a vanished one ends. Lines moving under the same verdict
 * stay quiet.
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

  /** Paths that changed, with their pairs when the caller has judged them already. */
  refresh(paths: (PathRef & { pairs?: JudgedPair[] })[], now: number): void {
    for (const { repo, path, pairs } of paths) this.#refreshPath(repo, path, now, pairs);
  }

  #refreshPath(repo: string, path: string, now: number, pairs?: JudgedPair[]): void {
    const key = `${repo}\0${path}`;
    const previous = this.#state.get(key) ?? new Map<string, Map<string, Warning>>();
    const next = this.#index.collisionsAt(repo, path, now, pairs);
    for (const workingCopyId of new Set([...next.keys(), ...previous.keys()])) {
      const current = next.get(workingCopyId) ?? new Map<string, Warning>();
      const before = previous.get(workingCopyId) ?? new Map<string, Warning>();
      for (const [peer, warning] of current) {
        const held = before.get(peer);
        if (!held || verdictOf(held) !== verdictOf(warning)) {
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
