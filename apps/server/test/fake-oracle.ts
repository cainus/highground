import { invertHunks, type Hunk } from "@highground/core";
import type { Oracle } from "../src/live-index.ts";

export const hunk = (
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): Hunk => ({
  oldStart,
  oldCount,
  newStart,
  newCount,
  added: [],
});

/** Five lines were added at the top of a.ts between OTHER_SHA and SHA. */
export const OTHER_TO_SHA = [hunk(0, 0, 1, 5)];

export class FakeOracle implements Oracle {
  readonly asked: string[] = [];
  hunksBetween = new Map<string, Hunk[]>();
  merged = new Map<string, string[]>();
  heads = new Map<string, string>();

  hunks(repo: string, from: string, to: string, path: string): Hunk[] | undefined {
    this.asked.push(`hunks ${from.slice(0, 1)}→${to.slice(0, 1)} ${path}`);
    return this.hunksBetween.get(`${from}${to}${path}`);
  }
  conflicts(repo: string, a: string, b: string, path: string): string[] | undefined {
    this.asked.push(`merge ${path}`);
    return this.merged.get([a, b].sort().join(""));
  }
  defaultHead(repo: string): string | undefined {
    return this.heads.get(repo);
  }
  knowsTranslation(from: string, to: string, path: string, hunks: Hunk[]) {
    this.hunksBetween.set(`${from}${to}${path}`, hunks);
    this.hunksBetween.set(`${to}${from}${path}`, invertHunks(hunks));
  }
}
