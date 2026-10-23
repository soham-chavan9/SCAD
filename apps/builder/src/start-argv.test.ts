import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestStartToArgv } from "./start-argv.js";

describe("manifestStartToArgv", () => {
  it("returns a string[] argv (never a host-shell string)", () => {
    const argv = manifestStartToArgv("node server.js");
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).toEqual(["/bin/sh", "-c", "node server.js"]);
  });

  it("docker-provider passes start as Cmd array (source contract)", () => {
    const providerPath = join(
      fileURLToPath(new URL("../../../packages/runtime-docker/src/docker-provider.ts", import.meta.url)),
    );
    const src = readFileSync(providerPath, "utf8");
    // Must assign Cmd to the argv array — not interpolate into a host shell.
    expect(src).toMatch(/Cmd:\s*spec\.start/);
    expect(src).not.toMatch(/exec\([^)]*spec\.start/);
    expect(src).not.toMatch(/spawn\([^)]*shell:\s*true/);
    // Line reference for reviewers (T0.8 acceptance).
    const line = src.split("\n").findIndex((l) => /Cmd:\s*spec\.start/.test(l)) + 1;
    expect(line).toBeGreaterThan(0);
    expect(src.split("\n")[line - 1]).toContain("Cmd: spec.start");
  });
});
