import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startToArgv } from "./builder.js";

describe("manifest.start as argv", () => {
  it("splits start into argv without a shell", () => {
    expect(startToArgv("node server.js")).toEqual(["node", "server.js"]);
    expect(startToArgv("  python -m http.server  ")).toEqual([
      "python",
      "-m",
      "http.server",
    ]);
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
