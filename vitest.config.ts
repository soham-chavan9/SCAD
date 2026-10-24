import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "tests/*/src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    // Integration suites share one Postgres / Docker daemon; avoid cross-file races.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      DATABASE_URL:
        process.env["DATABASE_URL"] ?? "postgres://scad:scad@localhost:5432/scad_test",
    },
  },
});
