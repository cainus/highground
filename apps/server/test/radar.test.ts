import { describe, expect, it } from "vitest";
import { LiveIndex } from "../src/live-index.ts";
import { FakeOracle, OTHER_TO_SHA } from "./fake-oracle.ts";
import { ALICE, BOB, CAROL, file, heartbeat, OTHER_SHA, REPO, SHA } from "./fixtures.ts";

const T0 = Date.parse("2026-11-08T12:00:00Z");

describe("LiveIndex.radar", () => {
  it("lists each file's work with who is doing it, and nothing for other repos", () => {
    const index = new LiveIndex();
    index.apply(
      heartbeat(ALICE, [{ ...file("a.ts", [10, 12]), intent: "tidy" }], {
        actor: { type: "agent", id: "claude-1" },
      }),
      T0 - 4_000,
    );
    index.apply(heartbeat(BOB, [file("b.ts", [1, 1])]), T0);
    index.apply(heartbeat(CAROL, [file("a.ts", [1, 1])], { repo: "github.com/acme/other" }), T0);

    const radar = index.radar(REPO, T0);
    expect(radar.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(radar[0]).toMatchObject({
      base_sha: SHA,
      collisions: [],
      work: [
        {
          working_copy_id: ALICE,
          actor: { type: "agent", id: "claude-1" },
          author: "1111@acme.com",
          kind: "live",
          branch: "feature",
          lines: [[10, 12]],
          approximate: false,
          intent: "tidy",
          last_heartbeat_seconds_ago: 4,
        },
      ],
    });
  });

  it("shows a working copy's latest summary on all its work, and on a peer's warnings", () => {
    const index = new LiveIndex();
    index.apply(
      heartbeat(ALICE, [file("a.ts", [10, 12])], {
        actor: { type: "agent", id: "claude-1" },
        summary: "Moving auth to async",
      }),
      T0 - 2_000,
    );
    index.apply(
      heartbeat(ALICE, [file("b.ts", [1, 1])], {
        scope: "complete",
        summary: "Moving auth to async, so login stops blocking the event loop",
      }),
      T0,
    );
    index.apply(heartbeat(BOB, [file("a.ts", [11, 11])]), T0);

    const why = "Moving auth to async, so login stops blocking the event loop";
    const work = index.radar(REPO, T0).flatMap((f) => f.work);
    expect(work.filter((w) => w.working_copy_id === ALICE).map((w) => w.summary)).toEqual([
      why,
      why,
    ]);
    expect(work.find((w) => w.working_copy_id === BOB)!.summary).toBeNull();
    expect(
      index.warnings(
        {
          repo: REPO,
          path: "a.ts",
          workingCopyId: BOB,
          baseSha: SHA,
          changes: [{ range: [11, 11], digest: null }],
        },
        T0,
      ),
    ).toMatchObject([{ peer: { working_copy_id: ALICE, summary: why } }]);

    index.apply(heartbeat(ALICE, [], { scope: "complete", summary: null }), T0 + 1_000);
    expect(
      index
        .radar(REPO, T0 + 1_000)
        .flatMap((f) => f.work)
        .find((w) => w.working_copy_id === ALICE)?.summary,
    ).toBeNull();
  });

  it("names each colliding pair once, with the stronger of the two views", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(ALICE, [file("a.ts", [10, 12])]), T0);
    index.apply(heartbeat(BOB, [file("a.ts", [11, 11])]), T0);
    index.apply(heartbeat(CAROL, [file("a.ts", [20, 20])]), T0);

    const [a] = index.radar(REPO, T0);
    const id = (wc: string) => a!.work.find((w) => w.working_copy_id === wc)!.id;
    expect(a!.collisions).toEqual(
      expect.arrayContaining([
        {
          a: id(ALICE),
          b: id(BOB),
          type: "DIRECT_OVERLAP",
          severity: "HIGH",
          confirmed: null,
          approximate: false,
        },
        expect.objectContaining({ type: "PROXIMITY_ALERT", severity: "MEDIUM" }),
      ]),
    );
    // Alice–Carol (gap 7) and Bob–Carol (gap 8) are near; each pair appears once.
    expect(a!.collisions).toHaveLength(3);
  });

  it("puts the files with the worst collisions first", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(ALICE, [file("a.ts", [1, 1]), file("z.ts", [5, 5])]), T0);
    index.apply(heartbeat(BOB, [file("a.ts", [9, 9]), file("z.ts", [5, 5])]), T0);
    expect(index.radar(REPO, T0).map((f) => f.path)).toEqual(["z.ts", "a.ts"]);
  });

  it("shows every line in the default branch's head, so bars on one file line up", () => {
    const oracle = new FakeOracle();
    oracle.heads.set(REPO, SHA);
    oracle.knowsTranslation(OTHER_SHA, SHA, "a.ts", OTHER_TO_SHA);
    const index = new LiveIndex(oracle);
    index.apply(heartbeat(ALICE, [file("a.ts", [10, 12])], { base_sha: OTHER_SHA }), T0);
    index.apply(heartbeat(BOB, [file("a.ts", [15, 15])]), T0);

    const [a] = index.radar(REPO, T0);
    expect(a!.base_sha).toBe(SHA);
    // Five lines were added above between the bases: Alice's 10–12 is SHA's 15–17.
    expect(a!.work.find((w) => w.working_copy_id === ALICE)).toMatchObject({
      base_sha: OTHER_SHA,
      lines: [[15, 17]],
      approximate: false,
    });
  });

  it("marks lines approximate, untranslated, until the mirror can translate them", () => {
    const oracle = new FakeOracle();
    oracle.heads.set(REPO, SHA);
    const index = new LiveIndex(oracle);
    index.apply(heartbeat(ALICE, [file("a.ts", [10, 12])], { base_sha: OTHER_SHA }), T0);
    expect(index.radar(REPO, T0)[0]!.work[0]).toMatchObject({
      lines: [[10, 12]],
      approximate: true,
    });
    expect(oracle.asked).toContain("hunks b→a a.ts");
  });

  it("without a mirror, shows the file in the base most of its work shares", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(ALICE, [file("a.ts", [1, 1])], { base_sha: OTHER_SHA }), T0);
    index.apply(heartbeat(BOB, [file("a.ts", [5, 5])]), T0);
    index.apply(heartbeat(CAROL, [file("a.ts", [9, 9])]), T0);
    const [a] = index.radar(REPO, T0);
    expect(a!.base_sha).toBe(SHA);
    expect(a!.work.find((w) => w.working_copy_id === ALICE)!.approximate).toBe(true);
  });

  it("leaves out expired work", () => {
    const index = new LiveIndex();
    index.apply(heartbeat(ALICE, [file("a.ts", [1, 1])], { ttl_seconds: 5 }), T0);
    expect(index.radar(REPO, T0 + 6_000)).toEqual([]);
  });
});
