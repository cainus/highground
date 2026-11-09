/**
 * Highground on this machine, for one person: the server and Postgres in Docker, open
 * but reachable only from this machine, and the daemon in the foreground.
 *
 *   ./dev               start the server, or rebuild it if the code changed, then run the
 *                       daemon until Ctrl-C (the server keeps running)
 *   ./dev watch [dir…]  have the daemon report these repositories, with all their worktrees (default: here)
 *   ./dev mcp           give every Claude Code session Highground's MCP tools (once)
 *   ./dev stop          stop the server; its data is kept
 *
 * It listens on 8090, with Postgres on 5434, so it runs beside services on 8080 and 5432.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 8090;
const POSTGRES_PORT = 5434;
const URL = `http://127.0.0.1:${PORT}`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "apps/cli/src/main.ts");
const env = {
  ...process.env,
  HIGHGROUND_ALLOW_ALL: "1",
  HIGHGROUND_PORT: `127.0.0.1:${PORT}`,
  POSTGRES_PORT: String(POSTGRES_PORT),
};

/** Runs a command to completion with the terminal attached; its exit status. */
const run = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: root, env, stdio: "inherit" }).status ?? 1;

const [command = "start", ...rest] = process.argv.slice(2);

if (command === "stop") {
  process.exit(run("docker", ["compose", "stop"]));
} else if (command === "watch") {
  const dirs = rest.length > 0 ? rest : [process.cwd()];
  let status = 0;
  for (const dir of dirs) status ||= run(process.execPath, [cli, "watch", resolve(dir)]);
  process.exit(status);
} else if (command === "mcp") {
  process.exit(
    run("claude", [
      "mcp",
      "add",
      "--scope",
      "user",
      "highground",
      "--",
      process.execPath,
      cli,
      "mcp",
    ]),
  );
} else if (command === "start") {
  console.error("Starting the server (rebuilt only if the code changed)…");
  if (run("docker", ["compose", "up", "--build", "--detach", "--wait"]) !== 0) {
    console.error(
      "\nThe server did not start. If the build failed with “frontend grpc server closed”,\n" +
        "restart OrbStack or Docker Desktop and run `./dev` again.",
    );
    process.exit(1);
  }
  console.error(
    `\nDashboard: ${URL}\nRunning the daemon; Ctrl-C stops it, \`./dev stop\` stops the server.\n`,
  );
  const daemon = spawn(process.execPath, [cli, "daemon", "--server", URL], { stdio: "inherit" });
  // Ctrl-C reaches the daemon too, as part of the terminal's process group; wait for it.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => daemon.kill("SIGTERM"));
  daemon.on("exit", (code) => process.exit(code ?? 0));
} else {
  console.error("usage: ./dev [watch [dir…] | mcp | stop]");
  process.exit(2);
}
