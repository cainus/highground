import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { untilAborted } from "../src/abortable.ts";

describe("untilAborted", () => {
  it("answers with each read, and leaves nothing behind on the signal", async () => {
    const controller = new AbortController();
    for (let i = 0; i < 1000; i++) {
      expect(
        await untilAborted(Promise.resolve({ done: false, value: i }), controller.signal),
      ).toEqual({ done: false, value: i });
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("ends a read still waiting when the signal aborts, and one started after", async () => {
    const controller = new AbortController();
    const waiting = untilAborted(new Promise<IteratorResult<number>>(() => {}), controller.signal);
    controller.abort();
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(
      await untilAborted(Promise.resolve({ done: false, value: 1 }), controller.signal),
    ).toEqual({ done: true, value: undefined });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("passes a failed read on", async () => {
    const failed = untilAborted(
      Promise.reject(new Error("stream broke")),
      new AbortController().signal,
    );
    await expect(failed).rejects.toThrow("stream broke");
  });
});
