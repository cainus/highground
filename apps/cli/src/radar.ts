import {
  toBase,
  toWorking,
  type Actor,
  type Hunk,
  type Range,
  type Warning,
} from "@highground/core";
import { fileHunks, type RepoState } from "@highground/git";
import type { ServerClient } from "./server-client.ts";

/** A working copy as the radar needs it: where it is, where it stands, and who it is. */
export interface RadarContext {
  state: RepoState;
  workingCopyId: string;
  server: ServerClient;
}

export interface IntentRequest {
  actor: Actor;
  /** Relative to the repository root. */
  path: string;
  /** Working-copy lines; empty withdraws the actor's intent for the file. */
  ranges: Range[];
  intent: string | null;
  ttl_seconds: number;
}

export interface CheckRequest {
  path: string;
  /** Working-copy lines. */
  ranges: Range[];
}

/** Maps a warning's lines from base coordinates into this file's working-copy lines. */
function inWorkingLines(warning: Warning, hunks: Hunk[] | null): Warning {
  if (!hunks) return warning;
  const map = (range: Range | null) => (range ? toWorking(range, hunks).range : null);
  return {
    ...warning,
    your_lines: map(warning.your_lines),
    peer: { ...warning.peer, lines: map(warning.peer.lines) },
  };
}

/**
 * Sends an actor's intent to change `ranges` of a file as a partial heartbeat, and
 * returns the collisions with it, in working-copy lines. A file not in the base is
 * announced as a whole-file change.
 */
export async function broadcastIntent(
  { state, workingCopyId, server }: RadarContext,
  request: IntentRequest,
): Promise<Warning[]> {
  const hunks = await fileHunks(state.root, state.base, request.path);
  const { warnings } = await server.heartbeat({
    repo: state.repo,
    working_copy_id: workingCopyId,
    actor: request.actor,
    author: state.author,
    branch: state.branch,
    base_sha: state.base,
    scope: "partial",
    files: [
      {
        path: request.path,
        whole_file: hunks === null && request.ranges.length > 0 ? "whole" : false,
        changes: hunks
          ? request.ranges.map((range) => ({ range: toBase(range, hunks).range, digest: null }))
          : [],
        intent: request.intent,
      },
    ],
    ttl_seconds: request.ttl_seconds,
  });
  return warnings.map((w) => inWorkingLines(w, hunks));
}

/** Who else is changing these working-copy lines of a file, without announcing anything. */
export async function checkRadar(
  { state, workingCopyId, server }: RadarContext,
  request: CheckRequest,
): Promise<Warning[]> {
  const hunks = await fileHunks(state.root, state.base, request.path);
  // A file not in the base has no base lines; the top-of-file point still meets whole-file peers.
  const ranges = hunks ? request.ranges.map((r) => toBase(r, hunks).range) : [[1, 0] as Range];
  const answers = await Promise.all(
    ranges.map(([start, end]) =>
      server.warnings({
        repo: state.repo,
        path: request.path,
        start,
        end,
        working_copy_id: workingCopyId,
        base_sha: state.base,
        branch: state.branch,
      }),
    ),
  );
  return answers.flatMap(({ warnings }) => warnings.map((w) => inWorkingLines(w, hunks)));
}
