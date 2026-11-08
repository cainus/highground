import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4319);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // The real server, the fake GitHub and Postgres, serving a fresh build of the dashboard.
    command: "pnpm -s build && node apps/server/e2e/serve.ts",
    url: `http://127.0.0.1:${port}/`,
    env: { E2E_PORT: String(port) },
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
  },
});
