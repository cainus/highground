import type { CollisionEvent, Warning } from "@highground/core";
import {
  RANK,
  SEVERITY_RANK,
  warningOf,
  type Entry,
  type JudgedPair,
  type LiveIndex,
  type PathRef,
  type Verdict,
} from "./live-index.ts";

/** How one of a working copy's actors sees one peer actor. */
interface View {
  verdict: Verdict;
  peer: Entry;
  /** Type, severity, confirmation and approximation in one number: what is news when it changes. */
  code: number;
}

/**
 * One working copy's collision with one peer actor on one path. The working copy has a
 * view per actor of its own; what it is told is the most severe of them.
 */
interface Slot {
  workingCopyId: string;
  /** The viewing actor (a `peerKey`) → its view. */
  views: Map<string, View>;
  announced: View | undefined;
}

const CONFIRMED = { true: 1, false: 2, null: 0 } as const;
const codeOf = (v: Verdict) =>
  ((RANK[v.pair.type] * 4 + SEVERITY_RANK[v.severity]) * 3 + CONFIRMED[`${v.confirmed}`]) * 2 +
  (v.approximate ? 1 : 0);

/** The view a working copy is told about: the most severe type, then the highest code. */
function strongest(views: Map<string, View>): View | undefined {
  let best: View | undefined;
  for (const view of views.values()) {
    if (
      !best ||
      RANK[view.verdict.pair.type] > RANK[best.verdict.pair.type] ||
      (view.verdict.pair.type === best.verdict.pair.type && view.code > best.code)
    ) {
      best = view;
    }
  }
  return best;
}

export type EmitCollision = (repo: string, workingCopyId: string, event: CollisionEvent) => void;

/**
 * Turns index changes into per-working-copy collision events. After a change to a path
 * it updates the collisions there and emits the difference: a new collision, or a change
 * in its verdict — type, severity, confirmation or approximation — starts; a vanished
 * one ends. Lines moving under the same verdict stay quiet.
 *
 * A change that names its actor (`only`) carries just that actor's pairs, and only the
 * collisions it is in are updated. It keeps verdicts, not warnings: a warning is built
 * only for an event or a replay.
 */
export class CollisionTracker {
  /** `repo\0path` → working copy → peer actor → slot */
  readonly #state = new Map<string, Map<string, Map<string, Slot>>>();

  readonly #index: LiveIndex;
  readonly #emit: EmitCollision;

  constructor(index: LiveIndex, emit: EmitCollision) {
    this.#index = index;
    this.#emit = emit;
  }

  /** Paths that changed, with their pairs when the caller has judged them already. */
  refresh(paths: (PathRef & { pairs?: JudgedPair[]; only?: string })[], now: number): void {
    for (const { repo, path, pairs, only } of paths) {
      if (pairs) this.#refreshPath(repo, path, now, pairs, only);
      else this.#refreshPath(repo, path, now, this.#index.judge([{ repo, path }], now)[0]!.pairs);
    }
  }

  #refreshPath(repo: string, path: string, now: number, pairs: JudgedPair[], only?: string): void {
    const key = `${repo}\0${path}`;
    let byCopy = this.#state.get(key);
    if (!byCopy) this.#state.set(key, (byCopy = new Map()));
    const affected = new Set<Slot>();

    // Forget the views this change replaces: all of them, or the focused actor's.
    for (const byPeer of byCopy.values()) {
      for (const [peerId, slot] of byPeer) {
        if (only === undefined || peerId === only) {
          slot.views.clear();
          affected.add(slot);
        } else if (slot.views.delete(only)) {
          affected.add(slot);
        }
      }
    }

    const see = (viewer: Entry, peer: Entry, verdict: Verdict) => {
      let byPeer = byCopy.get(viewer.workingCopyId);
      if (!byPeer) byCopy.set(viewer.workingCopyId, (byPeer = new Map()));
      let slot = byPeer.get(peer.peerId);
      if (!slot) {
        slot = { workingCopyId: viewer.workingCopyId, views: new Map(), announced: undefined };
        byPeer.set(peer.peerId, slot);
      }
      slot.views.set(viewer.peerId, { verdict, peer, code: codeOf(verdict) });
      affected.add(slot);
    };
    for (const { a, b, ab, ba } of pairs) {
      if (ab) see(a, b, ab);
      if (ba) see(b, a, ba);
    }

    for (const slot of affected) {
      const best = strongest(slot.views);
      const before = slot.announced;
      if (best && best.code !== before?.code) {
        this.#emit(repo, slot.workingCopyId, {
          event: "collision_started",
          warning: warningOf(best.verdict, path, best.peer, now),
        });
      } else if (!best && before) {
        this.#emit(repo, slot.workingCopyId, {
          event: "collision_ended",
          warning: warningOf(before.verdict, path, before.peer, now),
        });
      }
      slot.announced = best;
    }

    // Drop what no longer collides.
    for (const [copy, byPeer] of byCopy) {
      for (const [peerId, slot] of byPeer) if (!slot.announced) byPeer.delete(peerId);
      if (byPeer.size === 0) byCopy.delete(copy);
    }
    if (byCopy.size === 0) this.#state.delete(key);
  }

  /** The collisions a working copy currently has, for replay when it (re)subscribes. */
  current(repo: string, workingCopyId: string, now = Date.now()): Warning[] {
    const warnings: Warning[] = [];
    for (const [key, byCopy] of this.#state) {
      if (!key.startsWith(`${repo}\0`)) continue;
      const path = key.slice(repo.length + 1);
      for (const slot of byCopy.get(workingCopyId)?.values() ?? []) {
        if (slot.announced) {
          warnings.push(warningOf(slot.announced.verdict, path, slot.announced.peer, now));
        }
      }
    }
    return warnings;
  }
}
