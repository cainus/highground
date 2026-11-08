import {
  strongestPair,
  type Actor,
  type Pair,
  type Change,
  type CollisionType,
  type Heartbeat,
  type Warning,
} from "@highground/core";

/** One actor's current changes to one path in one working copy. */
export interface Entry {
  repo: string;
  workingCopyId: string;
  actor: Actor;
  author: string;
  branch: string;
  baseSha: string;
  path: string;
  wholeFile: boolean;
  changes: Change[];
  intent: string | null;
  receivedAt: number;
  expiresAt: number;
}

export interface PathRef {
  repo: string;
  path: string;
}

/** What a working copy is asking about: its own changes to one path. */
export interface WarningsRequest {
  repo: string;
  path: string;
  workingCopyId: string;
  baseSha: string;
  changes: readonly Change[];
  wholeFile?: boolean;
}

export interface ActorState {
  actor: Actor;
  author: string;
  branch: string;
  baseSha: string;
}

const SEVERITY: Record<CollisionType, Warning["severity"]> = {
  DIRECT_OVERLAP: "HIGH",
  DUPLICATE_CHANGE: "MEDIUM",
  PROXIMITY_ALERT: "MEDIUM",
};
const RANK: Record<CollisionType, number> = {
  DIRECT_OVERLAP: 3,
  DUPLICATE_CHANGE: 2,
  PROXIMITY_ALERT: 1,
};

const pathKey = (repo: string, path: string) => `${repo}\0${path}`;
/** Identifies a peer actor across working copies. */
export const peerKey = (workingCopyId: string, actor: Actor) =>
  `${workingCopyId}\0${actor.type}\0${actor.id}`;
const actorKey = (repo: string, workingCopyId: string, actor: Actor) =>
  `${repo}\0${workingCopyId}\0${actor.type}\0${actor.id}`;

/**
 * The in-memory projection of the heartbeat log (ADR 0002): every live entry, indexed
 * by path for warning queries. Pure — the caller supplies the time.
 */
export class LiveIndex {
  /** pathKey → actorKey → entry */
  readonly #byPath = new Map<string, Map<string, Entry>>();
  /** actorKey → paths that actor has entries for */
  readonly #byActor = new Map<string, Set<string>>();

  get size(): number {
    let count = 0;
    for (const entries of this.#byPath.values()) count += entries.size;
    return count;
  }

  /** Applies a heartbeat received at `at` (ms); returns every path whose entries changed. */
  apply(heartbeat: Heartbeat, at: number): PathRef[] {
    const { repo, working_copy_id: workingCopyId, actor } = heartbeat;
    const aKey = actorKey(repo, workingCopyId, actor);
    const touched = new Map<string, PathRef>();
    const listed = new Set(heartbeat.files.map((f) => f.path));

    if (heartbeat.scope === "complete") {
      // A copy: #remove deletes from this same set while we iterate.
      for (const pKey of Array.from(this.#byActor.get(aKey) ?? [])) {
        const path = pKey.slice(repo.length + 1);
        if (!listed.has(path)) {
          this.#remove(aKey, repo, path);
          touched.set(pathKey(repo, path), { repo, path });
        }
      }
    }
    for (const file of heartbeat.files) {
      touched.set(pathKey(repo, file.path), { repo, path: file.path });
      if (file.changes.length === 0 && !file.whole_file) {
        this.#remove(aKey, repo, file.path);
        continue;
      }
      this.#put(aKey, {
        repo,
        workingCopyId,
        actor,
        author: heartbeat.author,
        branch: heartbeat.branch,
        baseSha: heartbeat.base_sha,
        path: file.path,
        wholeFile: file.whole_file,
        changes: file.changes,
        intent: file.intent,
        receivedAt: at,
        expiresAt: at + heartbeat.ttl_seconds * 1000,
      });
    }
    return [...touched.values()];
  }

  /** Removes entries expired at `now`; returns the paths they were on. */
  expire(now: number): PathRef[] {
    const touched = new Map<string, PathRef>();
    for (const [pKey, entries] of this.#byPath) {
      for (const [aKey, entry] of entries) {
        if (entry.expiresAt <= now) {
          this.#remove(aKey, entry.repo, entry.path);
          touched.set(pKey, { repo: entry.repo, path: entry.path });
        }
      }
    }
    return [...touched.values()];
  }

