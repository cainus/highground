import { describe, expect, it } from "vitest";
import { contract, HeartbeatSchema, WarningsQuerySchema } from "../src/index.ts";

const SHA = "a".repeat(40);
const WC = "3f6c2b1e-8d4a-4c5b-9e7f-0a1b2c3d4e5f";

const heartbeat = (overrides: Record<string, unknown> = {}) => ({
  repo: "github.com/acme/api",
  working_copy_id: WC,
  actor: { type: "agent", id: "claude-session-91" },
  author: "alice@acme.com",
  branch: "feature/refactor-auth",
  base_sha: SHA,
  scope: "partial",
  files: [{ path: "src/auth/jwt.py", changes: [{ range: [45, 62], digest: null }] }],
  ...overrides,
});

describe("HeartbeatSchema", () => {
  it("accepts a heartbeat and fills defaults", () => {
    const parsed = HeartbeatSchema.parse(heartbeat());
    expect(parsed.ttl_seconds).toBe(60);
    expect(parsed.files[0]).toEqual({
      path: "src/auth/jwt.py",
      whole_file: false,
      changes: [{ range: [45, 62], digest: null }],
      intent: null,
    });
  });

  it.each([
    ["an insertion point", [[6, 5]]],
    ["the top-of-file insertion point", [[1, 0]]],
  ])("accepts %s", (_name, ranges) => {
    const files = [{ path: "a.ts", changes: ranges.map((range) => ({ range, digest: null })) }];
    expect(HeartbeatSchema.safeParse(heartbeat({ files })).success).toBe(true);
  });

  it.each([
    [
      "a range starting at 0",
      { files: [{ path: "a.ts", changes: [{ range: [0, 3], digest: null }] }] },
    ],
    [
      "a backwards range",
      { files: [{ path: "a.ts", changes: [{ range: [9, 5], digest: null }] }] },
    ],
    [
      "a fractional line",
      { files: [{ path: "a.ts", changes: [{ range: [1.5, 2], digest: null }] }] },
    ],
    [
      "a malformed digest",
      { files: [{ path: "a.ts", changes: [{ range: [1, 2], digest: "xyz" }] }] },
    ],
    ["an absolute path", { files: [{ path: "/etc/passwd", changes: [] }] }],
    ["a path escaping the repo", { files: [{ path: "../secret", changes: [] }] }],
    ["a TTL under 5 s", { ttl_seconds: 4 }],
    ["a TTL over 300 s", { ttl_seconds: 301 }],
    [
      "an intent over 280 characters",
      { files: [{ path: "a.ts", changes: [], intent: "x".repeat(281) }] },
    ],
    [
      "more than 50 changes in a file",
      {
        files: [
          {
            path: "a.ts",
            changes: Array.from({ length: 51 }, (_, i) => ({
              range: [i + 1, i + 1],
              digest: null,
            })),
          },
        ],
      },
    ],
    [
      "more than 200 files",
      { files: Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.ts`, changes: [] })) },
    ],
    ["a repo that isn't host/owner/name", { repo: "acme-api" }],
    ["a working copy that isn't a UUID", { working_copy_id: "my-laptop" }],
    ["a base that isn't a commit SHA", { base_sha: "main" }],
    ["an unknown scope", { scope: "everything" }],
    ["an unknown actor type", { actor: { type: "robot", id: "r2" } }],
  ])("rejects %s", (_name, overrides) => {
    expect(HeartbeatSchema.safeParse(heartbeat(overrides)).success).toBe(false);
  });

  it("accepts a SHA-256 repository's 64-character commit ids", () => {
    expect(HeartbeatSchema.safeParse(heartbeat({ base_sha: "b".repeat(64) })).success).toBe(true);
  });
});

describe("WarningsQuerySchema", () => {
  it("coerces query-string numbers", () => {
    const parsed = WarningsQuerySchema.parse({
      repo: "github.com/acme/api",
      path: "a.ts",
      start: "10",
      end: "20",
      working_copy_id: WC,
      base_sha: SHA,
    });
    expect([parsed.start, parsed.end]).toEqual([10, 20]);
  });
});

describe("contract", () => {
  it("exposes the three procedures on the PRD's REST paths", () => {
    expect(contract.heartbeat["~orpc"].route).toMatchObject({ method: "POST", path: "/heartbeat" });
    expect(contract.warnings["~orpc"].route).toMatchObject({ method: "GET", path: "/warnings" });
    expect(contract.subscribe["~orpc"].route).toMatchObject({ method: "GET", path: "/subscribe" });
  });
});
