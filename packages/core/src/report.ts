import { type HeartbeatInput, MAX_FILES, MAX_REPORT_PARTS } from "./contract.ts";

type ReportHeartbeat = Required<Pick<HeartbeatInput, "scope" | "part" | "files">>;

/**
 * An actor's whole state as the heartbeats that carry it: one complete heartbeat, or,
 * past one heartbeat's files, the numbered parts of one complete report, which the server
 * applies once the last is in. A report past the most parts keeps the files that fit.
 */
export function reportHeartbeats(files: HeartbeatInput["files"]): ReportHeartbeat[] {
  if (files.length <= MAX_FILES) return [{ scope: "complete", part: null, files }];
  const report = crypto.randomUUID();
  const of = Math.min(Math.ceil(files.length / MAX_FILES), MAX_REPORT_PARTS);
  return Array.from({ length: of }, (_, i) => ({
    scope: "complete",
    part: { report, index: i + 1, of },
    files: files.slice(i * MAX_FILES, (i + 1) * MAX_FILES),
  }));
}