  /** Warnings for the requester's changes: one per peer actor, from its most severe pair. */
  warnings(request: WarningsRequest, now: number): Warning[] {
    const ours = {
      path: request.path,
      wholeFile: request.wholeFile ?? false,
      changes: [...request.changes],
    };
    const warnings: Warning[] = [];
    for (const peer of this.entriesAt(request.repo, request.path, now)) {
      if (peer.workingCopyId === request.workingCopyId) continue;
      const pair = strongestPair(ours, {
        path: peer.path,
        wholeFile: peer.wholeFile,
        changes: peer.changes,
      });
      if (pair)
        warnings.push(warningOf(pair, request.path, peer, peer.baseSha !== request.baseSha, now));
    }
    return warnings.sort((a, b) => RANK[b.type] - RANK[a.type]);
  }

  /**
   * Every working copy's collisions on one path: working copy → peer actor → its most
   * severe warning. Each pair of entries is compared once and seen from both sides,
   * since a collision is symmetric.
   */
  collisionsAt(repo: string, path: string, now: number): Map<string, Map<string, Warning>> {
    const entries = this.entriesAt(repo, path, now);
    const result = new Map<string, Map<string, Warning>>();
    const keep = (workingCopyId: string, peer: Entry, warning: Warning) => {
      let byPeer = result.get(workingCopyId);
      if (!byPeer) result.set(workingCopyId, (byPeer = new Map()));
      const key = peerKey(peer.workingCopyId, peer.actor);
      const held = byPeer.get(key);
      if (!held || RANK[warning.type] > RANK[held.type]) byPeer.set(key, warning);
    };
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i] as Entry;
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j] as Entry;
        if (a.workingCopyId === b.workingCopyId) continue;
        const pair = strongestPair(a, b);
        if (!pair) continue;
        const approximate = a.baseSha !== b.baseSha;
        keep(a.workingCopyId, b, warningOf(pair, path, b, approximate, now));
        keep(
          b.workingCopyId,
          a,
          warningOf({ ...pair, ours: pair.theirs, theirs: pair.ours }, path, a, approximate, now),
        );
      }
    }
    return result;
  }

  /** Unexpired entries for one path. */
  entriesAt(repo: string, path: string, now: number): Entry[] {
    const entries = this.#byPath.get(pathKey(repo, path));
    return entries ? [...entries.values()].filter((e) => e.expiresAt > now) : [];
  }

  /** The actors with entries in a working copy, for clearing it when its stream goes away. */
  actorsOf(repo: string, workingCopyId: string): ActorState[] {
    const prefix = `${repo}\0${workingCopyId}\0`;
    const states: ActorState[] = [];
    for (const [aKey, paths] of this.#byActor) {
      if (!aKey.startsWith(prefix)) continue;
      const [first] = paths;
      const entry = this.#byPath.get(first as string)?.get(aKey) as Entry;
      states.push({
        actor: entry.actor,
        author: entry.author,
        branch: entry.branch,
        baseSha: entry.baseSha,
      });
    }
    return states;
  }

  #put(aKey: string, entry: Entry): void {
    const pKey = pathKey(entry.repo, entry.path);
    let entries = this.#byPath.get(pKey);
    if (!entries) this.#byPath.set(pKey, (entries = new Map()));
    entries.set(aKey, entry);
    let paths = this.#byActor.get(aKey);
    if (!paths) this.#byActor.set(aKey, (paths = new Set()));
    paths.add(pKey);
  }

  #remove(aKey: string, repo: string, path: string): void {
    const pKey = pathKey(repo, path);
    const entries = this.#byPath.get(pKey);
    entries?.delete(aKey);
    if (entries?.size === 0) this.#byPath.delete(pKey);
    const paths = this.#byActor.get(aKey);
    paths?.delete(pKey);
    if (paths?.size === 0) this.#byActor.delete(aKey);
  }
}

/** The warning one side sees about a peer entry. */
function warningOf(
  pair: Pair,
  path: string,
  peer: Entry,
  approximate: boolean,
  now: number,
): Warning {
  return {
    severity: SEVERITY[pair.type],
    type: pair.type,
    path,
    your_lines: pair.ours?.range ?? null,
    peer: {
      working_copy_id: peer.workingCopyId,
      actor: peer.actor,
      author: peer.author,
      kind: "live",
      branch: peer.branch,
      pr_url: null,
      lines: pair.theirs?.range ?? null,
      intent: peer.intent,
      last_heartbeat_seconds_ago: Math.floor((now - peer.receivedAt) / 1000),
    },
    approximate,
    confirmed: null,
  };
}
