import { insertionAfter, type Range } from "./ranges.ts";

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The new side's lines; a following `\\ No newline at end of file` marker is kept as a line. */
  added: string[];
}

/** One changed range, with a digest of the content that replaces it (null when unknown). */
export interface Change {
  range: Range;
  digest: string | null;
}

/** Digests a change's new lines; must distinguish `[]` (deletion) from `[""]` (blank line). */
export type Digest = (lines: string[]) => string;

/** One file's entry in a `git diff -U0 -M` patch. A null path means the file is absent on that side. */
export interface FileDiff {
  basePath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: Hunk[];
}

/** One path's unmerged changes, in base coordinates (PRD §3.2). */
export interface FileReport {
  path: string;
  wholeFile: boolean;
  changes: Change[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** Reverses git's C-style quoting of unusual paths (`"caf\303\251"` → `café`). */
export function unquotePath(text: string): string {
  if (!text.startsWith('"')) return text;
  const bytes: number[] = [];
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i] as string;
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Strips the `a/` or `b/` prefix from a patch path; `/dev/null` means the side is absent. */
function sidePath(raw: string): string | null {
  const path = unquotePath(raw.replace(/\t$/, ""));
  return path === "/dev/null" ? null : path.slice(2);
}

/**
 * Paths from a `diff --git` header. Used only when no `---`/`+++` or rename lines
 * name the file (binary and mode-only changes), where both sides share one path.
 */
function headerPath(rest: string): string {
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ', 1);
    return unquotePath(rest.slice(0, end + 1)).slice(2);
  }
  return rest.slice(2, (rest.length - 1) / 2);
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let hunk: Hunk | undefined;
  // Lines still to read in the current hunk body. Counting them, rather than matching
  // prefixes, keeps content such as "--- x" or "+++ x" from being read as a header.
  let oldLeft = 0;
  let newLeft = 0;
  let lastSide: "-" | "+" | undefined;

  for (const line of text.split("\n")) {
    if (hunk && (oldLeft > 0 || newLeft > 0 || line.startsWith("\\"))) {
      if (line.startsWith("\\")) {
        if (lastSide === "+") hunk.added.push(line);
      } else if (line.startsWith("-")) {
        oldLeft--;
        lastSide = "-";
      } else {
        hunk.added.push(line.slice(1));
        newLeft--;
        lastSide = "+";
      }
      continue;
    }
    hunk = undefined;
    if (line.startsWith("diff --git ")) {
      const path = headerPath(line.slice("diff --git ".length));
      current = { basePath: path, newPath: path, binary: false, hunks: [] };
      files.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("@@")) {
      const match = HUNK_HEADER.exec(line);
      if (!match) throw new Error(`unreadable hunk header: ${line}`);
      hunk = {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        added: [],
      };
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      lastSide = undefined;
      current.hunks.push(hunk);
    } else if (line.startsWith("--- ")) {
      current.basePath = sidePath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      current.newPath = sidePath(line.slice(4));
    } else if (line.startsWith("rename from ")) {
      current.basePath = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.newPath = unquotePath(line.slice("rename to ".length));
    } else if (line.startsWith("new file mode")) {
      current.basePath = null;
    } else if (line.startsWith("deleted file mode")) {
      current.newPath = null;
    } else if (line.startsWith("Binary files ")) {
      current.binary = true;
    }
  }
  return files;
}

/** The base lines a hunk changes; a pure insertion is the insertion point after its base line. */
export function hunkToRange(hunk: Hunk): Range {
  if (hunk.oldCount === 0) return insertionAfter(hunk.oldStart);
  return [hunk.oldStart, hunk.oldStart + hunk.oldCount - 1];
}

/**
 * Converts parsed diffs into per-path reports in base coordinates. Added, deleted and
 * binary files are whole-file; a rename reports its edits under the base path and the
 * new path as whole-file, so two people creating the same path collide. Each change
 * carries a digest of its new content, so identical changes can be recognised.
 */
export function reportsFromDiff(files: FileDiff[], digest: Digest): FileReport[] {
  const reports: FileReport[] = [];
  for (const file of files) {
    const { basePath, newPath } = file;
    if (basePath === null || newPath === null) {
      reports.push({ path: (basePath ?? newPath) as string, wholeFile: true, changes: [] });
    } else if (file.binary) {
      reports.push({ path: basePath, wholeFile: true, changes: [] });
    } else {
      const changes = file.hunks.map((h) => ({ range: hunkToRange(h), digest: digest(h.added) }));
      reports.push({ path: basePath, wholeFile: false, changes });
    }
    if (basePath !== null && newPath !== null && basePath !== newPath) {
      reports.push({ path: newPath, wholeFile: true, changes: [] });
    }
  }
  return reports;
}
