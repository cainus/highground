import { join } from "node:path";
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
