import type { Warning } from "@highground/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CollisionTracker } from "../src/collision-tracker.ts";
import { LiveIndex } from "../src/live-index.ts";
import { heartbeat, REPO } from "./fixtures.ts";

/**
 * A heartbeat re-judges only the pairs its own actor is in. Whatever the sequence, the
 * tracker must then hold exactly what judging every pair afresh would give, and a
 * subscriber replaying its events must arrive at the same place.
 */

const COPIES = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const ACTORS = [
  { type: "cli", id: "daemon" },
  { type: "agent", id: "agent-1" },
] as const;
const PATHS = ["a.ts", "b.ts"];

const fileArb = fc.record({
  path: fc.constantFrom(...PATHS),
  ranges: fc.array(
    fc
      .tuple(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 0, max: 6 }))
      .map(([start, length]) => [start, start + length] as [number, number]),
    { maxLength: 2 },
  ),
});
const stepArb = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("heartbeat" as const),
      copy: fc.integer({ min: 0, max: COPIES.length - 1 }),
      actor: fc.integer({ min: 0, max: ACTORS.length - 1 }),
      scope: fc.constantFrom("complete" as const, "partial" as const),
      files: fc.uniqueArray(fileArb, { maxLength: 2, selector: (f) => f.path }),
      ttl: fc.constantFrom(5, 60, 300),
    }),
  },
  // Time moves only here, and the sweep runs at once, so nothing expired is left unswept.
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("sweep" as const),
      seconds: fc.integer({ min: 1, max: 120 }),
    }),
  },
);

const keyOf = (path: string, w: Warning) =>
  `${path}|${w.peer.working_copy_id}|${w.peer.actor.type}:${w.peer.actor.id}|${w.type}|${w.severity}|${w.confirmed}|${w.approximate}`;

describe("incremental judging", () => {
  it("keeps the tracker equal to a full recomputation, events included", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 40 }), (steps) => {
        const index = new LiveIndex();
        /** working copy → what its events say it collides with */
        const replayed = new Map<string, Map<string, string>>(COPIES.map((c) => [c, new Map()]));
        const tracker = new CollisionTracker(index, (_repo, workingCopyId, { event, warning }) => {
          const seen = replayed.get(workingCopyId)!;
          const slot = `${warning.path}|${warning.peer.working_copy_id}|${warning.peer.actor.type}:${warning.peer.actor.id}`;
          if (event === "collision_started") seen.set(slot, keyOf(warning.path, warning));
          else seen.delete(slot);
        });
        let now = 1_000_000;

        for (const step of steps) {
          if (step.kind === "sweep") {
            now += step.seconds * 1000;
            tracker.refresh(index.judge(index.expire(now), now), now);
          } else {
            const hb = heartbeat(
              COPIES[step.copy]!,
              step.files.map((f) => ({
                path: f.path,
                changes: f.ranges.map((range) => ({ range, digest: null })),
              })),
              { actor: ACTORS[step.actor]!, scope: step.scope, ttl_seconds: step.ttl },
            );
            const touched = index.apply(hb, now);
            tracker.refresh(
              index.judge(touched, now, { workingCopyId: hb.working_copy_id, actor: hb.actor }),
              now,
            );
          }

          for (const copy of COPIES) {
            const truth = PATHS.flatMap((path) =>
              [...(index.collisionsAt(REPO, path, now).get(copy)?.values() ?? [])].map((w) =>
                keyOf(path, w),
              ),
            ).sort();
            const held = tracker
              .current(REPO, copy, now)
              .map((w) => keyOf(w.path, w))
              .sort();
            expect(held).toEqual(truth);
            expect([...replayed.get(copy)!.values()].sort()).toEqual(truth);
          }
        }
      }),
      { numRuns: Number(process.env.ORACLE_RUNS ?? 300) },
    );
  });
});
