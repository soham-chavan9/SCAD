import { RootImageError, VolumeQuotaExceededError } from "@scad/runtime-docker";
import { describe, expect, it } from "vitest";
import { deployErrorEnvelope } from "./builder.js";

describe("deployErrorEnvelope (T1.3)", () => {
  it("maps an over-quota /data volume to LIMIT_EXCEEDED with a hint", () => {
    const env = deployErrorEnvelope(new VolumeQuotaExceededError(3 * 1048576, 1048576));
    expect(env).toMatchObject({
      code: "LIMIT_EXCEEDED",
      hint: expect.stringContaining("disk_gb"),
      details: { used_bytes: 3 * 1048576, limit_bytes: 1048576 },
    });
  });

  it("maps a root image to BUILD_FAILED with a USER hint (T2.2)", () => {
    expect(deployErrorEnvelope(new RootImageError("img:1", ""))).toMatchObject({
      code: "BUILD_FAILED",
      hint: expect.stringContaining("USER"),
    });
  });

  it("maps anything else to BUILD_FAILED", () => {
    expect(deployErrorEnvelope(new Error("boom"))).toMatchObject({ code: "BUILD_FAILED" });
  });
});
