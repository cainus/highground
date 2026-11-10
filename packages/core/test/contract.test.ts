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
    expect(parsed).toMatchObject({
      kind: "live",
      head_sha: null,
      last_commit_at: null,
      pr_url: null,
      merges: [],
      summary: null,
      part: null,
    });
    expect(parsed.files[0]).toEqual({
      path: "src/auth/jwt.py",
      whole_file: false,
      changes: [{ range: [45, 62], digest: null }],
      intent: null,
    });
  });

  it("takes a working copy's summary of its work, up to 1,000 characters", () => {
    expect(HeartbeatSchema.parse(heartbeat({ summary: "Why and what" })).summary).toBe(
      "Why and what",
    );
    expect(HeartbeatSchema.safeParse(heartbeat({ summary: "x".repeat(1001) })).success).toBe(false);
  });

  it("takes a complete report in numbered parts, up to 50", () => {
    const report = "7d1c4f3a-2b6e-4a8d-9c0f-1e2d3c4b5a69";
    const part = (value: unknown, scope = "complete") =>
      HeartbeatSchema.safeParse(heartbeat({ scope, part: value }));
    expect(HeartbeatSchema.parse(heartbeat()).part).toBeNull();
    expect(part({ report, index: 2, of: 3 }).data?.part).toEqual({ report, index: 2, of: 3 });
    expect(part({ report, index: 1, of: 50 }).success).toBe(true);
    expect(part({ report, index: 1, of: 2 }, "partial").success).toBe(false);
    expect(part({ report, index: 4, of: 3 }).success).toBe(false);
    expect(part({ report, index: 0, of: 3 }).success).toBe(false);
    expect(part({ report, index: 1, of: 1 }).success).toBe(false);
    expect(part({ report, index: 1, of: 51 }).success).toBe(false);
    expect(part({ report: "r1", index: 1, of: 2 }).success).toBe(false);
  });

  it("says why a whole file is reported, and reads an older client's `true` as no reason", () => {
    const wholeFile = (value: unknown) =>
      HeartbeatSchema.safeParse(
        heartbeat({ files: [{ path: "a.ts", whole_file: value, changes: [] }] }),
      );
    for (const reason of ["added", "deleted", "binary", "renamed"]) {
      expect(wholeFile(reason).data?.files[0]?.whole_file).toBe(reason);
    }
    expect(wholeFile(true).data?.files[0]?.whole_file).toBe("whole");
    expect(wholeFile(false).data?.files[0]?.whole_file).toBe(false);
    expect(wholeFile("moved").success).toBe(false);
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

  it("accepts parked work with its head, last commit, and merge results", () => {
    const parked = heartbeat({
      kind: "parked",
      head_sha: "c".repeat(40),
      last_commit_at: "2026-11-01T10:00:00Z",
      merges: [{ branch: "feature/x", head_sha: "d".repeat(40), conflicts: ["src/a.ts"] }],
    });
    expect(HeartbeatSchema.safeParse(parked).success).toBe(true);
  });

  it.each([
    ["an unknown kind", { kind: "stashed" }],
    ["a merge result without a head", { merges: [{ branch: "x", conflicts: [] }] }],
    [
      "a merge conflict outside the repo",
      { merges: [{ branch: "x", head_sha: "d".repeat(40), conflicts: ["/etc/x"] }] },
    ],
    ["a last commit that isn't a timestamp", { last_commit_at: "yesterday" }],
    ["a PR link that isn't a URL", { pr_url: "#42" }],
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
    expect(parsed.branch).toBeUndefined();
  });

  it("takes the asker's branch, so its own pushed copy can be left out", () => {
    const parsed = WarningsQuerySchema.parse({
      repo: "github.com/acme/api",
      path: "a.ts",
      start: "1",
      end: "1",
      working_copy_id: WC,
      base_sha: SHA,
      branch: "feature/x",
    });
    expect(parsed.branch).toBe("feature/x");
  });
});

describe("contract", () => {
  it("exposes the three procedures on the PRD's REST paths", () => {
    expect(contract.heartbeat["~orpc"].route).toMatchObject({ method: "POST", path: "/heartbeat" });
    expect(contract.warnings["~orpc"].route).toMatchObject({ method: "GET", path: "/warnings" });
    expect(contract.subscribe["~orpc"].route).toMatchObject({ method: "GET", path: "/subscribe" });
  });
});
