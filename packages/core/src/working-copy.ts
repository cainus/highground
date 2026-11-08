import type { Change, Hunk } from "./diff.ts";
import { gap, type Range } from "./ranges.ts";
import { translate, type Translation } from "./translate.ts";

/**
 * Names a GitHub-style repository from a remote URL as `host/owner/name`: scp-like
 * (`git@host:owner/name.git`), or https, ssh or git URLs. Null for local paths and for
 * anything that is not exactly an owner and a name.
 */
export function repoFromRemote(url: string): string | null {
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(url);
  let host: string;
  let path: string;
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    const parsed = URL.canParse(url) ? new URL(url) : null;
    if (!parsed || !["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    path = parsed.pathname;
  }
  const parts = path
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2) return null;
  return `${host.toLowerCase()}/${parts[0]}/${parts[1]}`;
}

/** The hunks of `diff B A`, given those of `diff A B`. */
export function invertHunks(hunks: Hunk[]): Hunk[] {
  return hunks.map((h) => ({
    oldStart: h.newStart,
    oldCount: h.newCount,
    newStart: h.oldStart,
    newCount: h.oldCount,
    added: [],
  }));
}

/**
 * Maps one file's working-copy range to base coordinates, given the hunks of
 * `diff base worktree` for that file. A range inside the actor's own change widens to
 * the base lines that change replaced, since those are what can conflict.
 */
export function toBase(range: Range, hunks: Hunk[]): Translation {
  return translate(range, invertHunks(hunks));
}

/** Maps a base range into one file's working-copy lines; the inverse of `toBase`. */
export function toWorking(range: Range, hunks: Hunk[]): Translation {
  return translate(range, hunks);
}

/**
 * At most `max` changes covering every line of `changes`, by repeatedly merging the
 * two neighbours with the fewest unchanged lines between them. A merged change
 * carries no digest, since it no longer stands for one replacement.
 */
export function capChanges(changes: Change[], max: number): Change[] {
  const sorted = [...changes].sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1]);
  while (sorted.length > max) {
    let best = 0;
    for (let i = 1; i < sorted.length - 1; i++) {
      if (
        gap(sorted[i]!.range, sorted[i + 1]!.range) <
        gap(sorted[best]!.range, sorted[best + 1]!.range)
      ) {
        best = i;
      }
    }
    const [a, b] = [sorted[best]!.range, sorted[best + 1]!.range];
    sorted.splice(best, 2, {
      range: [Math.min(a[0], b[0]), Math.max(a[1], b[1])],
      digest: null,
    });
  }
  return sorted;
}
