import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { collide, type FileReport } from "@highground/core";
import { diffRanges, mergeTree } from "../src/index.ts";
import { cleanupRepos, commitAll, makeRepo, run, write } from "./helpers.ts";

afterAll(cleanupRepos);

const RUNS = Number(process.env.ORACLE_RUNS ?? 200);
const FILE = "f.txt";

type Fate = "keep" | "modify" | "delete";
interface SideEdit {
  fates: Fate[];
  inserts: number[]; // inserts[i] = lines inserted after base line i (0 = top)
}

const fate: fc.Arbitrary<Fate> = fc.oneof(
  { arbitrary: fc.constant<Fate>("keep"), weight: 6 },
  { arbitrary: fc.constant<Fate>("modify"), weight: 1 },
  { arbitrary: fc.constant<Fate>("delete"), weight: 1 },
);
const insertCount = fc.oneof(
  { arbitrary: fc.constant(0), weight: 8 },
  { arbitrary: fc.integer({ min: 1, max: 2 }), weight: 1 },
);
const sideEdit = (size: number): fc.Arbitrary<SideEdit> =>
  fc.record({
    fates: fc.array(fate, { minLength: size, maxLength: size }),
    inserts: fc.array(insertCount, { minLength: size + 1, maxLength: size + 1 }),
  });
const scenario = fc
  .integer({ min: 1, max: 25 })
  .chain((size) => fc.tuple(fc.constant(size), sideEdit(size), sideEdit(size)));

function baseLines(size: number): string[] {
  return Array.from({ length: size }, (_, i) => `base${i + 1}`);
}

/** Applies a side's edit script; its new content is tagged so the two sides never coincide. */
function render(size: number, edit: SideEdit, tag: string): string {
  let next = 0;
  const fresh = (count: number) => Array.from({ length: count }, () => `${tag}${++next}`);
  const out = fresh(edit.inserts[0] ?? 0);
  baseLines(size).forEach((line, i) => {
    if (edit.fates[i] === "keep") out.push(line);
    if (edit.fates[i] === "modify") out.push(...fresh(1));
    out.push(...fresh(edit.inserts[i + 1] ?? 0));
  });
  return out.map((line) => `${line}\n`).join("");
}

function reportFor(reports: FileReport[]): FileReport {
  return reports.find((r) => r.path === FILE) ?? { path: FILE, wholeFile: false, changes: [] };
}

/** Exactly one change per side — modify or delete a span, or insert — so nothing masks a wrong rule. */
const singleEdit = (size: number): fc.Arbitrary<SideEdit> =>
  fc
    .record({
      kind: fc.constantFrom<"modify" | "delete" | "insert">("modify", "delete", "insert"),
      start: fc.integer({ min: 0, max: size - 1 }),
      length: fc.integer({ min: 1, max: 3 }),
    })
    .map(({ kind, start, length }) => {
      const fates: Fate[] = Array(size).fill("keep");
      const inserts: number[] = Array(size + 1).fill(0);
      if (kind === "insert") inserts[start] = length;
      else for (let i = start; i < Math.min(size, start + length); i++) fates[i] = kind;
      return { fates, inserts };
    });
const singleScenario = fc
  .integer({ min: 1, max: 12 })
  .chain((size) => fc.tuple(fc.constant(size), singleEdit(size), singleEdit(size)));

describe("oracle: our DIRECT_OVERLAP agrees with git merge", () => {
  it.each([
    ["one change per side", singleScenario],
    ["many changes per side", scenario],
  ] as const)(
    `agrees on ${RUNS} random pairs: %s`,
    async (_name, arbitrary) => {
      await fc.assert(
        fc.asyncProperty(arbitrary, async ([size, editA, editB]) => {
          const dir = makeRepo({
            [FILE]: render(
              size,
              { fates: Array(size).fill("keep"), inserts: Array(size + 1).fill(0) },
              "",
            ),
          });
          const base = run(dir, "rev-parse", "HEAD");
          run(dir, "checkout", "-q", "-b", "a");
          write(dir, { [FILE]: render(size, editA, "A") });
          const a = commitAll(dir, "a");
          run(dir, "checkout", "-q", "-b", "b", base);
          write(dir, { [FILE]: render(size, editB, "B") });
          const b = commitAll(dir, "b");

          const merge = await mergeTree(dir, a, b);
          const rangesB = reportFor(await diffRanges(dir, base));
          run(dir, "checkout", "-q", "a");
          const rangesA = reportFor(await diffRanges(dir, base));

          const gitConflicts = merge.conflicts.includes(FILE);
          const weSayOverlap = collide(rangesA, rangesB) === "DIRECT_OVERLAP";
          expect({ weSayOverlap, a: rangesA.changes, b: rangesB.changes }).toEqual({
            weSayOverlap: gitConflicts,
            a: rangesA.changes,
            b: rangesB.changes,
          });
        }),
        { numRuns: RUNS },
      );
    },
    600_000,
  );
});
