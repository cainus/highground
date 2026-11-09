import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/** `.highground/daemon.json`: how an MCP server in this working copy reaches its daemon. */
export const DaemonFileSchema = z.object({
  port: z.number().int(),
  /** Hosts to try in order: the machine itself, then the host of a container. */
  addresses: z.array(z.string()),
  secret: z.string(),
  /** The Highground server the daemon reports to; the MCP server's fallback uses it too. */
  server: z.string(),
  pid: z.number().int(),
});
export type DaemonFile = z.infer<typeof DaemonFileSchema>;

export const daemonFilePath = (root: string) => join(root, ".highground", "daemon.json");

/**
 * `.highground/summary.md`: what the working copy's effort is and why, in plain language.
 * An agent writes it with `describe_work`; a person may edit it by hand. Every heartbeat
 * from the working copy carries it.
 */
export const summaryFilePath = (root: string) => join(root, ".highground", "summary.md");

/** The longest summary sent; the server refuses longer. */
export const MAX_SUMMARY = 1000;

/** The working copy's summary, or null when it has none. */
export async function readSummary(root: string): Promise<string | null> {
  const text = await readFile(summaryFilePath(root), "utf8").catch(() => "");
  return text.trim().slice(0, MAX_SUMMARY) || null;
}

/** Replaces the working copy's summary; a blank one removes it. Returns what was kept. */
export async function writeSummary(root: string, summary: string): Promise<string | null> {
  const text = summary.trim().slice(0, MAX_SUMMARY);
  if (!text) {
    await rm(summaryFilePath(root), { force: true });
    return null;
  }
  await mkdir(dirname(summaryFilePath(root)), { recursive: true });
  await writeFile(summaryFilePath(root), `${text}\n`);
  return text;
}
