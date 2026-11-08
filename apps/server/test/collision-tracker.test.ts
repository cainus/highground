import type { CollisionEvent } from "@highground/core";
import { describe, expect, it } from "vitest";
import { CollisionTracker } from "../src/collision-tracker.ts";
import { LiveIndex } from "../src/live-index.ts";
import { ALICE, BOB, CAROL, file, heartbeat } from "./fixtures.ts";

const T0 = 1_000_000;

function setup() {
  const index = new LiveIndex();
  const events: {
    workingCopyId: string;
    event: CollisionEvent["event"];
    type: string;
    peer: string;
  }[] = [];
  const tracker = new CollisionTracker(index, (_repo, workingCopyId, e) =>
    events.push({
      workingCopyId,
      event: e.event,
      type: e.warning.type,
      peer: e.warning.peer.working_copy_id,
    }),
  );
  const send = (hb: ReturnType<typeof heartbeat>, at = T0) =>
    tracker.refresh(index.apply(hb, at), at);
  return { index, tracker, events, send };
}

describe("CollisionTracker", () => {
  it("tells both sides when a collision starts", () => {
    const { events, send } = setup();
    send(heartbeat(BOB, [file("a.ts", [50, 75])]));
    expect(events).toEqual([]);
    send(heartbeat(ALICE, [file("a.ts", [45, 62])]));
    expect(events).toEqual(
      expect.arrayContaining([
        { workingCopyId: ALICE, event: "collision_started", type: "DIRECT_OVERLAP", peer: BOB },
        { workingCopyId: BOB, event: "collision_started", type: "DIRECT_OVERLAP", peer: ALICE },
      ]),
    );
    expect(events).toHaveLength(2);
  });

  it("tells both sides when it ends", () => {
    const { events, send } = setup();
    send(heartbeat(BOB, [file("a.ts", [50, 75])]));
    send(heartbeat(ALICE, [file("a.ts", [45, 62])]));
    events.length = 0;
    send(heartbeat(BOB, [file("a.ts")]));
    expect(events).toEqual(
      expect.arrayContaining([
        { workingCopyId: ALICE, event: "collision_ended", type: "DIRECT_OVERLAP", peer: BOB },
        { workingCopyId: BOB, event: "collision_ended", type: "DIRECT_OVERLAP", peer: ALICE },
      ]),
    );
    expect(events).toHaveLength(2);
  });

  it("ends collisions when a sweep expires an entry", () => {
    const { index, tracker, events, send } = setup();
    send(heartbeat(BOB, [file("a.ts", [1, 1])], { ttl_seconds: 10 }));
    send(heartbeat(ALICE, [file("a.ts", [1, 1])], { ttl_seconds: 60 }));
    events.length = 0;
    tracker.refresh(index.expire(T0 + 10_000), T0 + 10_000);
    expect(events.map((e) => [e.workingCopyId, e.event])).toEqual(
      expect.arrayContaining([
        [ALICE, "collision_ended"],
        [BOB, "collision_ended"],
      ]),
    );
  });

  it("stays quiet while lines move but the collision type holds", () => {
    const { events, send } = setup();
    send(heartbeat(BOB, [file("a.ts", [50, 75])]));
    send(heartbeat(ALICE, [file("a.ts", [45, 62])]));
    events.length = 0;
    send(heartbeat(ALICE, [file("a.ts", [46, 63])]));
    expect(events).toEqual([]);
  });

  it("re-announces when the collision gets more or less severe", () => {
    const { events, send } = setup();
    send(heartbeat(BOB, [file("a.ts", [50, 75])]));
    send(heartbeat(ALICE, [file("a.ts", [30, 40])]));
    expect(events.map((e) => e.type)).toEqual(["PROXIMITY_ALERT", "PROXIMITY_ALERT"]);
    events.length = 0;
    send(heartbeat(ALICE, [file("a.ts", [30, 55])]));
    expect(events).toEqual(
      expect.arrayContaining([
        { workingCopyId: ALICE, event: "collision_started", type: "DIRECT_OVERLAP", peer: BOB },
        { workingCopyId: BOB, event: "collision_started", type: "DIRECT_OVERLAP", peer: ALICE },
      ]),
    );
    expect(events).toHaveLength(2);
  });

  it("re-announces when a speculative merge confirms or refutes the collision", () => {
    const { events, send } = setup();
    const head = "1".repeat(40);
    send(
      heartbeat(BOB, [file("a.ts", [10, 12])], { kind: "pushed", branch: "b1", head_sha: head }),
    );
    send(heartbeat(ALICE, [file("a.ts", [11, 11])]));
    events.length = 0;
    send(
      heartbeat(ALICE, [file("a.ts", [11, 11])], {
        merges: [{ branch: "b1", head_sha: head, conflicts: ["a.ts"] }],
      }),
    );
    expect(events.map((e) => [e.workingCopyId, e.event])).toEqual(
      expect.arrayContaining([
        [ALICE, "collision_started"],
        [BOB, "collision_started"],
      ]),
    );
    expect(events).toHaveLength(2);
  });

  it("tracks each peer separately and ignores bystanders", () => {
    const { events, send } = setup();
    send(heartbeat(BOB, [file("a.ts", [1, 5])]));
    send(heartbeat(CAROL, [file("a.ts", [500, 505])]));
    send(heartbeat(ALICE, [file("a.ts", [3, 3])]));
    expect(events.map((e) => [e.workingCopyId, e.peer])).toEqual(
      expect.arrayContaining([
        [ALICE, BOB],
        [BOB, ALICE],
      ]),
    );
    expect(events.some((e) => e.workingCopyId === CAROL || e.peer === CAROL)).toBe(false);
  });

  it("does not report a working copy's own actors to each other", () => {
    const { events, send } = setup();
    send(heartbeat(ALICE, [file("a.ts", [1, 5])]));
    send(heartbeat(ALICE, [file("a.ts", [1, 5])], { actor: { type: "agent", id: "s1" } }));
    expect(events).toEqual([]);
  });

  it("lists a working copy's current collisions, for replay on subscribe", () => {
    const { tracker, send } = setup();
    send(heartbeat(BOB, [file("a.ts", [1, 5])]));
    send(heartbeat(ALICE, [file("a.ts", [3, 3]), file("b.ts", [1, 1])]));
    send(heartbeat(CAROL, [file("b.ts", [1, 1])], { repo: "github.com/acme/web" }));
    expect(
      tracker.current("github.com/acme/api", ALICE).map((w) => w.peer.working_copy_id),
    ).toEqual([BOB]);
    expect(tracker.current("github.com/acme/api", CAROL)).toEqual([]);
  });
});
