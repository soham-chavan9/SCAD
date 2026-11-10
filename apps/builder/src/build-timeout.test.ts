import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFailureEnvelope } from "./builder.js";
import { BUILD_TIMEOUT_MS, dockerBuild } from "./docker-build.js";

/** T2.3: a build that runs past the 10-minute budget is killed and reported as BUILD_FAILED. */
describe("build timeout (T2.3)", () => {
  it("defaults to the AGENTS §14 budget of 10 minutes", () => {
    expect(BUILD_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it("passes the timeout to the docker CLI and reports a kill as timedOut", async () => {
    let seenTimeout: number | undefined;
    const result = await dockerBuild({
      contextDir: "/ctx",
      imageRef: "img:v1",
      timeoutMs: 1234,
      exec: async (_file, _args, options) => {
        seenTimeout = options.timeout;
        throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL", stdout: "#5 RUN sleep", stderr: "" });
      },
    });
    expect(seenTimeout).toBe(1234);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    if (!result.ok) expect(result.message).toMatch(/timed out/);
  });

  // The control plane adds details.log_tail (last 50 lines) when the builder reports a failure.
  it("maps a timed-out build to BUILD_FAILED with a timeout hint", () => {
    const log = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const env = buildFailureEnvelope({ ok: false, timedOut: true, message: "docker build timed out after 10 minutes", log });
    expect(env).toMatchObject({
      code: "BUILD_FAILED",
      message: expect.stringMatching(/timed out/),
      hint: expect.stringMatching(/10 minutes/),
    });
  });

  it("really stops a slow docker build (real Docker)", async () => {
    const ctx = await mkdtemp(join(tmpdir(), "scad-slow-build-"));
    try {
      await writeFile(join(ctx, "Dockerfile"), "FROM busybox:1.36\nRUN sleep 120\n");
      const started = Date.now();
      const result = await dockerBuild({ contextDir: ctx, imageRef: "scad-test/slow-build:1", timeoutMs: 3000 });
      expect(result).toMatchObject({ ok: false, timedOut: true });
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await rm(ctx, { recursive: true, force: true });
    }
  }, 60_000);
});
