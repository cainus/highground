import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/** One Postgres for the whole run; each test file makes its own database in it. */
export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  project.provide("databaseUrl", container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
