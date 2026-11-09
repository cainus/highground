#!/usr/bin/env node
/**
 * `highground daemon [dir…] [--server URL] [--listen HOST] [--port N]`
 * `highground watch [dir]`
 * `highground mcp`
 * `highground login [--server URL]`
 */
import { parseArgs } from "node:util";
import { repoState } from "@highground/git";
import { cliLogDir, createLog, prunePeriodically } from "@highground/log";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { addRepository, configDir, readConfig } from "./config.ts";
import { login } from "./credentials.ts";
import { Daemon } from "./daemon.ts";
import { createMcpServer } from "./mcp.ts";

const USAGE = `usage:
  highground daemon [dir…] [--server URL] [--listen HOST] [--port N]
  highground watch [dir]
  highground mcp
  highground login [--server URL]`;

const [command, ...rest] = process.argv.slice(2);
const logDir = cliLogDir();

if (command === "daemon") {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { server: { type: "string" }, listen: { type: "string" }, port: { type: "string" } },
  });
  const dir = configDir();
  const server =
    values.server ?? process.env.HIGHGROUND_SERVER_URL ?? (await readConfig(dir)).server;
  if (!server) {
    console.error(
      "highground daemon: no server; pass --server, set HIGHGROUND_SERVER_URL, or add it to the config",
    );
    process.exit(2);
  }
  const log = createLog({ service: "daemon", dir: logDir });
  prunePeriodically(logDir);
  const daemon = new Daemon({
    server,
    dirs: positionals,
    configDir: dir,
    log,
    ...(values.listen ? { listen: values.listen } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
  });
  await daemon.start();
  console.error(`highground daemon: reporting to ${server}; local endpoint on port ${daemon.port}`);
  const shutdown = () => void daemon.stop().then(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} else if (command === "watch") {
  const state = await repoState(rest[0] ?? process.cwd()).catch((error: unknown) => {
    console.error(`highground watch: ${String(error instanceof Error ? error.message : error)}`);
    process.exit(2);
  });
  const added = await addRepository(configDir(), state.root);
  console.error(
    `${added ? "following" : "already following"} the repository at ${state.root}, and all its worktrees`,
  );
} else if (command === "login") {
  const { values } = parseArgs({ args: rest, options: { server: { type: "string" } } });
  const dir = configDir();
  const server =
    values.server ?? process.env.HIGHGROUND_SERVER_URL ?? (await readConfig(dir)).server;
  if (!server) {
    console.error("highground login: no server; pass --server or set HIGHGROUND_SERVER_URL");
    process.exit(2);
  }
  await login({ server, dir, print: (line) => console.error(line) }).catch((error: unknown) => {
    console.error(`highground login: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
} else if (command === "mcp") {
  // stdout carries only protocol messages; everything else goes to the log file.
  const log = createLog({ service: "mcp", dir: logDir });
  prunePeriodically(logDir);
  const server = createMcpServer({ cwd: process.cwd(), env: process.env, log });
  await server.connect(new StdioServerTransport());
} else {
  console.error(USAGE);
  process.exit(command ? 2 : 0);
}
