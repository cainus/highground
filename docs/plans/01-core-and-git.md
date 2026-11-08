# Plan 01 — Core math and git plumbing, proven against git

Step 1 of the build order: the pure math in `packages/core` and the git plumbing in `packages/git`, test-first, with a differential test that treats real `git merge` as the oracle. Nothing here talks to a network or a database.

## Scaffold

pnpm workspace, TypeScript (strict, ESM, NodeNext), Vitest with a root workspace config, Oxlint and Oxfmt, fast-check. `packages/core` and `packages/git` only; the apps come in later plans.

## packages/core

Pure functions, 100 % branch coverage enforced.

- **Ranges.** `[start, end]` closed intervals in base coordinates. An **insertion point** after base line `a` is the empty range `[a + 1, a]` — it occupies no base line but sits between `a` and `a + 1`. (Corrects PRD §3.2, which mapped an insertion to `[a, a + 1]`; with the touching rule that falsely flags an edit two lines away.)
- **`gap(r1, r2)`** — unchanged base lines between two ranges: `max(s1, s2) - min(e1, e2) - 1`. Negative or zero means shared or touching.
- **`classify(r1, r2, proximityLines)`** — `DIRECT_OVERLAP` when `gap <= 0`, `PROXIMITY_ALERT` when `1 <= gap <= proximityLines`, else none. Whole-file changes collide with anything in the same path.
- **`parseDiff(text)`** — parses `git diff -U0 -M` output into per-file records: base path, new path, status (modified / added / deleted / renamed / binary), hunks.
- **`hunkToRange(hunk)`** — modification and deletion `-a,b` → `[a, a + b - 1]`; insertion `-a,0` → `[a + 1, a]`.
- **`translate(range, hunksAtoB)`** — maps a range in base A to base B given the hunks of `diff A B`: unchanged lines shift exactly; a range touching a changed hunk widens to cover that hunk's extent in B.

## packages/git

Thin wrappers over the `git` binary, integration-tested against throwaway repos.

- `mergeBase(dir, defaultRef)`
- `diffRanges(dir, baseSha)` — runs `git diff -U0 -M --histogram --no-color --no-ext-diff <base>` (histogram matches merge-ort's diff algorithm) and returns per-file base ranges via core.
- `snapshot(dir)` — `git stash create` (no stash-list entry), or `HEAD` when clean.
- `mergeTree(dir, a, b)` — `git merge-tree --write-tree`; returns clean or the conflicted paths.

## The oracle test

fast-check generates a base file and two edit scripts (modify, delete, insert) whose content never coincides, applies each on its own branch, then asserts for each file:

- **No missed conflicts:** `git merge` conflicts ⇒ some pair of ranges from the two sides is a `DIRECT_OVERLAP`.
- **No false alarms:** some pair is a `DIRECT_OVERLAP` ⇒ `git merge` conflicts.

Any counterexample is a rule to fix in core and record here, not a test to loosen. A second property checks `translate`: for every unchanged line, the line at the translated position in B has the same content.

## Done when

- `pnpm test` is green, including the oracle at a few thousand runs, and `packages/core` is at 100 % branch coverage.
- `pnpm lint` and `pnpm fmt --check` are clean.
- PRD §3 and §4 reflect any rule the oracle forced.

## What the tests forced

- **Identical changes merge.** The single-change oracle found that both sides deleting the same line merges cleanly while ranges alone called it an overlap. Probing git showed the exact rule: a pair merges only when both replace the same base lines with the same content; any partial difference conflicts. Changes now carry a SHA-256 digest of their new lines (computed in `packages/git`, so core stays pure and no code leaves the machine), and an identical pair is a `DUPLICATE_CHANGE` (MEDIUM) instead of a `DIRECT_OVERLAP`.
- **Per-file properties hide wrong rules.** With several edits per side a file usually conflicts somewhere, which masks a wrong rule elsewhere; the many-edits property passed 200 runs while the rule above was wrong. The oracle therefore runs a one-change-per-side property as well.
- **Untracked files.** `git diff <base>` does not show them, and `git stash create` does not capture them; `diffRanges` lists them as whole-file and `snapshot` builds its commit through a copy of the index instead.
- **Header-like content.** A removed line beginning `-- ` or an added line beginning `++ ` appears as `--- …` / `+++ …`; the parser reads hunk bodies by their declared line counts so such content is never taken for a file header.
- **Translation.** A range meeting a change between bases widens over the change's new lines and is reported inexact; an insertion point at the same position as an insertion between the bases widens over the inserted lines.
