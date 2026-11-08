import { invertHunks, type Hunk, type HeartbeatInput } from "@highground/core";
import { describe, expect, it } from "vitest";
import { LiveIndex, type Oracle } from "../src/live-index.ts";
import { ALICE, BOB, CAROL, file, heartbeat, OTHER_SHA, REPO, SHA } from "./fixtures.ts";

const T0 = Date.parse("2026-11-08T12:00:00Z");
const DAY = 86_400_000;
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number): Hunk => ({
  oldStart,
  oldCount,
  newStart,
  newCount,
  added: [],
});

/** Five lines were added at the top of a.ts between OTHER_SHA and SHA. */
const OTHER_TO_SHA = [hunk(0, 0, 1, 5)];

class FakeOracle implements Oracle {
  readonly asked: string[] = [];
  hunksBetween = new Map<string, Hunk[]>();
  merged = new Map<string, string[]>();

  hunks(repo: string, from: string, to: string, path: string): Hunk[] | undefined {
    this.asked.push(`hunks ${from.slice(0, 1)}→${to.slice(0, 1)} ${path}`);
    return this.hunksBetween.get(`${from}${to}${path}`);
  }
  conflicts(repo: string, a: string, b: string, path: string): string[] | undefined {
    this.asked.push(`merge ${path}`);
    return this.merged.get([a, b].sort().join(""));
  }
  knowsTranslation(from: string, to: string, path: string, hunks: Hunk[]) {
    this.hunksBetween.set(`${from}${to}${path}`, hunks);
    this.hunksBetween.set(`${to}${from}${path}`, invertHunks(hunks));
  }
}

const ask = (workingCopyId: string, start: number, end: number, extra: object = {}) => ({
  repo: REPO,
  path: "a.ts",
  workingCopyId,
  baseSha: SHA,
  changes: [{ range: [start, end] as const, digest: null }],
  ...extra,
});

const pushed = (
  branch: string,
  head: string,
  ranges: [number, number][],
  extra: Partial<HeartbeatInput> = {},
) =>
  heartbeat(
    // Pushed work has a working copy of its own per branch; the server derives it.
    branch === "b1" ? CAROL : "44444444-4444-4444-8444-444444444444",
    [file("a.ts", ...ranges)],
    {
      kind: "pushed",
      branch,
      head_sha: head,
      last_commit_at: new Date(T0 - DAY).toISOString(),
      pr_url: `https://github.com/acme/api/pull/${branch === "b1" ? 1 : 2}`,
      ttl_seconds: 300,
      ...extra,
    },
  );

