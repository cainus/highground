import type { HeartbeatInput } from "@highground/core";
import { describe, expect, it } from "vitest";
import { LiveIndex } from "../src/live-index.ts";
import { FakeOracle, hunk, OTHER_TO_SHA } from "./fake-oracle.ts";
import { ALICE, BOB, CAROL, file, heartbeat, OTHER_SHA, REPO, SHA } from "./fixtures.ts";

const T0 = Date.parse("2026-11-08T12:00:00Z");
const DAY = 86_400_000;
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

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

  describe("two live working copies merged by their daemon", () => {
    const live = (wc: string, ranges: [number, number][], extra: Partial<HeartbeatInput> = {}) =>
      heartbeat(wc, [file("a.ts", ...ranges)], { scope: "complete", ...extra });
    const seen = (index: LiveIndex, wc: string) => [
      ...index.collisionsAt(REPO, "a.ts", T0).get(wc)!.values(),
    ];

    it.each([
      ["nearby lines that conflict", [[20, 21]], ["a.ts"], "PROXIMITY_ALERT", true, "HIGH"],
      ["nearby lines that merge cleanly", [[20, 21]], [], "PROXIMITY_ALERT", false, "LOW"],
      ["the same lines that merge cleanly", [[11, 11]], [], "DIRECT_OVERLAP", false, "MEDIUM"],
      ["a conflict on another path only", [[11, 11]], ["b.ts"], "DIRECT_OVERLAP", false, "MEDIUM"],
    ] as const)(
      "confirms or clears the pair from either side's report: %s",
      (_name, bobs, conflicts, type, confirmed, severity) => {
        for (const reporter of [ALICE, BOB]) {
          const index = new LiveIndex(new FakeOracle());
          const merge = (other: string) => ({
            local_merges:
              reporter === other ? [] : [{ working_copy_id: other, conflicts: [...conflicts] }],
          });
          index.apply(live(ALICE, [[10, 12]], reporter === ALICE ? merge(BOB) : {}), T0);
          index.apply(
            live(
              BOB,
              bobs.map((r) => [r[0], r[1]] as [number, number]),
              reporter === BOB ? merge(ALICE) : {},
            ),
            T0,
          );
          for (const wc of [ALICE, BOB]) {
            expect(seen(index, wc)).toMatchObject([{ type, confirmed, severity }]);
          }
        }
      },
    );

    it("does not confirm an agent's announced intent, which no merge has seen", () => {
      const index = new LiveIndex(new FakeOracle());
      index.apply(
        live(ALICE, [[10, 12]], { local_merges: [{ working_copy_id: BOB, conflicts: [] }] }),
        T0,
      );
      index.apply(
        heartbeat(BOB, [file("a.ts", [20, 21])], { actor: { type: "agent", id: "claude-1" } }),
        T0,
      );
      expect(seen(index, ALICE)).toMatchObject([{ confirmed: null, severity: "MEDIUM" }]);
    });

    it("forgets a merge once a later heartbeat leaves it out", () => {
      const index = new LiveIndex(new FakeOracle());
      index.apply(
        live(ALICE, [[10, 12]], { local_merges: [{ working_copy_id: BOB, conflicts: [] }] }),
        T0,
      );
      index.apply(live(BOB, [[20, 21]]), T0);
      expect(seen(index, ALICE)).toMatchObject([{ confirmed: false }]);
      index.apply(live(ALICE, [[10, 12]]), T0);
      expect(seen(index, ALICE)).toMatchObject([{ confirmed: null, severity: "MEDIUM" }]);
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

    it.each([
      ["conflicts on the path", ["a.ts"], true, "HIGH"],
      ["merges cleanly", [], false, "LOW"],
    ] as const)(
      "confirms a proximity alert from a merge too: %s",
      (_name, conflicts, confirmed, severity) => {
        const oracle = new FakeOracle();
        oracle.merged.set([H1, H2].sort().join(""), [...conflicts]);
        const index = new LiveIndex(oracle);
        index.apply(pushed("b1", H1, [[10, 12]]), T0);
        index.apply(pushed("b2", H2, [[20, 21]]), T0);
        const [warning] = index.collisionsAt(REPO, "a.ts", T0).get(CAROL)!.values();
        expect(warning).toMatchObject({ type: "PROXIMITY_ALERT", confirmed, severity });
      },
    );

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
