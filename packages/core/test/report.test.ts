import { describe, expect, it } from "vitest";
import { MAX_FILES, MAX_REPORT_PARTS, reportHeartbeats } from "../src/index.ts";

const files = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ path: `f${i}.ts`, changes: [] }));

describe("reportHeartbeats", () => {
  it("sends a report that fits as one complete heartbeat", () => {
    expect(reportHeartbeats(files(3))).toEqual([
      { scope: "complete", part: null, files: files(3) },
    ]);
    expect(reportHeartbeats([])).toEqual([{ scope: "complete", part: null, files: [] }]);
  });

  it("splits a larger one into numbered parts of one report", () => {
    const sent = reportHeartbeats(files(450));
    expect(sent.map((h) => [h.scope, h.part?.index, h.part?.of, h.files.length])).toEqual([
      ["complete", 1, 3, MAX_FILES],
      ["complete", 2, 3, MAX_FILES],
      ["complete", 3, 3, 50],
    ]);
    expect(new Set(sent.map((h) => h.part?.report)).size).toBe(1);
    expect(sent.flatMap((h) => h.files)).toEqual(files(450));
    expect(reportHeartbeats(files(450))[0]!.part?.report).not.toBe(sent[0]!.part?.report);
  });

  it("keeps the first files that fit in the most parts a report may have", () => {
    const sent = reportHeartbeats(files(MAX_FILES * MAX_REPORT_PARTS + 1));
    expect(sent).toHaveLength(MAX_REPORT_PARTS);
    expect(sent.flatMap((h) => h.files)).toEqual(files(MAX_FILES * MAX_REPORT_PARTS));
  });
});