describe("LiveIndex with a mirror", () => {
  describe("translation between bases", () => {
    it("maps a peer's lines into the asker's base exactly when nothing between the bases touches them", () => {
      const oracle = new FakeOracle();
      oracle.knowsTranslation(OTHER_SHA, SHA, "a.ts", OTHER_TO_SHA);
      const index = new LiveIndex(oracle);
      index.apply(heartbeat(BOB, [file("a.ts", [20, 22])], { base_sha: OTHER_SHA }), T0);

      expect(index.warnings(ask(ALICE, 25, 25), T0)).toMatchObject([
        {
          type: "DIRECT_OVERLAP",
          your_lines: [25, 25],
          peer: { lines: [25, 27] },
          approximate: false,
        },
      ]);
      // Untranslated, lines 20–22 would be a proximity alert for line 5; at 25–27 they are too far.
      expect(index.warnings(ask(ALICE, 5, 5), T0)).toEqual([]);
    });

    it("is approximate, with untranslated lines, until the mirror can translate", () => {
      const oracle = new FakeOracle();
      const index = new LiveIndex(oracle);
      index.apply(heartbeat(BOB, [file("a.ts", [20, 22])], { base_sha: OTHER_SHA }), T0);

      expect(index.warnings(ask(ALICE, 20, 20), T0)).toMatchObject([
        { peer: { lines: [20, 22] }, approximate: true },
      ]);
      expect(oracle.asked).toContain("hunks b→a a.ts");
    });

    it("is approximate when the peer's lines met a change between the bases", () => {
      const oracle = new FakeOracle();
      oracle.knowsTranslation(OTHER_SHA, SHA, "a.ts", [hunk(21, 1, 21, 3)]);
      const index = new LiveIndex(oracle);
      index.apply(heartbeat(BOB, [file("a.ts", [20, 22])], { base_sha: OTHER_SHA }), T0);

      expect(index.warnings(ask(ALICE, 20, 20), T0)).toMatchObject([
        { peer: { lines: [20, 24] }, approximate: true },
      ]);
    });

    it("shows each side the collision in its own base", () => {
      const oracle = new FakeOracle();
      oracle.knowsTranslation(OTHER_SHA, SHA, "a.ts", OTHER_TO_SHA);
      const index = new LiveIndex(oracle);
      index.apply(heartbeat(ALICE, [file("a.ts", [25, 27])]), T0);
      index.apply(heartbeat(BOB, [file("a.ts", [20, 22])], { base_sha: OTHER_SHA }), T0);

      const collisions = index.collisionsAt(REPO, "a.ts", T0);
      expect([...collisions.get(ALICE)!.values()]).toMatchObject([
        { your_lines: [25, 27], peer: { lines: [25, 27] }, approximate: false },
      ]);
      expect([...collisions.get(BOB)!.values()]).toMatchObject([
        { your_lines: [20, 22], peer: { lines: [20, 22] }, approximate: false },
      ]);
    });
  });

  describe("pushed work and confirmation", () => {
    it("shows pushed peers with their branch, head and PR", () => {
      const index = new LiveIndex(new FakeOracle());
      index.apply(pushed("b1", H1, [[10, 12]]), T0);

      expect(index.warnings(ask(ALICE, 11, 11), T0)).toMatchObject([
        {
          peer: {
            kind: "pushed",
            branch: "b1",
            head_sha: H1,
            pr_url: "https://github.com/acme/api/pull/1",
          },
          confirmed: null,
        },
      ]);
    });

    it.each([
      ["conflicts on the path", ["a.ts"], true, "HIGH"],
      ["conflicts elsewhere only", ["b.ts"], false, "MEDIUM"],
      ["merges cleanly", [], false, "MEDIUM"],
    ] as const)(
      "confirms pushed against pushed from the mirror's merge: %s",
      (_name, conflicts, confirmed, severity) => {
        const oracle = new FakeOracle();
        oracle.merged.set([H1, H2].sort().join(""), [...conflicts]);
        const index = new LiveIndex(oracle);
        index.apply(pushed("b1", H1, [[10, 12]]), T0);
        index.apply(pushed("b2", H2, [[12, 14]]), T0);

        const [warning] = index.collisionsAt(REPO, "a.ts", T0).get(CAROL)!.values();
        expect(warning).toMatchObject({ type: "DIRECT_OVERLAP", confirmed, severity });
      },
    );

    it("leaves pushed against pushed unconfirmed until the merge has run", () => {
      const oracle = new FakeOracle();
      const index = new LiveIndex(oracle);
      index.apply(pushed("b1", H1, [[10, 12]]), T0);
      index.apply(pushed("b2", H2, [[12, 14]]), T0);
      const [warning] = index.collisionsAt(REPO, "a.ts", T0).get(CAROL)!.values();
      expect(warning).toMatchObject({ confirmed: null, severity: "HIGH" });
      expect(oracle.asked).toContain("merge a.ts");
    });

    it("confirms live against pushed from the daemon's merge of that very head", () => {
      const index = new LiveIndex(new FakeOracle());
      index.apply(pushed("b1", H1, [[10, 12]]), T0);
      index.apply(
        heartbeat(ALICE, [file("a.ts", [11, 11])], {
          merges: [{ branch: "b1", head_sha: H1, conflicts: [] }],
        }),
        T0,
      );
      const collisions = index.collisionsAt(REPO, "a.ts", T0);
      expect([...collisions.get(ALICE)!.values()]).toMatchObject([
        { confirmed: false, severity: "MEDIUM" },
      ]);
      expect([...collisions.get(CAROL)!.values()]).toMatchObject([
        { confirmed: false, severity: "MEDIUM" },
      ]);
    });

    it("ignores a daemon's merge with an older head of the branch", () => {
      const index = new LiveIndex(new FakeOracle());
      index.apply(pushed("b1", H1, [[10, 12]]), T0);
      index.apply(
        heartbeat(ALICE, [file("a.ts", [11, 11])], {
          merges: [{ branch: "b1", head_sha: H2, conflicts: ["a.ts"] }],
        }),
        T0,
      );
      expect([...index.collisionsAt(REPO, "a.ts", T0).get(ALICE)!.values()]).toMatchObject([
        { confirmed: null, severity: "HIGH" },
      ]);
    });

    it("never confirms a proximity alert", () => {
      const oracle = new FakeOracle();
      oracle.merged.set([H1, H2].sort().join(""), ["a.ts"]);
      const index = new LiveIndex(oracle);
      index.apply(pushed("b1", H1, [[10, 12]]), T0);
      index.apply(pushed("b2", H2, [[20, 21]]), T0);
      const [warning] = index.collisionsAt(REPO, "a.ts", T0).get(CAROL)!.values();
      expect(warning).toMatchObject({ type: "PROXIMITY_ALERT", confirmed: null });
    });

    it("never warns work about the pushed copy of its own branch", () => {
      const index = new LiveIndex(new FakeOracle());
      index.apply(pushed("feature", H1, [[10, 12]]), T0);
      index.apply(heartbeat(ALICE, [file("a.ts", [11, 11])], { branch: "feature" }), T0);

      expect(index.collisionsAt(REPO, "a.ts", T0).size).toBe(0);
      // Asking from another working copy on `feature`: Alice's live work still counts.
      expect(index.warnings(ask(BOB, 11, 11, { branch: "feature" }), T0)).toMatchObject([
        { peer: { working_copy_id: ALICE } },
      ]);
      expect(index.warnings(ask(BOB, 11, 11, { branch: "other" }), T0)).toHaveLength(2);
    });
  });

  describe("dormancy", () => {
    it.each([
      ["six days", 6, "HIGH"],
      ["eight days", 8, "MEDIUM"],
    ])("drops one severity after a week without a commit: %s", (_name, days, severity) => {
      const index = new LiveIndex(new FakeOracle());
      index.apply(
        pushed("b1", H1, [[10, 12]], { last_commit_at: new Date(T0 - days * DAY).toISOString() }),
        T0,
      );
      expect(index.warnings(ask(ALICE, 11, 11), T0)).toMatchObject([{ severity }]);
    });

    it("drops MEDIUM to LOW", () => {
      const index = new LiveIndex(new FakeOracle());
      index.apply(
        pushed("b1", H1, [[10, 12]], { last_commit_at: new Date(T0 - 30 * DAY).toISOString() }),
        T0,
      );
      expect(index.warnings(ask(ALICE, 20, 20), T0)).toMatchObject([
        { type: "PROXIMITY_ALERT", severity: "LOW" },
      ]);
    });
  });
});
