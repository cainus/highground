import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRange, type Range, type Warning } from "@highground/core";
import { ensureIdentity, findIdentity, repoState } from "@highground/git";
import type { Log } from "@highground/log";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { z } from "zod";
import { daemonFilePath, DaemonFileSchema, type DaemonFile } from "./discovery.ts";
import type { daemonContract } from "./local-contract.ts";
import { broadcastIntent, checkRadar } from "./radar.ts";
import { configDir } from "./config.ts";
import { Credentials } from "./credentials.ts";
import { describeError, serverClient, type ServerClient } from "./server-client.ts";
import { VERSION } from "./version.ts";

export interface McpOptions {
  /** The agent's working directory, inside the working copy it works in. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: Log;
  /** How long to wait for a daemon before trying the next route. */
  daemonTimeoutMs?: number;
}

export type Route = "daemon" | "git";

export interface RadarAnswer {
  /** Which route answered; null when none could. */
  route: Route | null;
  degraded: boolean;
  /** Why the radar could not be consulted, when degraded. */
  reason?: string;
  /** In working-copy lines. */
  warnings: Warning[];
}

type DaemonClient = ContractRouterClient<typeof daemonContract>;

const RangeInput = z
  .tuple([z.number().int(), z.number().int()])
  .refine((r) => isRange(r), "a range is [start, end] with 1 <= start and end >= start - 1");

/** Where the agent is: its working copy, its id, and the daemon file when there is one. */
async function locate(
  cwd: string,
): Promise<{ root: string; id: string; daemon: DaemonFile | null }> {
  let found = await findIdentity(cwd);
  if (!found) {
    const state = await repoState(cwd);
    found = { root: state.root, id: await ensureIdentity(state.root) };
  }
  const text = await readFile(daemonFilePath(found.root), "utf8").catch(() => null);
  const parsed = text ? DaemonFileSchema.safeParse(JSON.parse(text)) : null;
  return { ...found, daemon: parsed?.success ? parsed.data : null };
}

/**
 * A path the agent gave, relative to the repository root with `/` separators. Its
 * directory is resolved through symlinks, as git resolves the root, so `/var/…` and
 * `/private/var/…` name the same file; the file itself may not exist yet.
 */
