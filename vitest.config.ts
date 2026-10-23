import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "tests/*/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    // Integration suites share one Postgres; avoid cross-file TRUNCATE races.
    fileParallelism: false,
  },
});
