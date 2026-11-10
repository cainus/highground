import { describe, expect, it } from "vitest";
import { LiveIndex } from "../src/live-index.ts";
import { ALICE, BOB, CAROL, file, heartbeat, OTHER_SHA, REPO, SHA } from "./fixtures.ts";

const T0 = 1_000_000;
const ask = (workingCopyId: string, path: string, start: number, end: number, baseSha = SHA) => ({
  repo: REPO,
  path,
  workingCopyId,
  baseSha,
  changes: [{ range: [start, end] as const, digest: null }],
});

describe("LiveIndex", () => {
  it("warns about a peer's overlapping change", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(BOB, [{ ...file("a.ts", [50, 75]), intent: "async verify" }]), T0);

    expect(index.warnings(ask(ALICE, "a.ts", 45, 62), T0 + 4_000)).toEqual([
      {
        severity: "HIGH",
        type: "DIRECT_OVERLAP",
        path: "a.ts",
        your_lines: [45, 62],
        peer: {
          working_copy_id: BOB,
          actor: { type: "cli", id: "daemon" },
          author: "2222@acme.com",
          kind: "live",
          branch: "feature",
          head_sha: null,
          pr_url: null,
          lines: [50, 75],
          whole_file: false,
          intent: "async verify",
          summary: null,
          last_heartbeat_seconds_ago: 4,
        },
        approximate: false,
        confirmed: null,
      },
    ]);
  });

  describe("a complete report sent in parts", () => {
    const R1 = "7d1c4f3a-2b6e-4a8d-9c0f-1e2d3c4b5a61";
    const R2 = "7d1c4f3a-2b6e-4a8d-9c0f-1e2d3c4b5a62";
    const part = (
      report: string,
      index: number,
      of: number,
      files: Parameters<typeof heartbeat>[1],
    ) => heartbeat(BOB, files, { scope: "complete", part: { report, index, of } });
    const has = (index: LiveIndex, path: string, now = T0) =>
      index.warnings(ask(ALICE, path, 1, 1), now).length > 0;

    it("is applied whole when its last part arrives, so no file is cleared and re-added", () => {
      const index = new LiveIndex();
      expect(index.apply(part(R1, 1, 2, [file("a.ts", [1, 1])]), T0)).toEqual([]);
      expect(has(index, "a.ts")).toBe(false);
      expect(index.apply(part(R1, 2, 2, [file("b.ts", [1, 1])]), T0)).toHaveLength(2);
      expect([has(index, "a.ts"), has(index, "b.ts")]).toEqual([true, true]);

      // The next report's first part leaves b.ts alone until the report is whole.
      expect(index.apply(part(R2, 1, 2, [file("a.ts", [1, 1])]), T0 + 1)).toEqual([]);
      expect(has(index, "b.ts", T0 + 1)).toBe(true);
      const touched = index.apply(part(R2, 2, 2, [file("c.ts", [1, 1])]), T0 + 2);
      expect(touched.map((t) => t.path).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect([has(index, "a.ts", T0 + 2), has(index, "b.ts", T0 + 2)]).toEqual([true, false]);
      expect(has(index, "c.ts", T0 + 2)).toBe(true);
    });

    it("drops an unfinished report when another starts, and a part out of order", () => {
      const index = new LiveIndex();
      index.apply(part(R1, 1, 2, [file("a.ts", [1, 1])]), T0);
      index.apply(part(R2, 1, 2, [file("x.ts", [1, 1])]), T0);
      expect(index.apply(part(R1, 2, 2, [file("b.ts", [1, 1])]), T0)).toEqual([]);
      index.apply(part(R2, 2, 2, [file("y.ts", [1, 1])]), T0);
      expect(["a.ts", "b.ts", "x.ts", "y.ts"].map((p) => has(index, p))).toEqual([
        false,
        false,
        true,
        true,
      ]);
      expect(index.apply(part(R1, 2, 3, [file("z.ts", [1, 1])]), T0)).toEqual([]);
      expect(has(index, "z.ts")).toBe(false);
    });

    it("forgets a report whose last part never came once its parts have expired", () => {
      const index = new LiveIndex();
      index.apply(part(R1, 1, 2, [file("a.ts", [1, 1])]), T0);
      index.expire(T0 + 61_000);
      expect(index.apply(part(R1, 2, 2, [file("b.ts", [1, 1])]), T0 + 61_000)).toEqual([]);
      expect(has(index, "a.ts", T0 + 61_000)).toBe(false);
    });
  });

  it("grades proximity and duplicate changes as MEDIUM", () => {
    const index = new LiveIndex();
    const digest = "d".repeat(64);
    index.apply(heartbeat(BOB, [file("near.ts", [80, 90])]), T0);
    index.apply(heartbeat(BOB, [{ path: "same.ts", changes: [{ range: [3, 4], digest }] }]), T0);

    expect(index.warnings(ask(ALICE, "near.ts", 60, 70), T0)).toMatchObject([
      { severity: "MEDIUM", type: "PROXIMITY_ALERT" },
    ]);
    const same = { ...ask(ALICE, "same.ts", 3, 4), changes: [{ range: [3, 4] as const, digest }] };
    expect(index.warnings(same, T0)).toMatchObject([
      { severity: "MEDIUM", type: "DUPLICATE_CHANGE" },
    ]);
  });

  it("never warns a working copy about itself, across its actors", () => {
    const index = new LiveIndex();
    index.apply(
      heartbeat(ALICE, [file("a.ts", [1, 10])], { actor: { type: "agent", id: "s1" } }),
      T0,
    );
    expect(index.warnings(ask(ALICE, "a.ts", 5, 5), T0)).toEqual([]);
  });

  it("only compares the same repo and path", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(BOB, [file("a.ts", [1, 10])]), T0);
    index.apply(heartbeat(CAROL, [file("a.ts", [1, 10])], { repo: "github.com/acme/web" }), T0);
    expect(index.warnings(ask(ALICE, "b.ts", 1, 10), T0)).toEqual([]);
    expect(index.warnings(ask(ALICE, "a.ts", 1, 10), T0)).toHaveLength(1);
  });

  it("gives one warning per peer actor, from its most severe pair", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(BOB, [file("a.ts", [30, 30], [100, 100])]), T0);
    const query = {
      ...ask(ALICE, "a.ts", 1, 1),
      changes: [
        { range: [20, 20] as const, digest: null },
        { range: [99, 99] as const, digest: null },
      ],
    };
    expect(index.warnings(query, T0)).toMatchObject([
      { type: "DIRECT_OVERLAP", your_lines: [99, 99], peer: { lines: [100, 100] } },
    ]);
  });

  describe("heartbeat semantics", () => {
    it("partial replaces only the files it lists", () => {
      const index = new LiveIndex();
      index.apply(heartbeat(BOB, [file("a.ts", [1, 1]), file("b.ts", [1, 1])]), T0);
      index.apply(heartbeat(BOB, [file("a.ts", [200, 200])]), T0);
      expect(index.warnings(ask(ALICE, "a.ts", 1, 1), T0)).toEqual([]);
      expect(index.warnings(ask(ALICE, "b.ts", 1, 1), T0)).toHaveLength(1);
    });

    it("complete clears the actor's unlisted files, and nobody else's", () => {
      const index = new LiveIndex();
      const agent = { actor: { type: "agent" as const, id: "s1" } };
      index.apply(heartbeat(BOB, [file("a.ts", [1, 1]), file("b.ts", [1, 1])]), T0);
      index.apply(heartbeat(BOB, [file("c.ts", [1, 1])], agent), T0);
      index.apply(heartbeat(BOB, [file("a.ts", [1, 1])], { scope: "complete" }), T0);
      expect(index.warnings(ask(ALICE, "b.ts", 1, 1), T0)).toEqual([]);
      expect(index.warnings(ask(ALICE, "a.ts", 1, 1), T0)).toHaveLength(1);
      expect(index.warnings(ask(ALICE, "c.ts", 1, 1), T0)).toHaveLength(1);
    });

    it("an empty file entry clears that file", () => {
      const index = new LiveIndex();
      index.apply(heartbeat(BOB, [file("a.ts", [1, 1])]), T0);
      index.apply(heartbeat(BOB, [file("a.ts")]), T0);
      expect(index.warnings(ask(ALICE, "a.ts", 1, 1), T0)).toEqual([]);
    });

    it("a whole-file change collides with any line, names no lines, and says why", () => {
      const index = new LiveIndex();
      index.apply(heartbeat(BOB, [{ path: "gone.ts", whole_file: "deleted", changes: [] }]), T0);
      expect(index.warnings(ask(ALICE, "gone.ts", 900, 900), T0)).toMatchObject([
        { type: "DIRECT_OVERLAP", your_lines: null, peer: { lines: null, whole_file: "deleted" } },
      ]);
    });

    it("marks warnings approximate when the bases differ", () => {
      const index = new LiveIndex();
      index.apply(heartbeat(BOB, [file("a.ts", [1, 1])], { base_sha: OTHER_SHA }), T0);
      expect(index.warnings(ask(ALICE, "a.ts", 1, 1), T0)).toMatchObject([{ approximate: true }]);
    });
  });

  describe("expiry", () => {
    it("ignores an expired entry on read, before any sweep", () => {
      const index = new LiveIndex();
      index.apply(heartbeat(BOB, [file("a.ts", [1, 1])], { ttl_seconds: 10 }), T0);
      expect(index.warnings(ask(ALICE, "a.ts", 1, 1), T0 + 9_999)).toHaveLength(1);
      expect(index.warnings(ask(ALICE, "a.ts", 1, 1), T0 + 10_000)).toEqual([]);
    });

    it("sweeps expired entries and reports the paths they touched", () => {
      const index = new LiveIndex();
      index.apply(heartbeat(BOB, [file("a.ts", [1, 1])], { ttl_seconds: 10 }), T0);
      index.apply(heartbeat(CAROL, [file("b.ts", [1, 1])], { ttl_seconds: 60 }), T0);
      expect(index.expire(T0 + 10_000)).toEqual([{ repo: REPO, path: "a.ts" }]);
      expect(index.size).toBe(1);
    });

    it("a fresh heartbeat extends the entry", () => {
      const index = new LiveIndex();
      index.apply(heartbeat(BOB, [file("a.ts", [1, 1])], { ttl_seconds: 10 }), T0);
      index.apply(heartbeat(BOB, [file("a.ts", [1, 1])], { ttl_seconds: 10 }), T0 + 8_000);
      expect(index.warnings(ask(ALICE, "a.ts", 1, 1), T0 + 15_000)).toHaveLength(1);
    });
  });

  it("reports the paths each heartbeat touched, including cleared ones", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(BOB, [file("a.ts", [1, 1]), file("b.ts", [1, 1])]), T0);
    const touched = index.apply(heartbeat(BOB, [file("c.ts", [1, 1])], { scope: "complete" }), T0);
    expect(touched).toEqual(
      expect.arrayContaining([
        { repo: REPO, path: "a.ts" },
        { repo: REPO, path: "b.ts" },
        { repo: REPO, path: "c.ts" },
      ]),
    );
  });

  it("lists a working copy's actors, for presence clearing", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(BOB, [file("a.ts", [1, 1])]), T0);
    index.apply(heartbeat(BOB, [file("b.ts", [1, 1])], { actor: { type: "agent", id: "s1" } }), T0);
    expect(index.actorsOf(REPO, BOB)).toEqual([
      expect.objectContaining({ actor: { type: "cli", id: "daemon" } }),
      expect.objectContaining({ actor: { type: "agent", id: "s1" } }),
    ]);
  });

  it("computes every working copy's collisions on a path, each pair once and from both sides", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(ALICE, [file("a.ts", [45, 62])]), T0);
    index.apply(
      heartbeat(ALICE, [file("a.ts", [45, 46])], { actor: { type: "agent", id: "s1" } }),
      T0,
    );
    index.apply(heartbeat(BOB, [file("a.ts", [50, 75])]), T0);
    index.apply(heartbeat(CAROL, [file("a.ts", [900, 900])]), T0);

    const all = index.collisionsAt(REPO, "a.ts", T0);
    // Alice's two actors both see Bob; she keeps the most severe, from her daemon.
    expect([...(all.get(ALICE)?.values() ?? [])]).toMatchObject([
      {
        type: "DIRECT_OVERLAP",
        your_lines: [45, 62],
        peer: { working_copy_id: BOB, lines: [50, 75] },
      },
    ]);
    // Bob sees each of Alice's actors as a separate peer, with the lines mirrored.
    expect([...(all.get(BOB)?.values() ?? [])]).toMatchObject([
      {
        type: "DIRECT_OVERLAP",
        your_lines: [50, 75],
        peer: { working_copy_id: ALICE, lines: [45, 62] },
      },
      {
        type: "PROXIMITY_ALERT",
        your_lines: [50, 75],
        peer: { working_copy_id: ALICE, lines: [45, 46] },
      },
    ]);
    expect(all.has(CAROL)).toBe(false);
  });
});
