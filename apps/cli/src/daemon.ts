import { randomBytes } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { commonDirOf, worktreesOf, type RepoState } from "@highground/git";
import type { Log } from "@highground/log";
import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { configDir, configFile, readConfig } from "./config.ts";
import { Credentials } from "./credentials.ts";
import { daemonFilePath, type DaemonFile } from "./discovery.ts";
import { daemonContract } from "./local-contract.ts";
import { broadcastIntent, checkRadar } from "./radar.ts";
import { Reporter, type ReporterOptions } from "./reporter.ts";
import { serverClient, type ServerClient } from "./server-client.ts";

export interface DaemonOptions {
  /** The Highground server's URL. */
  server: string;
  /** Repositories to follow, each named by any of its worktrees, besides the config's. */
  dirs: string[];
  /** Where `config.json` lives; its repositories are followed, and it is re-read when it changes. */
  configDir?: string;
  /** How often each followed repository's worktrees are listed again (3 s). */
  followMs?: number;
  /** For `HIGHGROUND_TOKEN`; the process's own by default. */
  env?: NodeJS.ProcessEnv;
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
  /** The config file being polled, if any. */
  #configWatched: string | undefined;
  /** Followed repositories: their shared git directory → the worktrees reported for it. */
  readonly #followed = new Map<string, Set<string>>();
  /** A followed repository's sync in flight, so two never overlap. */
  readonly #syncing = new Map<string, Promise<void>>();
  #followTimer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(options: DaemonOptions) {
    this.#options = options;
    const env = options.env ?? process.env;
    this.#client = serverClient(
      options.server,
      new Credentials({ dir: options.configDir ?? configDir(env), server: options.server, env }),
    );
  }

  async start(): Promise<void> {
    await this.#listen();
    const config = this.#options.configDir ? await readConfig(this.#options.configDir) : null;
    for (const dir of [...this.#options.dirs, ...(config?.repositories ?? [])]) {
      await this.follow(dir);
    }
    // Listing a repository's worktrees is one cheap git command; a poll also notices a
    // worktree deleted without telling git, which changes nothing git would report.
    this.#followTimer = setInterval(() => {
      for (const common of this.#followed.keys()) void this.#sync(common);
    }, this.#options.followMs ?? 3000);
    if (this.#options.configDir) this.#watchConfig(this.#options.configDir);
    this.#options.log.info(
      { port: this.port, workingCopies: this.#reporters.size, server: this.#options.server },
      "daemon started",
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#followTimer);
    if (this.#configWatched) unwatchFile(this.#configWatched);
    await Promise.allSettled(this.#syncing.values());
    await Promise.all([...this.#reporters.values()].map((r) => r.stop()));
    await Promise.all([...this.#announced].map((root) => this.#withdraw(root)));
    const http = this.#http;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }

  /**
   * Follows the repository holding `dir`: reports every worktree git lists for it, starts
   * on one added later, and stops on one removed. A repository already followed is ignored.
   */
  async follow(dir: string): Promise<void> {
    const common = await commonDirOf(dir).catch((error: unknown) => {
      this.#options.log.warn({ dir, reason: String(error) }, "not a git repository; skipped");
      return null;
    });
    if (common === null || this.#followed.has(common) || this.#stopped) return;
    this.#followed.set(common, new Set());
    await this.#sync(common);
  }

  #sync(common: string): Promise<void> {
    const running = this.#syncing.get(common);
    if (running) return running;
    const sync = this.#syncNow(common).finally(() => this.#syncing.delete(common));
    this.#syncing.set(common, sync);
    return sync;
  }

  /** Brings the reported worktrees of one repository in line with git's list. */
  async #syncNow(common: string): Promise<void> {
    const reported = this.#followed.get(common);
    if (!reported || this.#stopped) return;
    let listed: string[];
    try {
      listed = await worktreesOf(common);
    } catch (error) {
      // A repository deleted outright has no worktrees left; any other failure waits.
      if (
        await stat(common).then(
          () => true,
          () => false,
        )
      ) {
        this.#options.log.warn(
          { repository: common, reason: String(error) },
          "worktrees unreadable",
        );
        return;
      }
      listed = [];
    }
    const wanted = new Set(listed);
    for (const root of reported) {
      if (!wanted.has(root)) {
        reported.delete(root);
        await this.#remove(root);
      }
    }
    const added = listed.filter((root) => !reported.has(root));
    for (const root of added) reported.add(root);
    // Four at a time: a first report runs several git commands, and dozens of worktrees
    // one after another keep the daemon from saying it is up for a minute or more.
    await Promise.all(
      Array.from({ length: Math.min(4, added.length) }, async () => {
        for (let root = added.shift(); root !== undefined; root = added.shift()) {
          await this.add(root);
        }
      }),
    );
  }

  /**
   * Stops reporting a working copy. Its stream closes with it, so the server clears its
   * work within the presence grace period.
   */
  async #remove(root: string): Promise<void> {
    const reporter = this.#reporters.get(root);
    if (!reporter) return;
    this.#reporters.delete(root);
    await reporter.stop();
    if (this.#announced.delete(root)) await this.#withdraw(root);
    this.#options.log.info({ root }, "worktree gone; stopped reporting it");
  }

  /** Starts reporting a working copy; a directory already watched is ignored. */
  async add(dir: string): Promise<void> {
    const key = await realpath(dir).catch(() => dir);
    if (this.#reporters.has(key) || this.#stopped) return;
    const reporter: Reporter = new Reporter({
      root: key,
      server: this.#client,
      log: this.#options.log,
      ...this.#options.reporter,
      onState: (state) => void this.#announce(state.root),
      reportsParked: (state) => this.#parkedReporter(state.commonDir) === reporter,
    });
    this.#reporters.set(key, reporter);
    await reporter.start();
  }

  /**
   * The reporter that sends a repository's parked work: the first watched worktree of it
   * that could be read, so a deleted worktree hands it to the next.
   */
  #parkedReporter(commonDir: string): Reporter | undefined {
    for (const reporter of this.#reporters.values()) {
      if (reporter.readable && reporter.state?.commonDir === commonDir) return reporter;
    }
    return undefined;
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
    // Not recursive: a working copy deleted meanwhile stays deleted.
    await mkdir(dirname(daemonFilePath(root))).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await writeFile(daemonFilePath(root), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }

  /** Removes a `daemon.json` this daemon wrote, unless another daemon has replaced it since. */
  async #withdraw(root: string): Promise<void> {
    const text = await readFile(daemonFilePath(root), "utf8").catch(() => "");
    if (text.includes(this.secret)) await rm(daemonFilePath(root), { force: true });
  }

  /**
   * Re-reads the config when it changes. It is one small file, so it is polled once a
   * second rather than watched: a poll cannot miss a change made as the daemon starts,
   * before a watch is live, nor one on a bind mount that delivers no events.
   */
  #watchConfig(dir: string): void {
    const file = configFile(dir);
    watchFile(file, { interval: 1000 }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs) void this.#reloadConfig(dir);
    });
    this.#configWatched = file;
  }

  async #reloadConfig(dir: string): Promise<void> {
    try {
      for (const root of (await readConfig(dir)).repositories) await this.follow(root);
    } catch (error) {
      this.#options.log.warn({ file: configFile(dir), reason: String(error) }, "config unreadable");
    }
  }
}
