import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
