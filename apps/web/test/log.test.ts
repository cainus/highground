import { LogLinesSchema } from "@highground/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Log = typeof import("../src/log.ts");
let logger: Log;
let posted: unknown[];
let beacons: unknown[];

const setVisibility = (state: DocumentVisibilityState) =>
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  posted = [];
  beacons = [];
  setVisibility("visible");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(init.body as string));
      return new Response("{}");
    }),
  );
  navigator.sendBeacon = vi.fn((_url: string | URL, body?: BodyInit | null) => {
    beacons.push(body);
    return true;
  });
  logger = await import("../src/log.ts");
  logger.installLogging();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("frontend logging", () => {
  it("batches lines and sends them in the shape the server accepts", async () => {
    logger.log("info", "one");
    logger.logError(new Error("boom"), "radar failed");
    expect(posted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(posted).toHaveLength(1);
    const batch = LogLinesSchema.parse(posted[0]);
    expect(batch.lines.map((l) => l.msg)).toEqual(["one", "radar failed: boom"]);
    expect(batch.lines[1]!.stack).toMatch(/boom/);
  });

  it("captures uncaught errors and unhandled rejections", async () => {
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("thrown"), message: "thrown" }),
    );
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: "nope" });
    window.dispatchEvent(rejection);
    await vi.advanceTimersByTimeAsync(5_000);
    const { lines } = LogLinesSchema.parse(posted[0]);
    expect(lines.map((l) => l.msg)).toEqual([
      "uncaught error: thrown",
      "unhandled rejection: nope",
    ]);
  });

  it("flushes with sendBeacon when the page is hidden, so the last lines survive leaving", async () => {
    logger.log("warn", "leaving");
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(posted).toHaveLength(0);
    expect(beacons).toHaveLength(1);
    const body = await (beacons[0] as Blob).text();
    expect(LogLinesSchema.parse(JSON.parse(body)).lines[0]!.msg).toBe("leaving");
  });

  it("never sends a batch over the server's limits, however much is logged", async () => {
    const huge = "x".repeat(10_000);
    for (let i = 0; i < 250; i++) logger.log("error", huge);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(posted.length).toBeGreaterThanOrEqual(5);
    for (const batch of posted) {
      const parsed = LogLinesSchema.parse(batch);
      expect(JSON.stringify(parsed).length).toBeLessThan(64 * 1024);
    }
  });
});
