import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_CPU_SHARES, startToArgv } from "./builder.js";

describe("manifest.start as argv", () => {
  it("splits start into argv without a shell", () => {
    expect(startToArgv("node server.js")).toEqual(["node", "server.js"]);
    expect(startToArgv("  python -m http.server  ")).toEqual([
      "python",
      "-m",
      "http.server",
    ]);
  });

  it("uses Docker's one-CPU share weight, not 1", () => {
    expect(DEFAULT_CPU_SHARES).toBe(1024);
  });

  it("keeps quoted arguments as one argv element", () => {
    expect(startToArgv(`node -e "console.log('hi')"`)).toEqual([
      "node",
      "-e",
      "console.log('hi')",
    ]);
    expect(startToArgv(`cmd "hello world" 'a b'`)).toEqual(["cmd", "hello world", "a b"]);
  });

  it("runtime deploy uses Entrypoint array (no /bin/sh -c) — source check", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const provider = readFileSync(
      join(root, "packages/runtime-docker/src/docker-provider.ts"),
      "utf8",
    );
    // File+line contract: Entrypoint: spec.start (array), not sh -c.
    expect(provider).toMatch(/Entrypoint:\s*spec\.start/);
    expect(provider).not.toMatch(/Entrypoint:\s*\[\s*['"]\/bin\/sh['"]/);
  });
});
