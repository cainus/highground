import type { CollisionEvent, Heartbeat } from "@highground/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoggedHeartbeat } from "../src/db/heartbeat-log.ts";
import { Hub, type HeartbeatStore } from "../src/hub.ts";
import { ALICE, BOB, CAROL, file, heartbeat, REPO, SHA } from "./fixtures.ts";

/**
 * PRD §12, criteria 5 and 6, on fake timers: the hub with its production sweep and grace
 * periods, over an in-memory log, so whole TTLs pass in no time.
 */

/** The heartbeat log, in memory: what reached it survives a "restart". */
class MemoryStore implements HeartbeatStore {
  readonly rows: LoggedHeartbeat[] = [];
  append(heartbeat: Heartbeat, receivedAt: number): Promise<void> {
    this.rows.push({ heartbeat, receivedAt });
    return Promise.resolve();
  }
  since(cutoff: Date): Promise<LoggedHeartbeat[]> {
    return Promise.resolve(this.rows.filter((r) => r.receivedAt > cutoff.getTime()));
  }
  listen(): Promise<() => Promise<void>> {
    return Promise.resolve(() => Promise.resolve());
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

const SWEEP_MS = 5_000;
const GRACE_MS = 10_000;
const hubs: Hub[] = [];

async function hub(store = new MemoryStore()): Promise<Hub> {
  const h = new Hub(store, { sweepMs: SWEEP_MS, graceMs: GRACE_MS });
  await h.start();
  hubs.push(h);
  return h;
}

/** Follows a working copy's collision events, as its SSE stream would. */
function follow(h: Hub, workingCopyId: string) {
  const events: CollisionEvent["event"][] = [];
  const controller = new AbortController();
  void (async () => {
    for await (const e of h.subscribe(REPO, workingCopyId, controller.signal)) events.push(e.event);
  })();
  return { events, close: () => controller.abort() };
}

const collides = (h: Hub) =>
  h.query({
    repo: REPO,
    path: "a.ts",
    start: 60,
    end: 60,
    working_copy_id: ALICE,
    base_sha: SHA,
    branch: "mine",
  }).has_collisions;

/** Lets the subscription generators run after timers fire. */
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse("2026-11-08T12:00:00Z") });
});
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.stop()));
  vi.useRealTimers();
});

describe("a silent client's warnings", () => {
  it.each([5, 60, 300])(
    "last until its ttl of %i s, and end for subscribers within ttl + 5 s",
    async (ttl) => {
      const h = await hub();
      h.heartbeat(heartbeat(ALICE, [file("a.ts", [55, 65])], { ttl_seconds: 300 }));
      const alice = follow(h, ALICE);
      h.heartbeat(heartbeat(BOB, [file("a.ts", [50, 75])], { ttl_seconds: ttl }));
      await advance(0);
      expect(alice.events).toEqual(["collision_started"]);

      await advance(ttl * 1000 - 1);
      expect(collides(h)).toBe(true);
      expect(alice.events).toEqual(["collision_started"]);

      await advance(5_001);
      expect(collides(h)).toBe(false);
      expect(alice.events).toEqual(["collision_started", "collision_ended"]);
      alice.close();
    },
  );

  it("go once a closed stream stays away for 10 s, and not before", async () => {
    const h = await hub();
    h.heartbeat(heartbeat(ALICE, [file("a.ts", [55, 65])], { ttl_seconds: 300 }));
    const alice = follow(h, ALICE);
    const bob = follow(h, BOB);
    h.heartbeat(heartbeat(BOB, [file("a.ts", [50, 75])], { ttl_seconds: 300 }));
    await advance(0);

    bob.close();
    await advance(GRACE_MS - 1);
    expect(collides(h)).toBe(true);

    await advance(1);
    expect(collides(h)).toBe(false);
    expect(alice.events).toEqual(["collision_started", "collision_ended"]);
    alice.close();
  });
});

describe("a restart", () => {
  it("brings back unexpired work, keeps expired work gone, and does not extend a ttl", async () => {
    const store = new MemoryStore();
    const first = await hub(store);
    first.heartbeat(heartbeat(ALICE, [file("a.ts", [55, 65])], { ttl_seconds: 300 }));
    first.heartbeat(heartbeat(BOB, [file("a.ts", [50, 75])], { ttl_seconds: 60 }));
    // Carol's work expires before the restart; it is still in the log.
    first.heartbeat(heartbeat(CAROL, [file("b.ts", [1, 9])], { ttl_seconds: 5 }));
    await first.stop();
    hubs.splice(hubs.indexOf(first), 1);

    await advance(30_000);
    const second = await hub(store);
    expect(collides(second)).toBe(true);
    expect(second.radar(REPO).files.map((f) => f.path)).toEqual(["a.ts"]);

    // Bob's 60 s run from when he sent, not from the restart.
    await advance(30_000 + SWEEP_MS);
    expect(collides(second)).toBe(false);
  });
});

describe("who is reporting a repository", () => {
  const reporting = (h: Hub) => h.radar(REPO).reporting;
  const idle = (
    workingCopyId: string,
    ttl = 60,
    actor: Heartbeat["actor"] = { type: "cli", id: "daemon" },
  ) => heartbeat(workingCopyId, [], { scope: "complete", ttl_seconds: ttl, actor });

  it("counts working copies whose live heartbeats are within their ttl, idle ones too", async () => {
    const h = await hub();
    expect(reporting(h)).toEqual({ working_copies: 0, last_heartbeat_at: null });

    h.heartbeat(idle(ALICE));
    h.heartbeat(idle(ALICE, 300, { type: "agent", id: "agent-1" }));
    h.heartbeat(heartbeat(BOB, [file("a.ts", [1, 3])], { ttl_seconds: 60 }));
    // Parked work is the repository's, not a client's.
    h.heartbeat(
      heartbeat(CAROL, [file("b.ts", [1, 3])], { kind: "parked", head_sha: SHA, ttl_seconds: 300 }),
    );
    const sent = new Date().toISOString();
    expect(reporting(h)).toEqual({ working_copies: 2, last_heartbeat_at: sent });

    await advance(60_000);
    expect(reporting(h)).toEqual({ working_copies: 1, last_heartbeat_at: sent });
    await advance(240_000);
    expect(reporting(h)).toEqual({ working_copies: 0, last_heartbeat_at: sent });
  });

  it("tells radar watchers when it changes, though no file did", async () => {
    const h = await hub();
    const controller = new AbortController();
    const seen: number[] = [];
    void (async () => {
      for await (const radar of h.watchRadar(REPO, controller.signal))
        seen.push(radar.reporting.working_copies);
    })();
    await advance(0);
    h.heartbeat(idle(ALICE));
    await advance(1_000);
    expect(seen).toEqual([0, 1]);

    await advance(60_000 + SWEEP_MS);
    expect(seen).toEqual([0, 1, 0]);
    controller.abort();
  });

  it("stops counting an idle working copy soon after its stream goes away", async () => {
    const h = await hub();
    const alice = follow(h, ALICE);
    h.heartbeat(idle(ALICE, 300));
    await advance(0);
    alice.close();
    await advance(GRACE_MS + 5_000 + SWEEP_MS);
    expect(reporting(h).working_copies).toBe(0);
  });

  it("is rebuilt on restart from the log", async () => {
    const store = new MemoryStore();
    const first = await hub(store);
    first.heartbeat(idle(ALICE));
    const sent = new Date().toISOString();
    await first.stop();
    hubs.splice(hubs.indexOf(first), 1);

    await advance(10_000);
    expect(reporting(await hub(store))).toEqual({ working_copies: 1, last_heartbeat_at: sent });
  });
});
