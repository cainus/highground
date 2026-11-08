import {
  strongestPair,
  translate,
  type Actor,
  type Change,
  type CollisionType,
  type Heartbeat,
  type Hunk,
  type Kind,
  type MergeResult,
  type Pair,
  type RadarCollision,
  type RadarFile,
  type RadarWork,
  type Warning,
} from "@highground/core";

/**
 * What the mirror knows, answered synchronously from its cache. `undefined` means not
 * yet: the oracle queues the git work and later names the path to refresh.
 */
export interface Oracle {
  /** The hunks of `git diff from to -- path`. */
  hunks(repo: string, from: string, to: string, path: string): Hunk[] | undefined;
  /** The paths a speculative merge of two heads conflicts on; `path` is the one asking. */
  conflicts(repo: string, headA: string, headB: string, path: string): string[] | undefined;
  /** The default branch's head as of the last fetch: the radar's display base. */
  defaultHead?(repo: string): string | undefined;
}

/** One side of a comparison: a stored entry, or the changes someone is asking about. */
interface Side {
  workingCopyId: string;
  baseSha: string;
  /** Unknown for a query that did not say. */
  branch: string | undefined;
  kind: Kind;
  headSha: string | null;
  lastCommitAt: number | null;
  merges: readonly MergeResult[];
  wholeFile: boolean;
  changes: readonly Change[];
}

/** One actor's current changes to one path in one working copy. */
export interface Entry extends Side {
  repo: string;
  actor: Actor;
  author: string;
  branch: string;
  path: string;
  changes: Change[];
  intent: string | null;
  prUrl: string | null;
  receivedAt: number;
  expiresAt: number;
}

