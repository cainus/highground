import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          exclude: ["apps/web/**"],
          globalSetup: ["apps/server/test/global-setup.ts"],
        },
      },
      {
        extends: true,
        plugins: [react()],
        resolve: { alias: { "@": new URL("./apps/web/src", import.meta.url).pathname } },
        test: {
          name: "web",
          root: "apps/web",
          include: ["test/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["test/setup.ts"],
        },
      },
    ],
  },
});
