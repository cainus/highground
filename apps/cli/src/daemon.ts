import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { RepoState } from "@highground/git";
import type { Log } from "@highground/log";
import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { configFile, readConfig } from "./config.ts";
import { daemonFilePath, type DaemonFile } from "./discovery.ts";
import { daemonContract } from "./local-contract.ts";
import { broadcastIntent, checkRadar } from "./radar.ts";
import { Reporter, type ReporterOptions } from "./reporter.ts";
import { serverClient, type ServerClient } from "./server-client.ts";

export interface DaemonOptions {
  /** The Highground server's URL. */
  server: string;
  /** Working copies to watch, besides those in the config. */
  dirs: string[];
  /** Where `config.json` lives; its working copies are watched, and re-read when it changes. */
  configDir?: string;
  log: Log;
  /** The local endpoint's interface; 127.0.0.1 unless containers must reach it over a bridge. */
  listen?: string;
  port?: number;
  reporter?: Partial<Pick<ReporterOptions, "debounceMs" | "keepaliveMs" | "ttlSeconds" | "watch">>;
}

/**
 * Reports every watched working copy and serves the local endpoint MCP servers use, so
 * an agent's intent is translated and sent by the process that knows the working copy.
 */
export class Daemon {
  readonly secret = randomBytes(32).toString("hex");
  port = 0;

  readonly #options: DaemonOptions;
  readonly #client: ServerClient;
  readonly #reporters = new Map<string, Reporter>();
  /** Working-copy roots whose `daemon.json` this daemon wrote. */
  readonly #announced = new Set<string>();
  #http: Server | undefined;
  #configWatcher: FSWatcher | undefined;
  #configTimer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: DaemonOptions) {
    this.#options = options;
    this.#client = serverClient(options.server);
  }

  async start(): Promise<void> {
    await this.#listen();
    const config = this.#options.configDir ? await readConfig(this.#options.configDir) : null;
    for (const dir of [...this.#options.dirs, ...(config?.workingCopies ?? [])])
      await this.add(dir);
    if (this.#options.configDir) this.#watchConfig(this.#options.configDir);
    this.#options.log.info(
      { port: this.port, workingCopies: this.#reporters.size, server: this.#options.server },
      "daemon started",
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#configTimer);
    this.#configWatcher?.close();
    await Promise.all([...this.#reporters.values()].map((r) => r.stop()));
    await Promise.all([...this.#announced].map((root) => this.#withdraw(root)));
    const http = this.#http;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  /** Starts reporting a working copy; a directory already watched is ignored. */
  async add(dir: string): Promise<void> {
    const key = await realpath(dir).catch(() => dir);
    if (this.#reporters.has(key) || this.#stopped) return;
    const reporter = new Reporter({
      root: key,
      server: this.#client,
      log: this.#options.log,
      ...this.#options.reporter,
      onState: (state) => void this.#announce(state.root),
    });
    this.#reporters.set(key, reporter);
    await reporter.start();
  }

  /** The reporters, for status and tests. */
  reporters(): Reporter[] {
    return [...this.#reporters.values()];
  }

  #find(workingCopyId: string): { state: RepoState; workingCopyId: string } {
    for (const reporter of this.#reporters.values()) {
      if (reporter.id === workingCopyId && reporter.state) {
        return { state: reporter.state, workingCopyId };
      }
    }
    throw new ORPCError("NOT_FOUND", { message: `not watching working copy ${workingCopyId}` });
  }

  async #listen(): Promise<void> {
    const os = implement(daemonContract);
    const router = os.router({
      intent: os.intent.handler(async ({ input }) => ({
        warnings: await broadcastIntent(
          { ...this.#find(input.working_copy_id), server: this.#client },
          input,
        ),
      })),
      check: os.check.handler(async ({ input }) => ({
        warnings: await checkRadar(
          { ...this.#find(input.working_copy_id), server: this.#client },
          input,
        ),
      })),
    });
    const handler = new RPCHandler(router);
    this.#http = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${this.secret}`) {
        res.writeHead(401).end();
        return;
      }
      const { matched } = await handler.handle(req, res, { prefix: "/rpc", context: {} });
      if (!matched) res.writeHead(404).end();
    });
    const host = this.#options.listen ?? "127.0.0.1";
    await new Promise<void>((resolve) =>
      this.#http!.listen(this.#options.port ?? 0, host, resolve),
    );
    this.port = (this.#http.address() as { port: number }).port;
  }

  /** Writes `.highground/daemon.json` into a working copy, readable only by its owner. */
  async #announce(root: string): Promise<void> {
    if (this.#announced.has(root) || this.#stopped) return;
    this.#announced.add(root);
    const host = this.#options.listen ?? "127.0.0.1";
    const file: DaemonFile = {
      port: this.port,
      addresses: [host === "0.0.0.0" ? "127.0.0.1" : host, "host.docker.internal"],
      secret: this.secret,
      server: this.#options.server,
      pid: process.pid,
    };
    await mkdir(daemonFilePath(root).replace(/daemon\.json$/, ""), { recursive: true });
    await writeFile(daemonFilePath(root), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }

  /** Removes a `daemon.json` this daemon wrote, unless another daemon has replaced it since. */
  async #withdraw(root: string): Promise<void> {
    const text = await readFile(daemonFilePath(root), "utf8").catch(() => "");
    if (text.includes(this.secret)) await rm(daemonFilePath(root), { force: true });
  }

  #watchConfig(dir: string): void {
    void mkdir(dir, { recursive: true }).then(() => {
      if (this.#stopped) return;
      this.#configWatcher = watch(dir, (_event, name) => {
        if (name !== "config.json") return;
        clearTimeout(this.#configTimer);
        this.#configTimer = setTimeout(() => void this.#reloadConfig(dir), 100);
      });
    });
  }

  async #reloadConfig(dir: string): Promise<void> {
    try {
      for (const root of (await readConfig(dir)).workingCopies) await this.add(root);
    } catch (error) {
      this.#options.log.warn({ file: configFile(dir), reason: String(error) }, "config unreadable");
    }
  }
}
