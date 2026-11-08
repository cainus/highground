import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  server: z.url().optional(),
  workingCopies: z.array(z.string()).default([]),
});
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

/** Adds a working copy for the daemon to watch; returns false when it was already there. */
export async function addWorkingCopy(dir: string, root: string): Promise<boolean> {
  const config = await readConfig(dir);
  if (config.workingCopies.includes(root)) return false;
  config.workingCopies.push(root);
  await mkdir(dir, { recursive: true });
  await writeFile(configFile(dir), `${JSON.stringify(config, null, 2)}\n`);
  return true;
}