async function repoPath(root: string, cwd: string, path: string): Promise<string> {
  const absolute = resolve(cwd, path);
  const directory = await realpath(dirname(absolute)).catch(() => dirname(absolute));
  const rel = relative(root, join(directory, basename(absolute)));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${path} is not inside the working copy at ${root}`);
  }
  return rel.split(sep).join("/");
}

type Call =
  | { kind: "intent"; path: string; ranges: Range[]; intent: string | null; ttl_seconds: number }
  | { kind: "check"; path: string; ranges: Range[] };

/**
 * The stdio MCP server an agent runs (PRD §6). Each call goes to the daemon when one
 * answers, else runs git itself against the server, else fails open with the reason.
 */
export function createMcpServer({ cwd, env, log, daemonTimeoutMs = 1_500 }: McpOptions): McpServer {
  const server = new McpServer({ name: "highground", version: VERSION });
  let actorId: string | undefined;
  const actor = () => {
    const client = server.server.getClientVersion()?.name ?? "agent";
    actorId ??= `${client}-${randomBytes(3).toString("hex")}`;
    return { type: "agent" as const, id: actorId };
  };

  async function viaDaemon(
    daemon: DaemonFile | null,
    id: string,
    call: Call & { path: string },
    reasons: string[],
  ): Promise<Warning[] | null> {
    const secret = env.HIGHGROUND_DAEMON_SECRET ?? daemon?.secret;
    const urls = [
      ...(env.HIGHGROUND_DAEMON_URL ? [env.HIGHGROUND_DAEMON_URL] : []),
      ...(daemon ? daemon.addresses.map((host) => `http://${host}:${daemon.port}`) : []),
    ];
    if (urls.length === 0) reasons.push("no daemon announced in .highground/daemon.json");
    for (const url of urls) {
      const client: DaemonClient = createORPCClient(
        new RPCLink({
          url: `${url.replace(/\/+$/, "")}/rpc`,
          headers: { authorization: `Bearer ${secret ?? ""}` },
        }),
      );
      const signal = AbortSignal.timeout(daemonTimeoutMs);
      try {
        const { warnings } =
          call.kind === "intent"
            ? await client.intent({ working_copy_id: id, actor: actor(), ...call }, { signal })
            : await client.check({ working_copy_id: id, ...call }, { signal });
        return warnings;
      } catch (error) {
        reasons.push(`daemon at ${url}: ${describeError(error)}`);
      }
    }
    return null;
  }

  async function viaGit(
    root: string,
    daemon: DaemonFile | null,
    id: string,
    call: Call,
    reasons: string[],
  ): Promise<Warning[] | null> {
    const url = env.HIGHGROUND_SERVER_URL ?? daemon?.server;
    if (!url) {
      reasons.push("no server: set HIGHGROUND_SERVER_URL or run the daemon");
      return null;
    }
    try {
      const context = {
        state: await repoState(root),
        workingCopyId: id,
        server: serverClient(url, new Credentials({ dir: configDir(env), server: url, env })),
      };
      const warnings =
        call.kind === "intent"
          ? await broadcastIntent(context, { actor: actor(), ...call })
          : await checkRadar(context, call);
      reportGitRoute(context.server, context.state.repo, id, reasons.join("; "));
      return warnings;
    } catch (error) {
      reasons.push(`git route: ${describeError(error)}`);
      return null;
    }
  }

  /**
   * Tells the server this agent is being answered without its daemon, so the admin page
   * shows it: at most once a minute, and never in the way of the answer.
   */
  let reportedAt = 0;
  function reportGitRoute(client: ServerClient, repo: string, id: string, reason: string): void {
    if (Date.now() - reportedAt < 60_000) return;
    reportedAt = Date.now();
    client
      .clientStatus({
        repo,
        working_copy_id: id,
        client: "mcp",
        version: VERSION,
        route: "git",
        degraded: reason.slice(0, 500) || "daemon unreachable",
      })
      .catch((error: unknown) =>
        log.warn({ reason: describeError(error) }, "status report failed"),
      );
  }

  async function answer(call: Call): Promise<RadarAnswer> {
    const reasons: string[] = [];
    try {
      const here = await realpath(cwd);
      const { root, id, daemon } = await locate(here);
      const routed = { ...call, path: await repoPath(root, here, call.path) };
      const fromDaemon = await viaDaemon(daemon, id, routed, reasons);
      if (fromDaemon) return { route: "daemon", degraded: false, warnings: fromDaemon };
      const fromGit = await viaGit(root, daemon, id, routed, reasons);
      if (fromGit) {
        log.info({ reasons }, "answered without the daemon");
        return { route: "git", degraded: false, warnings: fromGit };
      }
    } catch (error) {
      reasons.push(describeError(error));
    }
    const reason = reasons.join("; ");
    log.warn({ tool: call.kind, reason }, "radar unavailable; failing open");
    return { route: null, degraded: true, reason, warnings: [] };
  }

  const reply = (result: RadarAnswer) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
  });

  server.registerTool(
    "broadcast_edit_intent",
    {
      description:
        "Announce that you are about to change these lines of a file, and learn who else is changing them. " +
        "Ranges are [start, end] in the file's current line numbers, inclusive; [n+1, n] means inserting after line n. " +
        "An empty list withdraws your intent for the file. Advisory only: it never blocks.",
      inputSchema: {
        path: z.string().describe("The file, absolute or relative to your working directory."),
        ranges: z.array(RangeInput).max(50),
        intent: z.string().max(280).describe("What you are about to do, in a sentence."),
        ttl_seconds: z.number().int().min(5).max(300).default(60),
      },
    },
    async ({ path, ranges, intent, ttl_seconds }) =>
      reply(await answer({ kind: "intent", path, ranges, intent, ttl_seconds })),
  );

  server.registerTool(
    "check_file_radar",
    {
      description:
        "Check who else is changing these lines of a file, without announcing anything. " +
        "Ranges are [start, end] in the file's current line numbers, inclusive.",
      inputSchema: {
        path: z.string().describe("The file, absolute or relative to your working directory."),
        ranges: z.array(RangeInput).min(1).max(50),
      },
    },
    async ({ path, ranges }) => reply(await answer({ kind: "check", path, ranges })),
  );

  return server;
}
