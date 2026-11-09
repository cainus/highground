import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { commonDirOf } from "@highground/git";
import { z } from "zod";

const ConfigSchema = z
  .object({
    server: z.url().optional(),
    /**
     * Repositories to report, each named by any one of its worktrees. The daemon follows
     * every worktree git lists for them, as worktrees come and go.
     */
    repositories: z.array(z.string()).default([]),
    /** An older config's list of working copies: each now names its repository. */
    workingCopies: z.array(z.string()).optional(),
  })
  .transform(({ server, repositories, workingCopies = [] }) => ({
    ...(server === undefined ? {} : { server }),
    repositories: [...new Set([...repositories, ...workingCopies])],
  }));
export type Config = z.infer<typeof ConfigSchema>;

/** `HIGHGROUND_CONFIG_DIR`, else `$XDG_CONFIG_HOME/highground`, else `~/.config/highground`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HIGHGROUND_CONFIG_DIR) return env.HIGHGROUND_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "highground");
}

export const configFile = (dir: string) => join(dir, "config.json");

/** The config, or the empty config when there is none yet. */
export async function readConfig(dir: string): Promise<Config> {
  const text = await readFile(configFile(dir), "utf8").catch(() => "{}");
  return ConfigSchema.parse(JSON.parse(text));
}

/**
 * Adds the repository holding `root` for the daemon to follow; returns false when it was
 * already there. The config is rewritten with one entry per repository, and without the
 * entries that no longer lead to one, such as a deleted worktree.
 */
export async function addRepository(dir: string, root: string): Promise<boolean> {
  const config = await readConfig(dir);
  const byRepository = new Map<string, string>();
  for (const entry of config.repositories) {
    const common = await commonDirOf(entry).catch(() => null);
    if (common !== null && !byRepository.has(common)) byRepository.set(common, entry);
  }
  const common = await commonDirOf(root);
  const added = !byRepository.has(common);
  if (added) byRepository.set(common, root);
  const repositories = await Promise.all(
    [...byRepository.values()].map((entry) => realpath(entry).catch(() => entry)),
  );
  await mkdir(dir, { recursive: true });
  const { server } = config;
  await writeFile(
    configFile(dir),
    `${JSON.stringify({ ...(server ? { server } : {}), repositories }, null, 2)}\n`,
  );
  return added;
}
