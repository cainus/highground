import { HeartbeatSchema, type Heartbeat, type HeartbeatInput } from "@highground/core";

export const REPO = "github.com/acme/api";
export const SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);
export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const CAROL = "33333333-3333-4333-8333-333333333333";

/** A parsed heartbeat for one working copy, with defaults filled. */
export function heartbeat(
  workingCopyId: string,
  files: HeartbeatInput["files"],
  overrides: Partial<HeartbeatInput> = {},
): Heartbeat {
  return HeartbeatSchema.parse({
    repo: REPO,
    working_copy_id: workingCopyId,
    actor: { type: "cli", id: "daemon" },
    author: `${workingCopyId.slice(0, 4)}@acme.com`,
    branch: "feature",
    base_sha: SHA,
    scope: "partial",
    files,
    ...overrides,
  });
}

/** One file with intent-style changes (no digest). */
export function file(path: string, ...ranges: [number, number][]): HeartbeatInput["files"][number] {
  return { path, changes: ranges.map((range) => ({ range, digest: null })) };
}