/** How one side sees a collision with another. */
interface Verdict {
  pair: Pair;
  severity: Warning["severity"];
  approximate: boolean;
  confirmed: boolean | null;
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
  branch?: string;
  kind?: Kind;
  headSha?: string | null;
  lastCommitAt?: number | null;
  merges?: readonly MergeResult[];
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
const SEVERITY_RANK: Record<Warning["severity"], number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const RANK: Record<CollisionType, number> = {
  DIRECT_OVERLAP: 3,
  DUPLICATE_CHANGE: 2,
  PROXIMITY_ALERT: 1,
};
const LOWER: Record<Warning["severity"], Warning["severity"]> = {
  HIGH: "MEDIUM",
  MEDIUM: "LOW",
  LOW: "LOW",
};
/** Parked or pushed work with no commit for this long drops one severity. */
const DORMANT_MS = 7 * 86_400_000;

const isDormant = (side: Side, now: number) =>
  side.kind !== "live" && side.lastCommitAt !== null && now - side.lastCommitAt > DORMANT_MS;

/** A colliding pair of entries, and how bad it is. */
/** Two entries on one path that collide, with how each sees the other. */
export interface JudgedPair {
  a: Entry;
  b: Entry;
  ab: Verdict | null;
  ba: Verdict | null;
}

/** A changed path with its pairs judged once. */
export interface JudgedPath extends PathRef {
  pairs: JudgedPair[];
}

export interface CollidingPair {
  a: Entry;
  b: Entry;
  collision: Omit<RadarCollision, "a" | "b">;
}

const radarIds = new WeakMap<Entry, string>();
/** Names one actor's work on a file in the radar; computed once per entry. */
export function radarId(entry: Entry): string {
  let id = radarIds.get(entry);
  if (id === undefined) {
    id = `${entry.workingCopyId}:${entry.actor.type}:${entry.actor.id}`;
    radarIds.set(entry, id);
  }
  return id;
}

function mostCommonBase(entries: Entry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.baseSha, (counts.get(entry.baseSha) ?? 0) + 1);
  return [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
}

/** The verdict that is worse: by severity, then by type. */
function stronger(x: Verdict | null, y: Verdict | null): Verdict | null {
  if (!x || !y) return x ?? y;
  const bySeverity = SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity];
  if (bySeverity !== 0) return bySeverity > 0 ? y : x;
  return RANK[y.pair.type] > RANK[x.pair.type] ? y : x;
}

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
  readonly #oracle: Oracle | undefined;
  /** pathKey → actorKey → entry */
  readonly #byPath = new Map<string, Map<string, Entry>>();
  /** actorKey → paths that actor has entries for */
  readonly #byActor = new Map<string, Set<string>>();

  constructor(oracle?: Oracle) {
    this.#oracle = oracle;
  }

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
        kind: heartbeat.kind,
        headSha: heartbeat.head_sha,
        lastCommitAt: heartbeat.last_commit_at ? Date.parse(heartbeat.last_commit_at) : null,
        prUrl: heartbeat.pr_url,
        merges: heartbeat.merges,
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
    const asker: Side = {
      workingCopyId: request.workingCopyId,
      baseSha: request.baseSha,
      branch: request.branch,
      kind: request.kind ?? "live",
      headSha: request.headSha ?? null,
      lastCommitAt: request.lastCommitAt ?? null,
      merges: request.merges ?? [],
      wholeFile: request.wholeFile ?? false,
      changes: request.changes,
    };
    const warnings: Warning[] = [];
    for (const peer of this.entriesAt(request.repo, request.path, now)) {
      const verdict = this.#judge(request.repo, request.path, asker, peer, now);
      if (verdict) warnings.push(warningOf(verdict, request.path, peer, now));
    }
    return warnings.sort((a, b) => RANK[b.type] - RANK[a.type]);
  }

  /**
   * Every working copy's collisions on one path: working copy → peer actor → its most
   * severe warning.
   */
  collisionsAt(
    repo: string,
    path: string,
    now: number,
    pairs: JudgedPair[] = this.#pairsAt(repo, path, now),
  ): Map<string, Map<string, Warning>> {
    const result = new Map<string, Map<string, Warning>>();
    const keep = (workingCopyId: string, peer: Entry, warning: Warning) => {
      let byPeer = result.get(workingCopyId);
      if (!byPeer) result.set(workingCopyId, (byPeer = new Map()));
      const key = peerKey(peer.workingCopyId, peer.actor);
      const held = byPeer.get(key);
      if (!held || RANK[warning.type] > RANK[held.type]) byPeer.set(key, warning);
    };
    for (const { a, b, ab, ba } of pairs) {
      if (ab) keep(a.workingCopyId, b, warningOf(ab, path, b, now));
      if (ba) keep(b.workingCopyId, a, warningOf(ba, path, a, now));
    }
    return result;
  }

  /**
   * Every file in a repository with live entries (PRD §10): each actor's work, its lines
   * in the file's display base — the default branch's head when the mirror knows it, else
   * the base most of the file's work shares — and each colliding pair once, judged from
   * the side that sees it worse. Files with the worst collisions come first.
   */
  radar(repo: string, now: number): RadarFile[] {
    const files: { file: RadarFile; worst: number }[] = [];
    const prefix = `${repo}\0`;
    for (const pKey of this.#byPath.keys()) {
      if (!pKey.startsWith(prefix)) continue;
      const path = pKey.slice(prefix.length);
      const entries = this.entriesAt(repo, path, now);
      if (entries.length === 0) continue;
      const base = this.#oracle?.defaultHead?.(repo) ?? mostCommonBase(entries);
      const work = entries.map((entry) => this.#radarWork(entry, path, base, now));
      const collisions: RadarCollision[] = [];
      let worst = 0;
      for (const { a, b, collision } of this.collidingPairs(repo, path, now)) {
        worst = Math.max(worst, SEVERITY_RANK[collision.severity]);
        collisions.push({ a: radarId(a), b: radarId(b), ...collision });
      }
      files.push({ file: { path, base_sha: base, work, collisions }, worst });
    }
    return files
      .sort((x, y) => y.worst - x.worst || x.file.path.localeCompare(y.file.path))
      .map(({ file }) => file);
  }

  /** Each colliding pair of entries on a path once, with the worse of its two verdicts. */
  collidingPairs(
    repo: string,
    path: string,
    now: number,
    pairs: JudgedPair[] = this.#pairsAt(repo, path, now),
  ): CollidingPair[] {
    const result: CollidingPair[] = [];
    for (const { a, b, ab, ba } of pairs) {
      const verdict = stronger(ab, ba);
      if (!verdict) continue;
      result.push({
        a,
        b,
        collision: {
          type: verdict.pair.type,
          severity: verdict.severity,
          confirmed: verdict.confirmed,
          approximate: verdict.approximate,
        },
      });
    }
    return result;
  }

  /**
   * Judges every pair on each path once, so everything that follows one change (warning
   * streams, history) shares the work instead of repeating it.
   */
  judge(paths: PathRef[], now: number): JudgedPath[] {
    return paths.map(({ repo, path }) => ({ repo, path, pairs: this.#pairsAt(repo, path, now) }));
  }

  /** Every path with entries, expired or not. */
  paths(): PathRef[] {
    return [...this.#byPath.values()].flatMap((entries) => {
      const [first] = entries.values();
      return first ? [{ repo: first.repo, path: first.path }] : [];
    });
  }

  #radarWork(entry: Entry, path: string, base: string, now: number): RadarWork {
    let lines = entry.changes.map((c) => c.range);
    let approximate = false;
    if (entry.baseSha !== base && !entry.wholeFile) {
      const hunks = this.#oracle?.hunks(entry.repo, entry.baseSha, base, path);
      if (!hunks) {
        approximate = true;
      } else {
        lines = lines.map((range) => {
          const translated = translate(range, hunks);
          if (!translated.exact) approximate = true;
          return translated.range;
        });
      }
    }
    return {
      id: radarId(entry),
      working_copy_id: entry.workingCopyId,
      actor: entry.actor,
      author: entry.author,
      kind: entry.kind,
      branch: entry.branch,
      head_sha: entry.headSha,
      pr_url: entry.prUrl,
      base_sha: entry.baseSha,
      whole_file: entry.wholeFile,
      lines,
      approximate,
      intent: entry.intent,
      last_heartbeat_seconds_ago: Math.max(0, Math.floor((now - entry.receivedAt) / 1000)),
    };
  }

  /**
   * Every pair of entries on one path, with how each side sees the other. Each pair is
   * judged once per side — once in all when the two share a base, since the verdict is
   * then symmetric.
   */
  #pairsAt(repo: string, path: string, now: number): JudgedPair[] {
    const entries = this.entriesAt(repo, path, now);
    const pairs: JudgedPair[] = [];
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i] as Entry;
      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j] as Entry;
        const ab = this.#judge(repo, path, a, b, now);
        const ba =
          a.baseSha === b.baseSha
            ? ab && { ...ab, pair: { ...ab.pair, ours: ab.pair.theirs, theirs: ab.pair.ours } }
            : this.#judge(repo, path, b, a, now);
        if (ab || ba) pairs.push({ a, b, ab, ba });
      }
    }
    return pairs;
  }

  /**
   * How `viewer` sees `peer` on one path, in the viewer's base: suppression first, then
   * the peer's lines translated into the viewer's base, the strongest pair, a speculative
   * merge's confirmation, and dormancy.
   */
  #judge(repo: string, path: string, viewer: Side, peer: Side, now: number): Verdict | null {
    if (viewer.workingCopyId === peer.workingCopyId) return null;
    // Work and the pushed copy of its own branch are one line of work.
    const onePushed = (viewer.kind === "pushed") !== (peer.kind === "pushed");
    if (onePushed && viewer.branch !== undefined && viewer.branch === peer.branch) return null;

    let theirs = peer.changes;
    let approximate = false;
    if (peer.baseSha !== viewer.baseSha && !peer.wholeFile && !viewer.wholeFile) {
      const hunks = this.#oracle?.hunks(repo, peer.baseSha, viewer.baseSha, path);
      if (!hunks) {
        approximate = true;
      } else {
        theirs = peer.changes.map((change) => {
          const translated = translate(change.range, hunks);
          if (!translated.exact) approximate = true;
          return { range: translated.range, digest: change.digest };
        });
      }
    }
    const pair = strongestPair(
      { path, wholeFile: viewer.wholeFile, changes: [...viewer.changes] },
      { path, wholeFile: peer.wholeFile, changes: [...theirs] },
    );
    if (!pair) return null;

    const confirmed =
      pair.type === "PROXIMITY_ALERT" ? null : this.#confirmation(repo, path, viewer, peer);
    let severity = SEVERITY[pair.type];
    if (confirmed === false) severity = "MEDIUM";
    if (isDormant(viewer, now) || isDormant(peer, now)) severity = LOWER[severity];
    return { pair, severity, approximate, confirmed };
  }

  /**
   * Whether a speculative merge found the two sides conflicting on `path`: the mirror's
   * merge for pushed against pushed, the daemon's reported merge with the pushed side's
   * current head otherwise. Null when no merge of these exact commits is known.
   */
  #confirmation(repo: string, path: string, viewer: Side, peer: Side): boolean | null {
    if (viewer.kind === "pushed" && peer.kind === "pushed") {
      if (!viewer.headSha || !peer.headSha) return null;
      const conflicts = this.#oracle?.conflicts(repo, viewer.headSha, peer.headSha, path);
      return conflicts ? conflicts.includes(path) : null;
    }
    const [own, pushed] =
      peer.kind === "pushed" ? [viewer, peer] : viewer.kind === "pushed" ? [peer, viewer] : [];
    if (!own || !pushed) return null;
    const merge = own.merges.find(
      (m) => m.branch === pushed.branch && m.head_sha === pushed.headSha,
    );
    return merge ? merge.conflicts.includes(path) : null;
  }

  /** Unexpired entries for one path. */
  entriesAt(repo: string, path: string, now: number): Entry[] {
    const entries = this.#byPath.get(pathKey(repo, path));
    return entries ? [...entries.values()].filter((e) => e.expiresAt > now) : [];
  }

  /** The working copies of one kind in a repo, with one actor each: for clearing vanished branches. */
  workingCopiesOfKind(repo: string, kind: Kind): Map<string, ActorState> {
    const result = new Map<string, ActorState>();
    for (const [pKey, entries] of this.#byPath) {
      if (!pKey.startsWith(`${repo}\0`)) continue;
      for (const entry of entries.values()) {
        if (entry.kind === kind && !result.has(entry.workingCopyId)) {
          result.set(entry.workingCopyId, {
            actor: entry.actor,
            author: entry.author,
            branch: entry.branch,
            baseSha: entry.baseSha,
          });
        }
      }
    }
    return result;
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
function warningOf(verdict: Verdict, path: string, peer: Entry, now: number): Warning {
  return {
    severity: verdict.severity,
    type: verdict.pair.type,
    path,
    your_lines: verdict.pair.ours?.range ?? null,
    peer: {
      working_copy_id: peer.workingCopyId,
      actor: peer.actor,
      author: peer.author,
      kind: peer.kind,
      branch: peer.branch,
      head_sha: peer.headSha,
      pr_url: peer.prUrl,
      lines: verdict.pair.theirs?.range ?? null,
      intent: peer.intent,
      last_heartbeat_seconds_ago: Math.floor((now - peer.receivedAt) / 1000),
    },
    approximate: verdict.approximate,
    confirmed: verdict.confirmed,
  };
}
